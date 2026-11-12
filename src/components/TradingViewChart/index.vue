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
    // Saved indicators from the Indicator IDE, as `{indicatorId, name, params}`.
    // They are computed by the backend and replayed in the library; nothing is
    // evaluated in the browser.
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
      }
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
      this.indicatorError = failures.length
        ? failures.map(item => `${item.indicatorId}: ${item.reason}`).join('; ')
        : ''
      // Reported upwards as well: the page shows it beside the symbol, where the
      // user is looking, while the component keeps its own overlay for the case
      // where it is embedded without a host page to report to.
      this.$emit('indicator-error', this.indicatorError)
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
