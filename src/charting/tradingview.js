/**
 * TradingView Charting Library host component.
 *
 * The library is a vendored static bundle loaded from `public/charting_library/`
 * rather than an npm dependency: it ships no module entry the bundler can
 * resolve, and copying it into `public/` keeps the licence file next to the code
 * it covers.
 *
 * The datafeed behind it is ours (`src/charting/datafeed.js`), so every symbol
 * resolution, bar request and realtime push goes through the same backend the
 * rest of the app uses. The studies it draws are Pine scripts executed in this
 * browser by the runtime in `pineRuntime.js`; nothing about them is computed
 * server-side.
 */

import { createBarStore, createDatafeed, buildSymbolInfo } from './datafeed'

export { createBarStore }

const LIBRARY_PATH = '/charting_library/'
const SCRIPT_ATTR = 'data-tv-library'

/**
 * Load the vendored bundle once per document.
 *
 * Injecting a script tag rather than importing keeps the library out of the
 * module graph: it defines a `window.TradingView` global and expects to run as a
 * classic script, and a second copy on a route change would re-register its
 * custom elements.
 */
export function loadChartingLibrary () {
  if (window.TradingView && window.TradingView.widget) {
    return Promise.resolve(window.TradingView)
  }
  const existing = document.querySelector(`script[${SCRIPT_ATTR}]`)
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(window.TradingView))
      existing.addEventListener('error', () => reject(new Error('Charting Library failed to load')))
    })
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${LIBRARY_PATH}charting_library.standalone.js`
    script.async = true
    script.setAttribute(SCRIPT_ATTR, '1')
    script.onload = () => {
      if (window.TradingView && window.TradingView.widget) {
        resolve(window.TradingView)
      } else {
        reject(new Error('Charting Library loaded without exposing TradingView.widget'))
      }
    }
    script.onerror = () => reject(new Error(`Failed to load ${script.src}`))
    document.head.appendChild(script)
  })
}

/**
 * Build the widget options.
 *
 * Kept separate from mounting so the same configuration can be exercised in a
 * unit test without a DOM.
 */
export function buildWidgetOptions ({
  container,
  market = 'Crypto',
  symbol = 'BTC/USDT',
  exchangeId,
  marketType,
  instrumentId,
  timeframe = '1H',
  theme = 'dark',
  locale = 'zh',
  customIndicators = [],
  onRealtimeBar,
  onSymbolResolved,
  barStore = null
} = {}) {
  // `customIndicators` may be a ready array or a loader, because the studies
  // depend on bars the widget has not requested yet: loading them up front would
  // spend a preview request per study before the chart even knows its window.
  const loadIndicators = typeof customIndicators === 'function'
    ? customIndicators
    : () => Promise.resolve(customIndicators)
  const symbolInfo = buildSymbolInfo({
    symbol,
    market,
    exchangeId,
    marketType,
    instrumentId,
    timeframe
  })
  const datafeed = createDatafeed({
    market,
    symbol,
    exchangeId,
    marketType,
    instrumentId,
    timeframe,
    onRealtimeBar,
    onSymbolResolved,
    barStore
  })
  return {
    container,
    library_path: LIBRARY_PATH,
    locale,
    symbol: symbolInfo.ticker,
    interval: intervalFor(timeframe),
    datafeed,
    theme,
    autosize: true,
    // The library renders its own loading and error states; ours would flicker
    // on every symbol change, so they are suppressed.
    loading_screen: { backgroundColor: theme === 'dark' ? '#131722' : '#ffffff' },
    disabled_features: [
      'use_localstorage_for_settings',
      'show_symbol_logo_in_legend',
      'legend_inplace_edit'
    ],
    enabled_features: ['hide_left_toolbar_by_default'],
    overrides: {
      'paneProperties.background': theme === 'dark' ? '#131722' : '#ffffff',
      'paneProperties.backgroundType': 'solid'
    },
    custom_indicators_getter: loadIndicators
  }
}

/** Library intervals are minutes for intraday and literals for daily+. */
export function intervalFor (timeframe) {
  return {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1H': '60',
    '4H': '240',
    '1D': '1D',
    '1W': '1W'
  }[String(timeframe || '').trim()] || '60'
}

/**
 * Library series type for a chart type name.
 *
 * The IDE keeps naming chart types the way the bundled canvas named them; the
 * library exposes `SeriesType` numbers instead. Several canvas styles collapse
 * onto one library series (every candle variant is a candle, refined later by
 * overrides), and the two the library has no chart type for fall back to
 * candles rather than to a silently different picture.
 */
const CHART_SERIES_TYPES = {
  candle_solid: 1,
  candle_stroke: 1,
  candle_up_stroke: 1,
  candle_down_stroke: 1,
  ohlc: 0,
  line: 2,
  area: 3,
  hlc_area: 3,
  heikin_ashi: 8,
  renko: 4,
  range: 1
}

export function seriesTypeFor (chartType) {
  return CHART_SERIES_TYPES[String(chartType || '').trim()] || 1
}

/**
 * The IDE chart-type name for a library series type.
 *
 * The library's type picker reports the series it switched to, not which of the
 * IDE's names produced it: both `candle_solid` and `candle_stroke` are candles.
 * The IDE only needs a name that maps back to the same series on a rebuild, so
 * the canonical name is the right answer.
 */
const SERIES_TYPES_CHART = {
  0: 'ohlc',
  1: 'candle_solid',
  2: 'line',
  3: 'area',
  4: 'renko',
  8: 'heikin_ashi'
}

export function chartTypeForSeriesType (seriesType) {
  return SERIES_TYPES_CHART[Number(seriesType)] || ''
}

/**
 * Mount a widget and return a handle that can tear it down.
 *
 * Vue 2 has no `<script setup>` and no automatic unmount for foreign DOM, so the
 * caller has to be able to remove the widget and its listeners explicitly.
 * Without that, navigating away leaves the library's resize observer and
 * websocket bound to a detached node.
 */
export async function mountTradingViewChart (options) {
  const library = await loadChartingLibrary()
  // `widget` is a property on the library object, not a class binding, so the
  // lowercase name is the library's API rather than a style slip.
  // eslint-disable-next-line new-cap
  const widget = new library.widget(buildWidgetOptions(options))
  let destroyed = false
  return {
    widget,
    destroy () {
      if (destroyed) return
      destroyed = true
      try {
        widget.remove?.()
      } catch (err) {
        // The library throws if the container was already detached; nothing to
        // do about it and nothing to report.
        if (process.env.NODE_ENV !== 'production') {
          console.debug('Charting Library teardown threw', err)
        }
      }
    }
  }
}
