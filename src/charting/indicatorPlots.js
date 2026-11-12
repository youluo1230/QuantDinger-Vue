/**
 * Draw backend-computed indicator output on the Charting Library.
 *
 * The indicators the user saves in the Indicator IDE are Python: they run in the
 * backend sandbox and return `plots`/`signals` aligned to the bars they were
 * given. The library cannot run Python, and it will not accept a bare array of
 * numbers, so the output has to be replayed through its custom-indicator API:
 * a study whose `main` is called once per bar, returning the next precomputed
 * value each time.
 *
 * That is the whole design: `loadSeries` fetches the preview once, and the study
 * walks the already-computed array. Nothing is calculated in the browser.
 */

import request from '@/utils/request'

/**
 * Cache of computed series, keyed by what makes them different.
 *
 * Keyed on symbol and timeframe as well as the indicator: the same indicator on
 * a different pair produces different numbers, and replaying the wrong array
 * would draw a plausible but false line.
 */
export function seriesKey ({ indicatorId, market, symbol, timeframe }) {
  return `${indicatorId}|${market}|${symbol}|${timeframe}`
}

/**
 * Read the indicator id out of whatever the caller had on hand.
 *
 * The Indicator IDE labels its runtime blocks `ide-py-<id>` so two panes can hold
 * the same indicator without colliding, and it keeps the database id in
 * `originalId`. Taking `Number(item.id)` would give NaN for every one of them and
 * the chart would draw nothing while reporting no error.
 */
export function indicatorIdOf (item) {
  for (const candidate of [item?.indicatorId, item?.originalId, item?.id]) {
    const value = Number(candidate)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/**
 * Fetch one indicator's computed output for a chart window.
 *
 * Returns `{ plots, signals }` with each plot flattened to plain numbers, which
 * is what the study can replay. Plot objects that carry per-point colours keep
 * their colour arrays alongside, because the library colours a series per bar
 * and taking only the values would silently drop the author's intent.
 */
export async function loadSeries ({ indicatorId, market, symbol, timeframe, limit = 300, params = {} }) {
  const response = await request({
    url: '/api/indicator/chart-preview',
    method: 'post',
    data: {
      indicator_id: indicatorId,
      market,
      symbol,
      timeframe,
      limit,
      params
    },
    timeout: 60000
  })
  const payload = response?.data
  if (!payload) {
    throw new Error(response?.msg || 'Indicator preview returned nothing')
  }
  return {
    plots: normalizePlots(payload.plots),
    signals: Array.isArray(payload.signals) ? payload.signals : [],
    candleTimes: (payload.candles || []).map(bar => Number(bar?.time)).filter(Number.isFinite)
  }
}

/**
 * Turn backend plots into replayable series.
 *
 * A plot point is either a number or `{value, color, size}`; clouds carry
 * `upper`/`lower`. Every form is reduced to the numeric channel the study can
 * plot, and the parallel colour channel is kept where it exists.
 */
export function normalizePlots (plots) {
  if (!Array.isArray(plots)) return []
  const out = []
  for (const plot of plots) {
    if (!plot || typeof plot !== 'object') continue
    const name = String(plot.name || plot.title || '').trim()
    if (!name) continue
    // A cloud needs two channels; drawing only its midpoint would look like a
    // line and lose the band the author drew on purpose.
    if (isCloud(plot)) {
      out.push({ kind: 'cloud', name, upper: channel(plot, 'upper'), lower: channel(plot, 'lower') })
      continue
    }
    out.push({
      kind: String(plot.type || 'line') === 'bar' ? 'bar' : 'line',
      name,
      values: channel(plot, 'value'),
      colors: colourChannel(plot),
      overlay: plot.overlay !== false
    })
  }
  return out
}

function isCloud (plot) {
  const type = String(plot.type || '').toLowerCase()
  if (['cloud', 'band', 'fill_between', 'fill-between'].includes(type)) return true
  const first = Array.isArray(plot.data) ? plot.data.find(point => point && typeof point === 'object') : null
  return Boolean(first && ('upper' in first || 'top' in first))
}

function channel (plot, mode) {
  const data = Array.isArray(plot.data) ? plot.data : []
  return data.map((point) => {
    if (point == null) return null
    if (typeof point === 'number') return Number.isFinite(point) ? point : null
    if (typeof point !== 'object') return null
    const raw = mode === 'upper'
      ? (point.upper ?? point.top ?? point.high ?? point.value ?? point.y ?? point.data)
      : mode === 'lower'
        ? (point.lower ?? point.bottom ?? point.low)
        : (point.value ?? point.y ?? point.data)
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  })
}

function colourChannel (plot) {
  const data = Array.isArray(plot.data) ? plot.data : []
  const colors = data.map((point) => {
    if (!point || typeof point !== 'object') return null
    return point.color || point.fillColor || point.backgroundColor || null
  })
  return colors.some(Boolean) ? colors : null
}

/**
 * Build the study descriptor the library expects from `custom_indicators_getter`.
 *
 * The custom-study contract is one `main` call per bar, in order, whose return
 * value is the plot values for that bar. So the study is a cursor over an array
 * that the backend already computed -- nothing is evaluated in the browser.
 *
 * The counter lives on the study prototype rather than on the instance because
 * the library creates the instance once per calculation run: `init` is what it
 * calls when a run starts, and resetting there is what makes a recalculation
 * replay from the first bar instead of continuing where the last run stopped.
 */
export function buildCustomIndicator ({ indicatorId, name, series, key }) {
  const label = String(name || `Indicator ${indicatorId}`)
  const primary = series.find(plot => plot.overlay) || series[0]
  const overlaysPrice = Boolean(primary && primary.overlay !== false)
  // The library sizes its plot table from metainfo, so a cloud contributes two
  // entries: its upper edge and its lower edge are separate plots to it.
  const plotSpecs = []
  for (const plot of series) {
    if (plot.kind === 'cloud') {
      plotSpecs.push({ name: `${plot.name} upper`, values: plot.upper })
      plotSpecs.push({ name: `${plot.name} lower`, values: plot.lower })
      continue
    }
    plotSpecs.push({ name: plot.name, values: plot.values })
  }

  const metainfo = {
    id: `qd_indicator_${indicatorId}`,
    name: label,
    description: label,
    shortDescription: label,
    // A study with a price overlay lives on the price pane; anything else gets
    // its own, which is what the pane placement in the indicator output means.
    overlay: overlaysPrice,
    is_price_study: overlaysPrice,
    plots: plotSpecs.map((_plot, index) => ({
      id: `plot_${index}`,
      type: 'line'
    })),
    defaults: { styles: {} },
    inputs: []
  }

  function Study () {}
  // `init` runs at the start of every calculation, and the library passes a
  // fresh context each time. Clearing the cursor here is the difference between
  // a correct replay and one that starts halfway through the series.
  Study.prototype.init = function () {
    this.__qdIndex = 0
  }
  Study.prototype.main = function () {
    const index = this.__qdIndex || 0
    this.__qdIndex = index + 1
    // A gap must stay a gap: NaN is the library's "no value here", whereas
    // carrying the previous value forward would invent data.
    return plotSpecs.map((plot) => {
      const value = Array.isArray(plot.values) ? plot.values[index] : null
      return Number.isFinite(value) ? value : NaN
    })
  }

  return {
    key,
    name: label,
    metainfo,
    // The library applies `new` to this function, so it must stay a function
    // rather than an arrow.
    constructor: Study,
    series
  }
}

/**
 * Resolve a set of custom indicators for a chart, loading what is missing.
 *
 * Called from `custom_indicators_getter`, which must return a promise; the
 * library waits for it before drawing, so a slow preview delays the study
 * instead of drawing a half-filled line.
 */
export async function resolveCustomIndicators ({ indicators, market, symbol, timeframe, cache }) {
  const built = []
  const failures = []
  for (const indicator of indicators || []) {
    const indicatorId = indicatorIdOf(indicator)
    if (!indicatorId) continue
    const key = seriesKey({ indicatorId, market, symbol, timeframe })
    let series = cache.get(key)
    if (!series) {
      try {
        const loaded = await loadSeries({
          indicatorId,
          market,
          symbol,
          timeframe,
          limit: indicator.limit || 300,
          params: indicator.params || {}
        })
        series = loaded.plots
      } catch (err) {
        // One indicator that fails to compute -- a runtime error in its Python,
        // or a symbol it has no data for -- must not take the chart down with
        // it. The library draws the bars and simply omits this study.
        failures.push({ indicatorId, reason: err?.message || String(err) })
        continue
      }
      cache.set(key, series)
    }
    if (!series || !series.length) continue
    built.push(buildCustomIndicator({
      indicatorId,
      name: indicator.name || indicator.display_name || indicator.title,
      series,
      key
    }))
  }
  return { indicators: built, failures }
}

/** Minimal in-memory cache; the browser tab is the lifetime that matters. */
export function createSeriesCache () {
  const store = new Map()
  return {
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
    clear: () => store.clear(),
    get size () {
      return store.size
    }
  }
}
