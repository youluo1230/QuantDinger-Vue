/**
 * Draw backend-computed indicator output on the Charting Library.
 *
 * The indicators the user saves in the Indicator IDE are Python: they run in the
 * backend sandbox and return `plots`/`signals` aligned to the bars they were
 * given. The library cannot run Python, and it will not accept a bare array of
 * numbers, so the output has to be replayed through its custom-indicator API:
 * a study whose `main` is called once per bar, returning the precomputed value
 * for that bar.
 *
 * That is the whole design: `loadSeries` fetches the preview once and the study
 * looks each bar up by its time. Nothing is calculated in the browser.
 *
 * Replaying by ordinal position cannot work. The library appends live bars and
 * prepends older ones while the same study instance keeps being called, so a
 * self-incrementing cursor drifts: one extra call at the end of the array makes
 * `main` index past it, and a scroll-back replays the fetched window against a
 * bar sequence that no longer starts where the cursor does. Bar time is the only
 * stable key, and the library does hand it over -- see `barTimeCandidates` and
 * `buildBarTimeIndex`.
 */

import request from '@/utils/request'

/** Milliseconds in a UTC day; the bucket a daily-or-larger bar is keyed by. */
const MS_PER_DAY = 86400000

/**
 * Spacing at or above this means the series is daily-or-larger, not intraday.
 *
 * Twenty hours keeps every intraday timeframe the chart offers (the largest is
 * 240 minutes) well below the line, while a daily series lands far above it.
 */
const DAILY_MIN_SPACING_MS = 20 * 60 * 60 * 1000

/**
 * Bar time in milliseconds, whatever width the producer sent.
 *
 * The backend stores bar times in seconds, the library works in milliseconds,
 * and historical payloads have arrived in both widths. Dividing by the epoch
 * magnitude is what `datafeed.js` does for the same reason; it is duplicated
 * here rather than imported so this module stays free of the datafeed's own
 * imports (`@/utils/request` and the Vite alias table).
 */
export function barTimeMs (value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return numeric > 1e11 ? Math.floor(numeric) : Math.floor(numeric * 1000)
}

/**
 * Precomputed plot values indexed by the bar time they belong to.
 *
 * Replay has to be keyed on time because the library gives the study no stable
 * ordinal. It appends live bars and prepends older ones while calling the same
 * study, and `symbol.index` is only a position in the currently loaded window,
 * so a self-incrementing cursor drifts the moment either happens. Bar time is
 * the one identifier that survives both.
 *
 * `candleTimes` is aligned 1:1 with the plot arrays `loadSeries` returned, which
 * is the only reason the values can be matched to bars at all; the entries are
 * sorted for lookup but the original positions are preserved when reading the
 * values, so reordering the input cannot mislabel a bar.
 *
 * For a daily-or-larger series a second index buckets bars by UTC day. The
 * library realigns DWM bar times to the session start (`createDwmAligner`,
 * `_alignBarsTime` in library.f615dbeaa9fac48853ce.js:774-775), so the time it
 * reports for a daily bar can be a session open rather than the raw open time
 * the backend returned; the day bucket still identifies the same bar. It cannot
 * invent a value: a bar on a day the backend never computed has no bucket, so
 * it stays a gap.
 */
export function buildBarTimeIndex ({ plotSpecs, candleTimes }) {
  const specs = Array.isArray(plotSpecs) ? plotSpecs : []
  const raw = Array.isArray(candleTimes) ? candleTimes : []
  const pairs = []
  for (let position = 0; position < raw.length; position += 1) {
    const time = barTimeMs(raw[position])
    if (time != null) pairs.push({ time, position })
  }
  pairs.sort((a, b) => a.time - b.time)

  let smallestSpacing = Number.POSITIVE_INFINITY
  for (let index = 1; index < pairs.length; index += 1) {
    const spacing = pairs[index].time - pairs[index - 1].time
    if (spacing > 0 && spacing < smallestSpacing) smallestSpacing = spacing
  }
  const daily = Number.isFinite(smallestSpacing) && smallestSpacing >= DAILY_MIN_SPACING_MS

  const byTime = new Map()
  for (const pair of pairs) {
    // A repeated bar time is one bar; the first occurrence owns the slot, so a
    // duplicate cannot overwrite an already-correct value.
    if (byTime.has(pair.time)) continue
    byTime.set(pair.time, specs.map(spec => plotValueAt(spec, pair.position)))
  }

  const byDay = new Map()
  if (daily) {
    for (const [time, values] of byTime) {
      const day = Math.floor(time / MS_PER_DAY)
      if (!byDay.has(day)) byDay.set(day, values)
    }
  }

  return {
    size: byTime.size,
    daily,
    /** Values for one bar, or `null` when this bar has no precomputed output. */
    at (time) {
      if (byTime.size === 0 || !Number.isFinite(time)) return null
      const exact = byTime.get(time)
      if (exact) return exact
      if (!daily) return null
      return byDay.get(Math.floor(time / MS_PER_DAY)) || null
    }
  }
}

/** One plot's value at a bar position, with anything missing reduced to a gap. */
function plotValueAt (spec, position) {
  const values = Array.isArray(spec?.values) ? spec.values : []
  const value = values[position]
  return Number.isFinite(value) ? value : NaN
}

/**
 * The bar times the library is currently asking about, in milliseconds.
 *
 * The published `IContext` advertises only `setMinimumAdditionalDepth`
 * (charting_library.d.ts:12431-12482), but the object handed to `main` is the
 * library's own context (`class Pv`, library.f615dbeaa9fac48853ce.js:776), and
 * it holds the current symbol instrument as a plain property -- documented as
 * `IContext.symbol` (charting_library.d.ts:12435). That instrument exposes both
 * `time` (the running bar's time in milliseconds, d.ts:14578) and `bartime()`
 * (d.ts:14614), and the library writes them from its bar loop immediately
 * before calling `main` (`lastbar`, bundle:775; `Mv.calc`, bundle:777). So the
 * bar time is reachable even though `IContext` does not mention a getter.
 *
 * Both are offered because for daily-or-larger bars they can differ: `time` is
 * the bar's internal time (session-start aligned) while `bartime()` corrects it
 * to the trading day, and the backend's raw candle time is the trading day.
 * Returning every candidate and matching any of them means the lookup does not
 * have to bet on which convention the library picked.
 *
 * `bartime()` is called defensively: it does real calendar work for DWM series
 * and can throw if the instrument's session data is not set up yet -- which is
 * exactly the state during the construction call, where `symbol.time` is also
 * NaN and no bar exists.
 */
export function barTimeCandidates (ctx) {
  const symbol = ctx && ctx.symbol
  const out = []
  if (!symbol) return out
  const direct = Number(symbol.time)
  if (Number.isFinite(direct)) out.push(direct)
  if (typeof symbol.bartime === 'function') {
    try {
      const viaMethod = Number(symbol.bartime())
      if (Number.isFinite(viaMethod) && !out.includes(viaMethod)) out.push(viaMethod)
    } catch (err) {
      // A bar time we cannot compute is a bar we cannot look up; it becomes a
      // gap rather than taking the whole study down.
    }
  }
  return out
}

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
    // Normalised to milliseconds here, at the boundary, so everything downstream
    // speaks the library's unit. The API sends seconds (the preview route
    // divides by 1000 before serialising), and a cache entry that kept them
    // would be indistinguishable from one that did not.
    candleTimes: (payload.candles || []).map(bar => barTimeMs(bar?.time)).filter(time => time != null)
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
 * The custom-study contract is one `main` call per bar whose return value is the
 * plot values for that bar -- nothing is evaluated in the browser. `main` is
 * therefore a lookup, not a replay: it asks the library which bar it is being
 * called for and returns the precomputed row for that bar's time.
 *
 * Replaying by position is what used to be here, and it is wrong for three
 * distinct reasons, all of which this shape avoids:
 *
 * 1. The library calls `main` once at construction, before any bar is loaded
 *    (`Mv.init` runs `init` and `main` back to back, bundle:777). A cursor spent
 *    that call on the first precomputed value, so bar one was drawn with bar
 *    two's number, and every bar after it was off by one.
 * 2. A live bar appended by the socket is one more `main` call than there were
 *    precomputed values; a cursor walked past the end and produced undefined,
 *    which the library reads as a break in the line.
 * 3. Scrolling back recalculates the study against a window that starts at an
 *    older bar. The cursor restarts at zero, so the fetched values were drawn
 *    against the wrong bars -- a shifted line that looks plausible and is false.
 *
 * A bar with no precomputed value returns `NaN` -- the library's "no value
 * here". That is a gap on purpose: the backend computed a fixed window, so bars
 * outside it (older than the request, or newer than its last candle) genuinely
 * have no output, and carrying a neighbour's value forward would invent data.
 */
export function buildCustomIndicator ({ indicatorId, name, series, key, candleTimes }) {
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

  // Built once, not per `init`: the precomputed output never changes, so the
  // lookup is immutable. That is also why there is no `init` below.
  const barIndex = buildBarTimeIndex({ plotSpecs, candleTimes })
  const gapRow = plotSpecs.map(() => NaN)

  function Study () {}
  /**
   * Deliberately no `init`.
   *
   * The old cursor needed `init` to reset itself; a time-keyed lookup has no
   * position to reset, so a recalculation against a different window returns
   * the same values for the same bars without any state being carried. `init`
   * is optional in the contract (`init?` at charting_library.d.ts:15594), so
   * leaving it out is the honest way to say "there is nothing to restart".
   */
  Study.prototype.main = function (ctx) {
    // The library also calls `main` once while constructing the study, before
    // any bar exists, and once per bar after that (bundle:777). No bar means no
    // candidate time at all; `_processResult` discards the row anyway, but
    // returning a gap keeps `main` honest in both cases and, unlike the old
    // cursor, does not spend a precomputed value on that call.
    for (const candidate of barTimeCandidates(ctx)) {
      const row = barIndex.at(candidate)
      // Copied because the library keeps the array it is handed; the indexed
      // rows are shared and must not become a channel for caller mutations.
      if (row) return row.slice()
    }
    // A gap must stay a gap: NaN is the library's "no value here", and it is
    // returned only when the backend really has no value for this bar's time --
    // an explicit hole in its output, or a bar outside the window it computed.
    // It is never the result of walking off the end of an array.
    return gapRow.slice()
  }

  return {
    key,
    name: label,
    metainfo,
    // The library applies `new` to this function, so it must stay a function
    // rather than an arrow.
    constructor: Study,
    series,
    barIndex
  }
}

/**
 * Resolve a set of custom indicators for a chart, loading what is missing.
 *
 * Called from `custom_indicators_getter`, which must return a promise; the
 * library waits for it before drawing, so a slow preview delays the study
 * instead of drawing a half-filled line.
 *
 * The bar times the preview was computed against are cached alongside the plots
 * and handed to every study built from them. Without them the plots are just an
 * ordered list with no way back to the bars they belong to; see
 * `buildBarTimeIndex`.
 */
export async function resolveCustomIndicators ({ indicators, market, symbol, timeframe, cache }) {
  const built = []
  const failures = []
  for (const indicator of indicators || []) {
    const indicatorId = indicatorIdOf(indicator)
    if (!indicatorId) continue
    const key = seriesKey({ indicatorId, market, symbol, timeframe })
    let loaded = cache.get(key)
    // Tolerate a bare plot array so a cache seeded elsewhere still works; it
    // simply has no bar times, and every bar would come out as a gap.
    if (Array.isArray(loaded)) loaded = { plots: loaded, candleTimes: [] }
    if (!loaded) {
      try {
        loaded = await loadSeries({
          indicatorId,
          market,
          symbol,
          timeframe,
          limit: indicator.limit || 300,
          params: indicator.params || {}
        })
      } catch (err) {
        // One indicator that fails to compute -- a runtime error in its Python,
        // or a symbol it has no data for -- must not take the chart down with
        // it. The library draws the bars and simply omits this study.
        failures.push({ indicatorId, reason: err?.message || String(err) })
        continue
      }
      cache.set(key, loaded)
    }
    const series = loaded?.plots
    if (!series || !series.length) continue
    built.push(buildCustomIndicator({
      indicatorId,
      name: indicator.name || indicator.display_name || indicator.title,
      series,
      candleTimes: loaded?.candleTimes,
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
