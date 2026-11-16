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
 * This is the only chart the Indicator IDE draws on. It owns no data of its own:
 * the datafeed in `charting/datafeed.js` answers every bar request from the
 * market-data API, and indicators are executed in this process by PineTS -- see
 * `indicatorPlots.js`. Nothing about a study travels over the network, which is
 * why a study can be redrawn as often as the author saves.
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
    // Indicators to draw, as `{indicatorId, name, params, code}`. Each carries
    // its Pine source, which this component executes in the browser. `code` may
    // hold an unsaved draft so the editor can show what the author is typing
    // rather than the last saved version.
    indicators: { type: Array, default: () => [] },
    candleType: { type: String, default: 'candle_solid' },
    // Entry levels of the quick-trade positions, as `{side, size, entryPrice,
    // costLabel, entryLabel}`. Drawn as price lines because a horizontal level
    // is what the trader reads; the bundled canvas drew them as overlays.
    quickTradePositions: { type: Array, default: () => [] }
  },
  data () {
    return {
      handle: null,
      error: '',
      indicatorError: '',
      seriesCache: createSeriesCache(),
      positionLines: [],
      // The IDE resizes the mounted chart after a fullscreen change by calling
      // `chartRef.resize()`, a shape it inherited from the bundled canvas. The
      // library resizes itself from its container, so this is the smallest
      // object that keeps that call honest instead of throwing.
      chartRef: {
        resize: () => {
          window.dispatchEvent(new Event('resize'))
        }
      }
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
    },
    quickTradePositions: {
      deep: true,
      handler () {
        this.drawPositionLines()
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
          customIndicators: () => this.loadIndicators(),
          // The quick-trade panel prefills its price from the chart's last
          // trade. The bundled canvas emitted this; without it the panel would
          // keep whatever price it last saw, which is worse than a stale label
          // because it is the number an order gets submitted at.
          onRealtimeBar: ({ bar }) => {
            const close = Number(bar?.close)
            if (Number.isFinite(close) && close > 0) this.$emit('price-change', close)
          }
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
        this.drawPositionLines()
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
    /**
     * Redraw after the study set changed.
     *
     * `indicators` is watched, so this is normally automatic; the method exists
     * because the IDE calls `updateIndicators()` on whatever chart it mounted
     * and a silent no-op would leave a stale study on screen.
     */
    async updateIndicators () {
      await this.reconcileStudies()
    },
    /**
     * A canvas snapshot for the marketplace preview.
     *
     * The library has the screenshot; our caller used to get one from the
     * bundled canvas. Returning a data URL keeps the publish path unchanged.
     */
    async captureMarketPreview (options = {}) {
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.takeClientScreenshot !== 'function') return ''
      try {
        const canvas = await chart.takeClientScreenshot({
          // The library's own watermark is already part of the picture; asking
          // for it twice would stamp the preview twice.
          hideResolution: false
        })
        if (!canvas) return ''
        const target = document.createElement('canvas')
        const width = Math.max(640, Number(options.width) || canvas.width)
        const height = Math.max(360, Number(options.height) || canvas.height)
        target.width = width
        target.height = height
        const context = target.getContext('2d')
        if (!context) return ''
        // Letterbox rather than stretch: a squashed chart misreads the pattern
        // the preview is meant to show.
        const scale = Math.min(width / canvas.width, height / canvas.height)
        const drawWidth = canvas.width * scale
        const drawHeight = canvas.height * scale
        context.fillStyle = this.theme === 'dark' ? '#131722' : '#ffffff'
        context.fillRect(0, 0, width, height)
        context.drawImage(canvas, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
        return target.toDataURL('image/png')
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('takeClientScreenshot failed', err)
        }
        return ''
      }
    },
    /**
     * Draw the entry level of each open position.
     *
     * A trader reads the entry as a horizontal level against the live price, so
     * a price line is the honest drawing; the previous renderer drew it as an
     * overlay with a label, which is the same information on a different
     * primitive. Lines are removed before being redrawn because the library has
     * no "update this line" call.
     */
    drawPositionLines () {
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.createOrderLine !== 'function') return
      for (const line of this.positionLines) {
        try {
          line.remove()
        } catch (_error) {
          // A line whose chart went away is already gone.
        }
      }
      this.positionLines = []
      const positions = Array.isArray(this.quickTradePositions) ? this.quickTradePositions : []
      for (const position of positions) {
        const price = Number(position?.entryPrice)
        if (!Number.isFinite(price) || price <= 0) continue
        const side = position?.side === 'short' ? 'short' : 'long'
        const colour = side === 'short' ? '#f04438' : '#12b76a'
        // Deliberately not awaited in order: each line is independent, and
        // awaiting them serially would make a five-position account pay five
        // round trips before the last line appears.
        Promise.resolve(chart.createOrderLine())
          .then((line) => {
            if (!line) return
            line.setPrice(price)
            line.setLineStyle(2)
            line.setLineColor(colour)
            line.setText(`${String(position?.costLabel || '')} ${side === 'short' ? '▼' : '▲'}`.trim())
            line.setQuantity('')
            line.setEditable(false)
            this.positionLines.push(line)
          })
          .catch((error) => {
            if (process.env.NODE_ENV !== 'production') {
              console.debug('createOrderLine failed', error)
            }
          })
      }
    },
    teardown () {
      if (!this.handle) return
      this.positionLines = []
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
