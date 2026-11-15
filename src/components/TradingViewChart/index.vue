<template>
  <div class="tv-chart" :class="`tv-chart--${theme}`">
    <div ref="chartHost" class="tv-chart__host" />
    <div v-if="error" class="tv-chart__error">{{ error }}</div>
    <div v-else-if="indicatorError" class="tv-chart__warning">{{ indicatorError }}</div>
  </div>
</template>

<script>
import { mountTradingViewChart } from '@/charting/tradingview'
import { createSeriesCache, resolveCustomIndicators } from '@/charting/indicatorPlots'

/**
 * TradingView Charting Library surface.
 *
 * This replaces the klinecharts view where the widget is expected to behave like
 * TradingView (drawing tools, saved layouts, indicators drawn by our backend).
 * It owns no data of its own: the datafeed in `charting/datafeed.js` answers
 * every bar request from the market-data API, and indicators arrive as plots
 * from `/api/indicator/chart-preview`.
 */
export default {
  name: 'TradingViewChart',
  props: {
    market: { type: String, default: 'Crypto' },
    symbol: { type: String, required: true },
    exchangeId: { type: String, default: '' },
    marketType: { type: String, default: '' },
    instrumentId: { type: String, default: '' },
    timeframe: { type: String, default: '1H' },
    theme: { type: String, default: 'dark' },
    locale: { type: String, default: 'zh' },
    // Indicators to draw, as `{indicatorId, name, params, code}`. They are
    // computed by the backend and replayed in the library; nothing is evaluated
    // in the browser. `code` carries an unsaved draft so the editor can show
    // what the author is typing rather than the last saved version.
    indicators: { type: Array, default: () => [] }
  },
  data () {
    return {
      handle: null,
      error: '',
      indicatorError: '',
      seriesCache: createSeriesCache()
    }
  },
  watch: {
    symbol () {
      // The library has no public "change symbol" call that keeps its own
      // state coherent, so the mounted widget is replaced wholesale.
      this.remount()
    },
    timeframe () {
      this.remount()
    },
    theme () {
      this.remount()
    },
    indicators: {
      // A changed set is rebuilt rather than patched: the getter is consulted
      // once at mount, so a study that was not registered then cannot be drawn
      // later. The rebuild restores the visible range so it does not read as a
      // reload -- see `reconcileStudies`.
      deep: true,
      handler () {
        this.reconcileStudies()
      }
    }
  },
  mounted () {
    this.mount()
  },
  beforeDestroy () {
    this.teardown()
  },
  methods: {
    async mount () {
      if (this.handle) return
      this.error = ''
      try {
        this.handle = await mountTradingViewChart({
          container: this.$refs.chartHost,
          market: this.market,
          symbol: this.symbol,
          exchangeId: this.exchangeId,
          marketType: this.marketType,
          instrumentId: this.instrumentId,
          timeframe: this.timeframe,
          theme: this.theme,
          locale: this.locale,
          customIndicators: () => this.loadIndicators()
        })
      } catch (err) {
        // A missing vendored bundle must not take the page down with it; the
        // message is what an operator needs to see.
        this.error = err?.message || String(err)
        return
      }
      // The registry is populated by the getter above, but nothing is drawn
      // until the chart exists. `onChartReady` is the point at which
      // `createStudy` stops resolving to null; drawing earlier is a silent
      // no-op, which is exactly how the studies went missing before.
      this.handle.widget.onChartReady?.(() => {
        this.drawStudies()
      })
    },
    /**
     * Bring the drawn studies in line with the checked set.
     *
     * Two facts about the library shape this:
     *
     * 1. `custom_indicators_getter` only *registers* studies -- the bundle pushes
     *    each definition into `studyLibrary` and stops there. Registering an
     *    indicator does not draw it; `createStudy` does. Earlier versions of this
     *    component registered and never drew, which is why checking a box changed
     *    nothing on the chart.
     * 2. The getter is asked once, when the widget is built. A study that was not
     *    registered then cannot be created later -- `createStudy` resolves to
     *    null for an unknown name.
     *
     * So a changed set means a rebuilt widget, and the job here is to make that
     * rebuild invisible: keep the visible time range and re-draw afterwards.
     * Rebuilding is also unavoidable for a changed draft, whose numbers are
     * different and which no call can swap in place.
     */
    async reconcileStudies () {
      if (!this.handle) return
      const viewport = this.captureViewport()
      this.seriesCache.clear()
      await this.remount()
      this.restoreViewport(viewport)
    },
    /** The visible time range, or null when it cannot be read. */
    captureViewport () {
      try {
        const range = this.handle?.widget?.activeChart?.()?.getVisibleRange?.()
        if (range && range.from && range.to) {
          return { from: range.from, to: range.to }
        }
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('getVisibleRange failed', err)
        }
      }
      return null
    },
    /**
     * Put the chart back where the user left it.
     *
     * Called after a rebuild so a checkbox toggle does not read as "the chart
     * reloaded": the bars come back in the same place, and only the study list
     * changes. A failure here leaves the default view, which is cosmetic — the
     * study set is what the user asked for.
     */
    restoreViewport (viewport) {
      if (!viewport) return
      try {
        this.handle?.widget?.activeChart?.()?.setVisibleRange?.(viewport)
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('setVisibleRange failed', err)
        }
      }
    },
    /**
     * Draw the studies whose definitions were registered at mount.
     *
     * Registered is not drawn: `custom_indicators_getter` fills the library's
     * study registry, and `createStudy` is what puts one on the chart. Both
     * steps are needed and only the first was happening.
     */
    async drawStudies () {
      if (!this.indicators.length) return
      const { indicators, failures } = await resolveCustomIndicators({
        indicators: this.indicators,
        market: this.market,
        symbol: this.symbol,
        timeframe: this.timeframe,
        cache: this.seriesCache
      })
      this.reportFailures(failures)
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart) return
      for (const study of indicators) {
        try {
          // Overlay placement comes from the study's own metainfo; forcing the
          // overlay flag here would fight the indicator author's intent.
          // eslint-disable-next-line no-await-in-loop
          await chart.createStudy(study.name, study.metainfo.overlay === true, false, {})
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('createStudy failed', study.name, err)
          }
        }
      }
    },
    reportFailures (failures) {
      const list = Array.isArray(failures) ? failures : []
      this.indicatorError = list.length
        ? list.map(item => `${item.indicatorId}: ${item.reason}`).join('; ')
        : ''
      this.$emit('indicator-error', this.indicatorError)
    },
    /**
     * Resolve the studies the chart should draw.
     *
     * A failed indicator is reported through `indicatorError` and skipped: the
     * chart is still correct without it, whereas an exception here would leave
     * the user with an empty pane and no explanation.
     */
    async loadIndicators () {
      if (!this.indicators.length) return []
      const { indicators, failures } = await resolveCustomIndicators({
        indicators: this.indicators,
        market: this.market,
        symbol: this.symbol,
        timeframe: this.timeframe,
        cache: this.seriesCache
      })
      this.reportFailures(failures)
      // Registered here, drawn by `drawStudies` once the widget reports ready.
      // The library only takes the registry from this getter; it never puts a
      // study on the chart by itself.
      return indicators
    },
    teardown () {
      if (!this.handle) return
      try {
        this.handle.destroy()
      } finally {
        this.handle = null
      }
    },
    async remount () {
      this.teardown()
      await this.mount()
    }
  }
}
</script>

<style lang="less" scoped>
.tv-chart {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;

  &__host {
    width: 100%;
    height: 100%;
  }

  &__warning {
    position: absolute;
    right: 8px;
    bottom: 8px;
    max-width: 60%;
    padding: 4px 8px;
    font-size: 12px;
    color: #d48806;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 4px;
  }

  &__error {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-size: 13px;
    text-align: center;
    color: #ff7875;
    background: rgba(0, 0, 0, 0.35);
  }
}
</style>
