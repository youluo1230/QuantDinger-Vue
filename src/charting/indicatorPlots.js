/**
 * Draw Pine indicator output on the Charting Library.
 *
 * The indicators the user saves in the Indicator IDE are Pine Script, and the
 * script itself is what the frontend holds: the runtime evaluates it in this
 * process and the resulting series are handed to the library's custom-indicator
 * API. The library cannot run Pine and will not accept a bare array of numbers,
 * so a study's `main` is called once per bar and returns the value computed for
 * that bar's time.
 *
 * Two halves, deliberately separated:
 *
 * 1. `pineRuntime.js` runs the script over the chart's own bars and returns
 *    drawable plots. That is where all the arithmetic happens.
 * 2. This module indexes those plots by bar time and replays them through the
 *    study contract.
 *
 * Replaying by ordinal position cannot work. The library appends live bars and
 * prepends older ones while the same study instance keeps being called, so a
 * self-incrementing cursor drifts: one extra call at the end of the array makes
 * `main` index past it, and a scroll-back replays the computed window against a
 * bar sequence that no longer starts where the cursor does. Bar time is the only
 * stable key, and the library does hand it over -- see `barTimeCandidates` and
 * `buildBarTimeIndex`.
 */

import request from '@/utils/request'
import {
  DEFAULT_STUDY_BARS,
  MAX_STUDY_BARS,
  runPineStudy,
  toPineBar
} from './pineRuntime'
import { parsePineInputSpecs } from './pineInputs'

/**
 * Timeframe name -> the period token PineTS expects.
 *
 * Pine scripts branch on `timeframe.period` and on `timeframe.in_seconds()`, so
 * this must be the venue's own vocabulary rather than an arbitrary label. The
 * same table exists in `datafeed.js` for the bar endpoint; it is repeated here
 * because the two answer different questions (which bars to fetch, versus which
 * period to declare to the script) and a shared constant would invite someone
 * to "fix" one and change the other.
 */
const PINE_INTERVALS = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1H': '60',
  '4H': '240',
  '1D': '1D',
  '1W': '1W'
}

/**
 * The period token for a timeframe, defaulting to the raw value.
 *
 * A timeframe the table does not name is passed through unchanged: an
 * unsupported period is the script's business to complain about, and inventing
 * one here would hide its error message.
 */
/**
 * The periods this deployment stores candles for.
 *
 * Kept next to the Pine translation rather than derived from it: the chart's own
 * timeframes and the periods a script may name are different sets, and the second
 * one includes periods no venue here indexes (`1M`, `3M`).
 */
const SERVICEABLE_TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W'])

export function pineIntervalFor (timeframe) {
  const raw = String(timeframe || '').trim()
  return PINE_INTERVALS[raw] || raw || '1'
}

/**
 * Pine's own period spelling, and the same period in the endpoint's vocabulary.
 *
 * These are the tokens a script writes directly -- `request.security(tickerid, "D",
 * ...)`. Monthly is included because scripts do ask for it, and the two entries
 * that the endpoint cannot serve are still named here: the provider degrades a
 * period it cannot fetch to no bars rather than failing the study, so an
 * unsupported month only blanks the lines that read it.
 */
const PINE_PERIOD_TOKENS = {
  D: '1D',
  W: '1W',
  M: '1M',
  '3M': '3M'
}

/**
 * The reverse of {@link pineIntervalFor}: a Pine period token back to the
 * vocabulary the bar endpoint expects.
 *
 * `request.security` names its timeframe the Pine way (`"60"`, `"1D"`), and the
 * candles endpoint does not know those tokens, so a script reading another
 * timeframe would otherwise ask for bars it never receives and draw `na`.
 * A token the table does not name is passed through and left for the endpoint
 * to reject -- with its own message, which is the useful one.
 */
export function timeframeForPineInterval (interval) {
  const raw = String(interval || '').trim()
  if (!raw) return ''
  for (const [timeframe, token] of Object.entries(PINE_INTERVALS)) {
    if (token === raw) return timeframe
  }
  // Pine spells day/week/month as a bare letter, and the endpoint spells them with
  // a leading count. Without this a study that reads the daily timeframe asked for
  // `timeframe=D` and the whole study failed on `unsupportedTimeframe` -- the
  // library was never the problem, the period token was.
  const bare = PINE_PERIOD_TOKENS[raw.toUpperCase()]
  return bare || raw
}

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
    // Flattened: a candle plot answers with four values, so a spec cannot be
    // assumed to contribute exactly one entry to the row `main` must return.
    byTime.set(pair.time, specs.flatMap(spec => [].concat(plotValueAt(spec, pair.position))))
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

/**
 * One plot's output at a bar position, with anything missing reduced to a gap.
 *
 * A candle plot is declared to the library as four separate plots, and each of
 * them is read here through the side it was declared for, so the value that
 * reaches a plot is the price that plot asked for rather than the whole candle.
 */
function plotValueAt (spec, position) {
  if (spec && spec.candle) {
    const candle = Array.isArray(spec.candle) ? spec.candle[position] : null
    if (!candle) return NaN
    const price = candle[spec.side === 'ohlc_high' ? 'high' : spec.side === 'ohlc_low' ? 'low' : spec.side === 'ohlc_close' ? 'close' : 'open']
    const value = Number(price)
    return Number.isFinite(value) ? value : NaN
  }
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
export function seriesKey ({ indicatorId, market, symbol, timeframe, revision = '', params = '' }) {
  // `revision` separates an unsaved draft from the saved row behind the same
  // id. Without it the first preview of a draft would be cached under the
  // stored indicator's key and the editor would keep painting stale output.
  // `params` belongs in the key for the same reason `revision` does: changing a
  // length input produces a different line from the same script, so a cached
  // plot computed with the old value must not be served for the new one.
  return `${indicatorId}|${market}|${symbol}|${timeframe}|${revision}|${params}`
}

/**
 * A stable fingerprint of the input values a study runs with.
 *
 * Sorted by key so two maps with the same entries agree, and prefixed per pair
 * so values cannot run into each other and make two different settings look
 * alike.
 */
export function paramsFingerprint (params) {
  if (!params || typeof params !== 'object') return ''
  return Object.keys(params)
    .sort()
    .map(key => `${key}=${String(params[key])}`)
    .join(',')
}

/**
 * Short, stable fingerprint for a draft script.
 *
 * Two edits an author made are two different programs and must not share a
 * cache entry, but the key only has to distinguish them within one tab, so a
 * non-cryptographic hash is the right cost. Collisions would show stale output
 * for one frame at worst.
 */
export function draftRevision (code) {
  const text = String(code || '')
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return `${text.length.toString(36)}${(hash >>> 0).toString(36)}`
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
 * Fetch the bars a study runs over.
 *
 * This is the same history the chart itself loads, from the same endpoint: a
 * study computed against bars the chart is not showing would draw its line
 * against the wrong candles. The response is asked for in the units `toPineBar`
 * accepts and handed straight to the runtime.
 */
export async function loadStudyBars ({ market, symbol, timeframe, limit, exchangeId = '', marketType = '', instrumentId = '' }) {
  const response = await request({
    url: '/api/market-data/candles',
    method: 'get',
    params: {
      market,
      symbol,
      timeframe,
      limit,
      ...(exchangeId ? { exchange_id: exchangeId } : {}),
      ...(marketType ? { market_type: marketType } : {}),
      ...(instrumentId ? { instrument_id: instrumentId } : {})
    },
    timeout: 45000
  })
  const rows = Array.isArray(response?.data) ? response.data : []
  return rows.map(toPineBar).filter(Boolean)
}

/**
 * Periods a script may ask for that the endpoint has no series for, and the
 * series that can be aggregated up into them.
 *
 * Pine's `request.security` accepts any bar length, and scripts use periods a
 * venue does not publish: a CPR study reads 25 minutes, which no exchange
 * serves. Refusing it leaves every value the study derives from it `na`, and a
 * study that is 90 % derived from a higher timeframe then draws nothing at all.
 * Five 5-minute bars are exactly one 25-minute bar, so it is answered instead.
 */
const AGGREGATED_TIMEFRAMES = {
  // Keyed by the token the runtime reports, which is Pine's own spelling: an
  // `input.timeframe("25")` arrives as `"25"`, not `"25m"`.
  25: { from: '5m', factor: 5 }
}

/**
 * Fold bars of a shorter period into one of a longer period.
 *
 * The first bar's open and the last bar's close are the honest open and close of
 * the combined interval; the extremes are the extremes of the pieces; the volume
 * is their sum. The timestamp is the first piece's, so the series lines up with
 * the chart's own bars the way an exchange-published series would.
 */
function aggregateBars (bars, factor) {
  const out = []
  for (let i = 0; i + factor <= bars.length; i += factor) {
    const group = bars.slice(i, i + factor)
    let high = -Infinity
    let low = Infinity
    let volume = 0
    for (const bar of group) {
      if (Number.isFinite(bar.high)) high = Math.max(high, bar.high)
      if (Number.isFinite(bar.low)) low = Math.min(low, bar.low)
      volume += Number(bar.volume) || 0
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue
    out.push({
      time: group[0].time,
      open: group[0].open,
      high,
      low,
      close: group[group.length - 1].close,
      volume
    })
  }
  return out
}

/** Whether the bars endpoint can answer for this period. */
function isServableTimeframe (timeframe) {
  // Not upper-cased: `1M` is a month in Pine and `1m` is a minute in the
  // endpoint, so folding the case would call a month serviceable and send a
  // request the provider refuses.
  return SERVICEABLE_TIMEFRAMES.has(String(timeframe || '').trim())
}

/**
 * A bar cache shared by every study on a chart, keyed by what identifies the
 * series rather than by which study asked.
 *
 * Without it each study fetches its own copy: five checked indicators meant five
 * 1500-bar downloads of the same symbol and timeframe, which is what made the
 * chart look like it was flooding the network on load. The bars are identical
 * for every study on a chart, so one fetch serves them all.
 *
 * In-flight requests are shared too. Studies are resolved in a burst, so without
 * that the first calls all miss the empty cache before any of them has answered.
 */
export function createStudyBarCache () {
  const settled = new Map()
  const pending = new Map()
  // The last live bar per timeframe. A study over this series must see it: the
  // fetched window ends at the most recent closed candle, so without it the
  // study stops drawing while the price keeps moving.
  //
  // Keyed by timeframe rather than by series, so a bar that arrives before a
  // study has loaded its bars is still applied when that load completes --
  // otherwise the first tick after switching indicator would be lost and the
  // study would stay a bar short until the next one.
  const live = new Map()
  const seriesKeyOf = (args) => [args.market, args.symbol, args.timeframe, args.exchangeId || '', args.marketType || '', args.instrumentId || '', args.limit].join('|')
  /** Merge the live bar for this series' timeframe: it replaces the candle it is. */
  const withLive = (key, bars) => {
    // Key layout is market|symbol|timeframe|exchange|marketType|instrument|limit.
    const bar = live.get(key.split('|')[2])
    if (!bar) return bars
    const out = bars.slice()
    const last = out[out.length - 1]
    if (last && Number(last.time) === Number(bar.time)) out[out.length - 1] = bar
    // A live bar the window does not contain yet is one the market has just
    // opened; appending it is what extends the series to now.
    else if (!last || Number(bar.time) > Number(last.time)) out.push(bar)
    return out
  }
  return {
    /**
     * The bars for this series, fetching once however many callers ask.
     *
     * A failed fetch is dropped from the cache so the next study retries it
     * rather than inheriting a rejection that had nothing to do with its script.
     */
    async load (args) {
      const key = seriesKeyOf(args)
      if (settled.has(key)) return withLive(key, settled.get(key))
      if (pending.has(key)) return pending.get(key)
      const inflight = loadStudyBars(args)
        .then((bars) => {
          settled.set(key, bars)
          pending.delete(key)
          return withLive(key, bars)
        })
        .catch((err) => {
          pending.delete(key)
          throw err
        })
      pending.set(key, inflight)
      return inflight
    },
    /**
     * Record the bar the socket just delivered.
     *
     * Returns the series keys the bar belongs to so a caller knows which
     * studies are now stale. A forming candle keeps the same time and replaces
     * its predecessor, which is what a live bar is.
     *
     * `timeframe` is required: a cached series may be for a period the chart is
     * not on (`request.security` reads a daily series from an hourly chart), and
     * appending an hourly bar to a daily one would move its last candle to the
     * wrong time.
     */
    rememberLive (bar, timeframe) {
      if (!bar || !Number.isFinite(Number(bar.time))) return []
      const wanted = String(timeframe || '').trim()
      if (!wanted) return []
      live.set(wanted, bar)
      // The series this bar belongs to, so the caller knows what is now stale.
      // Empty when nothing is loaded yet: the bar is kept and applies to the
      // next load, but there is no drawn study to refresh.
      const touched = []
      for (const key of [...settled.keys(), ...pending.keys()]) {
        if (key.split('|')[2] !== wanted) continue
        touched.push(key)
      }
      return touched
    },
    clear () {
      settled.clear()
      pending.clear()
      live.clear()
    },
    get size () {
      return settled.size
    }
  }
}

/**
 * Compile and run one Pine indicator against a chart window.
 *
 * Returns `{ plots, signals, candleTimes }` in the same shape the backend
 * preview used to return, so the study builder downstream is unchanged. The
 * work happens here rather than in the backend sandbox: the editor buffer is
 * what the author is looking at, and a round trip per keystroke-sized edit is
 * exactly what made the chart feel slow.
 *
 * `indicatorId` is carried for the caller's cache key and error reporting; the
 * script itself is the only thing executed, which is why an unsaved buffer
 * needs no saved row to draw.
 */
export async function loadSeries ({
  indicatorId,
  market,
  symbol,
  timeframe,
  limit = DEFAULT_STUDY_BARS,
  params = {},
  code = '',
  name = '',
  exchangeId = '',
  marketType = '',
  instrumentId = '',
  bars: barsIn = null,
  loadBars = null
}) {
  const source = String(code || '')
  if (!source.trim()) {
    throw new Error(`${name || `Indicator ${indicatorId}`} has no Pine source to run`)
  }
  // A caller that already holds this series hands it over: every study on a
  // chart runs over the same bars, so re-downloading them per study is work
  // with no information in it.
  const wanted = Math.min(Number(limit) || DEFAULT_STUDY_BARS, MAX_STUDY_BARS)
  const bars = Array.isArray(barsIn) && barsIn.length
    ? barsIn
    : await (loadBars
      ? loadBars({ market, symbol, timeframe, limit: wanted, exchangeId, marketType, instrumentId })
      : loadStudyBars({ market, symbol, timeframe, limit: wanted, exchangeId, marketType, instrumentId }))
  if (!bars.length) {
    throw new Error(`No bars for ${symbol} ${timeframe}`)
  }
  // `params` are the values of the inputs the script declares; the runtime
  // applies them as overrides, so the study matches the settings panel instead
  // of always running the script's own defaults.
  //
  // `loadBars` is what makes `request.security` work: the script may read a
  // timeframe the chart is not on, and the runtime asks this loader for those
  // bars instead of going without them.
  const result = await runPineStudy({
    code: source,
    bars,
    symbol,
    timeframe,
    interval: pineIntervalFor(timeframe),
    params,
    loadBars: (security) => {
      // The runtime names timeframes the Pine way; the endpoint names them the
      // chart way, so the token is translated before the request is built.
      const requested = timeframeForPineInterval(security.timeframe)
      // A period this deployment has no series for is answered with no bars
      // rather than an error: the request would otherwise fail with
      // `unsupportedTimeframe` and take the whole study down, when only the
      // lines that read this period are unknown. Pine's own `request.security`
      // returns `na` in that case, and these scripts already handle `na`.
      if (!isServableTimeframe(requested)) {
        const recipe = AGGREGATED_TIMEFRAMES[String(requested).trim()]
        if (!recipe) return Promise.resolve([])
        const load = loadBars || loadStudyBars
        // Enough of the shorter period to cover the same span the chart asked
        // for; the factor is how many pieces make one bar of the longer one.
        return load({
          market,
          symbol,
          timeframe: recipe.from,
          limit: Math.min(wanted * recipe.factor, 20000),
          exchangeId,
          marketType,
          instrumentId
        }).then((pieces) => aggregateBars(pieces, recipe.factor))
      }
      const args = {
        market,
        symbol,
        timeframe: requested,
        limit: wanted,
        exchangeId,
        marketType,
        instrumentId
      }
      // The same shared loader the primary series used, so two studies reading
      // the same higher timeframe download it once between them.
      return loadBars ? loadBars(args) : loadStudyBars(args)
    }
  })
  return {
    plots: normalizePlots(result.plots),
    signals: Array.isArray(result.signals) ? result.signals : [],
    // Already in milliseconds: `toPineBar` normalised them on the way in, so
    // there is no second conversion to get wrong.
    candleTimes: result.candleTimes,
    // Labels are pinned to a bar index; the chart draws at a time. Resolving
    // that here is what lets a caller hand a drawing straight to the library
    // without knowing how the runtime numbered its bars.
    labels: anchorLabels(result.labels, result.candleTimes),
    tables: Array.isArray(result.tables) ? result.tables : []
  }
}

/**
 * Turn the runtime's bar indices into the times the chart draws at.
 *
 * A label whose bar is not in the series is dropped rather than pinned to the
 * wrong candle: the runtime numbers its bars from the series it was given, so a
 * missing index means the drawing belongs to a bar this study cannot address,
 * and drawing it elsewhere would be a lie about where it happened.
 */
function anchorLabels (labels, candleTimes) {
  if (!Array.isArray(labels) || !labels.length) return []
  const times = Array.isArray(candleTimes) ? candleTimes : []
  const out = []
  for (const label of labels) {
    const time = times[Number(label.barIndex)]
    if (!Number.isFinite(time)) continue
    out.push({ ...label, time })
  }
  return out
}

/**
 * Turn run output into replayable series.
 *
 * A plot point is either a number or `{value, color, size}`; clouds carry
 * `upper`/`lower`; markers carry booleans; candles carry four prices. Every
 * form is reduced to the channels the study can return, and the plot's drawing
 * metadata (style, shape, location, palette colour) is kept because the study's
 * metainfo is built from it -- a marker that loses its shape is a different
 * indicator on screen.
 */
export function normalizePlots (plots) {
  if (!Array.isArray(plots)) return []
  const out = []
  // The runtime marks a series the author sent to the data window, the status
  // line or nowhere at all. That flag has to survive this reduction: the study
  // is built from what comes out of here, and a `display=display.none` helper
  // series that loses its flag is painted on the pane as a line the author
  // never wanted (it was happening to every one of the 8 corpus scripts whose
  // only output is off-pane).
  const record = (plot, entry) => {
    if (plot.hidden === true) entry.hidden = true
    out.push(entry)
  }
  for (const plot of plots) {
    if (!plot || typeof plot !== 'object') continue
    const name = String(plot.name || plot.title || '').trim()
    if (!name) continue
    // A cloud needs two channels; drawing only its midpoint would look like a
    // line and lose the band the author drew on purpose.
    if (isCloud(plot)) {
      record(plot, { kind: 'cloud', name, upper: channel(plot, 'upper'), lower: channel(plot, 'lower') })
      continue
    }
    const kind = plotKindOf(plot)
    if (kind === 'shape' || kind === 'char') {
      record(plot, {
        kind,
        name,
        values: markerChannel(plot),
        shape: String(plot.shape || ''),
        char: String(plot.char || ''),
        location: String(plot.location || ''),
        color: String(plot.color || ''),
        textColor: String(plot.textColor || ''),
        text: String(plot.text || ''),
        overlay: plot.overlay !== false
      })
      continue
    }
    if (kind === 'candle') {
      record(plot, {
        kind,
        name,
        candles: candleChannel(plot),
        color: String(plot.color || ''),
        overlay: plot.overlay !== false
      })
      continue
    }
    if (kind === 'barcolor' || kind === 'bgcolor') {
      const colors = normaliseColours(plot)
      record(plot, { kind, name, colors, overlay: plot.overlay !== false })
      continue
    }
    if (kind === 'fill') {
      const plot1 = String(plot.plot1 || '').trim()
      const plot2 = String(plot.plot2 || '').trim()
      if (!plot1 || !plot2) continue
      record(plot, { kind, name, plot1, plot2, color: String(plot.color || '') })
      continue
    }
    record(plot, {
      kind: kind === 'bar' ? 'bar' : 'line',
      name,
      values: channel(plot, 'value'),
      colors: colourChannel(plot),
      // The line's visual style travels with it: a histogram and a stepline are
      // the same numbers drawn in ways that mean different things.
      style: plot.style && typeof plot.style === 'object' ? plot.style : null,
      overlay: plot.overlay !== false
    })
  }
  return out
}

/**
 * Which drawing a plot describes.
 *
 * A plot without a `kind` is an older payload and is read the way it always
 * was: `type` decides bar versus line, and a point shaped like a cloud makes a
 * cloud. The explicit kinds come from the Pine runtime, which knows exactly
 * which drawing call produced each series.
 */
function plotKindOf (plot) {
  const kind = String(plot.kind || '').toLowerCase()
  if (kind) return kind
  return String(plot.type || 'line') === 'bar' ? 'bar' : 'line'
}

/** Marker rows are booleans: true draws, anything else is a gap. */
function markerChannel (plot) {
  const values = channel(plot, 'value')
  const data = Array.isArray(plot.data) ? plot.data : []
  return values.map((value, index) => {
    if (value == null) return null
    // Some producers emit the marker as a boolean, others as 1/0.
    const raw = data[index]
    if (raw === true) return 1
    if (raw === false) return null
    return value ? 1 : null
  })
}

/** A candle channel: four prices per bar, or a gap. */
function candleChannel (plot) {
  const data = Array.isArray(plot.data) ? plot.data : []
  return data.map((point) => {
    if (!point || typeof point !== 'object') return null
    const open = Number(point.open)
    const high = Number(point.high)
    const low = Number(point.low)
    const close = Number(point.close)
    if (![open, high, low, close].every(Number.isFinite)) return null
    return { open, high, low, close }
  })
}

/** Per-bar colours, already reduced to a colour string or null. */
function normaliseColours (plot) {
  const given = Array.isArray(plot.colors) ? plot.colors : []
  if (given.length) return given.map(colour => (colour ? String(colour) : null))
  const data = Array.isArray(plot.data) ? plot.data : []
  return data.map((point) => {
    if (!point || typeof point !== 'object') return null
    const colour = point.color
    return colour ? String(colour) : null
  })
}

function isCloud (plot) {
  const type = String(plot.type || '').toLowerCase()
  if (['cloud', 'band', 'fill_between', 'fill-between'].includes(type)) return true
  const first = Array.isArray(plot.data) ? plot.data.find(point => point && typeof point === 'object') : null
  return Boolean(first && ('upper' in first || 'top' in first))
}

/**
 * The points of a plot, in whichever shape the caller has them.
 *
 * `normalizePlots` reads `data` (what the runtime returns) and writes `values`
 * (what the layout consumes), so a second pass over its own output used to read
 * an empty array and silently blank the line. Accepting both makes the function
 * idempotent, which is what a live update needs: it hands already-normalized
 * series back through the same layout builder.
 */
function channel (plot, mode) {
  const source = Array.isArray(plot.data) ? plot.data : (Array.isArray(plot.values) ? plot.values : [])
  const data = source
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
  const data = Array.isArray(plot.data) ? plot.data : (Array.isArray(plot.colors) ? plot.colors : [])
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
export function buildCustomIndicator ({ indicatorId, name, series, key, candleTimes, labels = [], tables = [], inputSpecs = [], params = {} }) {
  const label = String(name || `Indicator ${indicatorId}`)
  const primary = series.find(plot => plot.overlay) || series[0]
  // A script that draws annotations has something to show even when every one
  // of its plots sits in the data window or none exist at all.
  const overlaysPrice = Boolean(primary && primary.overlay !== false) || (!primary && (labels.length > 0 || tables.length > 0))
  const layout = buildPlotLayout(series)
  // The native Settings dialog renders exactly this list. Without it the dialog
  // opens empty for every custom study, and `getInputValues()` has no ids to
  // read back -- so the inputs are part of the study's identity, not decoration.
  const studyInputs = buildStudyInputs(inputSpecs, params)
  layout.defaults.inputs = studyInputs.defaults

  const metainfo = {
    id: `qd_indicator_${indicatorId}`,
    name: label,
    description: label,
    shortDescription: label,
    // A study with a price overlay lives on the price pane; anything else gets
    // its own, which is what the pane placement in the indicator output means.
    overlay: overlaysPrice,
    is_price_study: overlaysPrice,
    plots: layout.plots,
    defaults: layout.defaults,
    styles: layout.styles,
    inputs: studyInputs.inputs,
    ...layout.extra
  }

  // One place builds the lookup, so the initial one and a live update cannot
  // drift apart. It reads `state` rather than the locals above because a live
  // update replaces both the specs and the plot count: a bar the market has
  // just opened lengthens every value array, and a lookup still indexing the
  // old columns would answer with the previous bar's numbers.
  const state = { plotSpecs: layout.specs, plotCount: layout.plots.length }
  const buildLookup = (times) => ({
    barIndex: buildBarTimeIndex({ plotSpecs: state.plotSpecs, candleTimes: times }),
    gapRow: new Array(state.plotCount).fill(NaN)
  })
  // The library constructs its own instance (`new Study()`), so `main` cannot
  // read a field of the object returned below. This holder is reachable from
  // the prototype instead, which is what lets a live bar replace the lookup:
  // the values are recomputed against the bar the socket just delivered and
  // the next recalculation draws them.
  const lookup = buildLookup(candleTimes)
  const barIndex = lookup.barIndex

  function Study () {}
  Study.prototype.lookup = lookup
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
      // Read through the holder, not a closed-over constant: a live bar
      // replaces the lookup so the next recalculation draws the new values.
      const row = lookup.barIndex.at(candidate)
      // Copied because the library keeps the array it is handed; the indexed
      // rows are shared and must not become a channel for caller mutations.
      if (row) return row.slice()
    }
    // A gap must stay a gap: NaN is the library's "no value here", and it is
    // returned only when the backend really has no value for this bar's time --
    // an explicit hole in its output, or a bar outside the window it computed.
    // It is never the result of walking off the end of an array.
    return lookup.gapRow.slice()
  }

  return {
    key,
    name: label,
    metainfo,
    // The library applies `new` to this function, so it must stay a function
    // rather than an arrow.
    constructor: Study,
    series,
    barIndex,
    // id (`in_<n>`) -> Pine title. A value edited in the Settings dialog comes
    // back keyed by id, and the runtime's overrides are keyed by title.
    inputMap: studyInputs.byId,
    // The library's `inputs` list as handed to `createStudy`, kept so a live
    // instance can be asked what it is showing (`getInputValues`).
    inputs: studyInputs.inputs,
    // The overrides this study was evaluated with, keyed by Pine title. A value
    // edited in the Settings dialog is compared against these to decide whether
    // anything actually changed.
    params: { ...(params || {}) },
    // Drawings the series cannot carry. A label is pinned to a time and a
    // price; a table is placed at a corner of the pane. Neither is a plot, so
    // a study's plot table cannot express them, and the caller draws them.
    labels: Array.isArray(labels) ? labels : [],
    tables: Array.isArray(tables) ? tables : [],
    // What the caller turns into the next lookup on a live bar, so it does not
    // have to reach back into the cache for it.
    candleTimes: Array.isArray(candleTimes) ? candleTimes : [],
    /**
     * Point the study at output computed from a longer series.
     *
     * The library holds its own `Study` instance, and that instance reads
     * `lookup`, so replacing the lookup is what makes a live bar visible
     * without a widget rebuild: the chart recalculates the study and the same
     * instance answers with the new values.
     *
     * `plots` must describe the same script with the same declarations -- the
     * metainfo above is frozen at construction and addresses plots by id. A
     * live update only ever appends bars, so the ids do not move.
     */
    update ({ plots, candleTimes, labels: nextLabels, tables: nextTables } = {}) {
      // A script that draws nothing but annotations has an empty plot list on
      // every bar, so a live tick still has to be accepted to move them.
      const hasPlots = Array.isArray(plots) && plots.length
      const hasDrawings = (Array.isArray(nextLabels) && nextLabels.length) || (Array.isArray(nextTables) && nextTables.length)
      if (!hasPlots && !hasDrawings) return false
      if (!Array.isArray(candleTimes) || !candleTimes.length) return false
      // Same script, one more bar: the layout is rebuilt so the lookup indexes
      // the longer value arrays. `metainfo` deliberately stays as it was -- the
      // plot ids it advertises do not move when a bar is appended.
      if (hasPlots) {
        const next = buildPlotLayout(normalizePlots(plots))
        state.plotSpecs = next.specs
        state.plotCount = next.plots.length
      }
      Object.assign(lookup, buildLookup(candleTimes))
      if (Array.isArray(nextLabels)) this.labels = nextLabels
      if (Array.isArray(nextTables)) this.tables = nextTables
      return true
    }
  }
}

/**
 * The plot table, styles and extra metainfo sections a set of series needs.
 *
 * Every drawing kind the Pine runtime can produce maps to a different part of
 * the custom-study contract, and the library sizes its output from `plots`:
 * a study that declares one line but returns four candle values draws one of
 * them and silently drops the rest. So the table is derived from the series
 * rather than being a fixed line per plot.
 *
 * `specs` is the parallel list the bar index reads, kept aligned with `plots`
 * so a returned value lands on the plot that declared it. A candle spec expands
 * into four consecutive entries because the library declares an OHLC plot as
 * four targeted plots and expects one value per plot.
 */
function buildPlotLayout (series) {
  const plots = []
  const specs = []
  const styles = {}
  const defaults = { styles: {}, inputs: {} }
  const extra = {}
  // Fills name the plot titles the script declared, so the layout tracks the
  // title-to-plot-id map as it builds the table.
  const idByTitle = new Map()
  let fills = 0
  let candleIndex = 0
  let paletteIndex = 0

  for (const plot of series || []) {
    if (!plot || typeof plot !== 'object') continue
    const plotId = `plot_${plots.length}`
    const label = String(plot.name || `Plot ${plots.length}`)

    if (plot.kind === 'cloud') {
      // A cloud is two lines plus the band between them: the library fills
      // between plot ids, never between channels of one plot.
      const lowerId = `plot_${plots.length + 1}`
      plots.push({ id: plotId, type: 'line' })
      specs.push({ values: plot.upper })
      plots.push({ id: lowerId, type: 'line' })
      specs.push({ values: plot.lower })
      styles[plotId] = { title: `${label} upper` }
      styles[lowerId] = { title: `${label} lower` }
      const fillId = `fill_${fills}`
      fills += 1
      extra.filledAreas = extra.filledAreas || []
      extra.filledAreas.push({
        id: fillId,
        objAId: plotId,
        objBId: lowerId,
        type: 'plot_plot',
        title: label
      })
      defaults.filledAreasStyle = defaults.filledAreasStyle || {}
      defaults.filledAreasStyle[fillId] = {
        visible: true,
        transparency: 80,
        color: plot.fillColor || plot.color || '#2962FF'
      }
      continue
    }

    if (plot.kind === 'fill') {
      const upper = idByTitle.get(String(plot.plot1 || '').trim())
      const lower = idByTitle.get(String(plot.plot2 || '').trim())
      // A fill names two plots it shades. If either was never declared the band
      // cannot exist; dropping it is honest, inventing one is not.
      if (!upper || !lower) continue
      const fillId = `fill_${fills}`
      fills += 1
      extra.filledAreas = extra.filledAreas || []
      extra.filledAreas.push({
        id: fillId,
        objAId: upper,
        objBId: lower,
        type: 'plot_plot',
        title: label
      })
      defaults.filledAreasStyle = defaults.filledAreasStyle || {}
      defaults.filledAreasStyle[fillId] = {
        visible: true,
        // Pine's `color.new(colour, 80)` already carries its alpha in the colour
        // string, and the fill keeps it in the bar data; asking the library to
        // add transparency on top would double it.
        transparency: 0,
        color: plot.color || '#2962FF'
      }
      continue
    }

    if (plot.kind === 'candle') {
      // Four targeted plots plus one OHLC meta plot. `main` returns these four
      // values in declaration order, which is why the spec expands here rather
      // than at read time.
      const target = `plotcandle_${candleIndex}`
      candleIndex += 1
      for (const side of ['ohlc_open', 'ohlc_high', 'ohlc_low', 'ohlc_close']) {
        plots.push({ id: `plot_${plots.length}`, type: side, target })
        specs.push({ candle: plot.candles, side })
      }
      extra.ohlcPlots = extra.ohlcPlots || {}
      extra.ohlcPlots[target] = { title: label, isHidden: false }
      defaults.ohlcPlots = defaults.ohlcPlots || {}
      defaults.ohlcPlots[target] = {
        plottype: 'ohlc_candles',
        color: plot.color || '#2196F3',
        wickColor: plot.color || '#2196F3',
        borderColor: plot.color || '#2196F3',
        drawWick: true,
        drawBorder: false,
        visible: true
      }
      idByTitle.set(label, `plot_${plots.length - 4}`)
      continue
    }

    if (plot.kind === 'shape' || plot.kind === 'char') {
      const isShape = plot.kind === 'shape'
      const shape = normaliseShape(isShape, plot.shape, plot.char)
      const location = normaliseLocation(plot.location)
      plots.push({ id: plotId, type: isShape ? 'shapes' : 'chars' })
      specs.push({ values: plot.values })
      styles[plotId] = {
        title: label,
        location,
        ...(plot.text ? { text: plot.text } : {}),
        ...(isShape ? {} : { char: shape.char })
      }
      defaults.styles[plotId] = {
        visible: true,
        plottype: shape.plottype,
        location,
        color: plot.color || '#2196F3',
        textColor: plot.textColor || '#FFFFFF'
      }
      idByTitle.set(label, plotId)
      continue
    }

    if (plot.kind === 'barcolor' || plot.kind === 'bgcolor') {
      // Colour-only: a palette plot whose returned value selects a colour. The
      // palette is built from the colours the script actually used, so a script
      // that paints two states gets two palette entries rather than a fixed set.
      const palette = `palette_${paletteIndex}`
      paletteIndex += 1
      const colours = []
      for (const colour of plot.colors || []) {
        if (!colour || colours.includes(colour)) continue
        colours.push(colour)
      }
      if (!colours.length) continue
      // `valToIndex` maps the value `main` returns to a palette entry. The value
      // is 1-based so a bar the script left uncoloured can be a gap (NaN)
      // instead of sharing index 0 with the first real colour.
      const valToIndex = {}
      colours.forEach((_colour, colourIndex) => { valToIndex[colourIndex + 1] = colourIndex })
      plots.push({ id: plotId, type: plot.kind === 'barcolor' ? 'bar_colorer' : 'bg_colorer', palette })
      specs.push({
        values: (plot.colors || []).map(colour => (colour ? colours.indexOf(colour) + 1 : NaN))
      })
      extra.palettes = extra.palettes || {}
      extra.palettes[palette] = {
        colors: colours.map((_colour, colourIndex) => ({ name: `Colour ${colourIndex + 1}` })),
        valToIndex
      }
      defaults.palettes = defaults.palettes || {}
      defaults.palettes[palette] = {
        colors: colours.reduce((acc, colour, colourIndex) => {
          acc[colourIndex] = { color: colour }
          return acc
        }, {})
      }
      styles[plotId] = { title: label }
      idByTitle.set(label, plotId)
      continue
    }

    plots.push({ id: plotId, type: 'line' })
    specs.push({ values: plot.values })
    styles[plotId] = { title: label }
    // A hidden plot stays in the table -- a `fill` names it by title and reads
    // its values -- but the library is told not to paint it. Drawing it would
    // add a line the author put `display=display.none` on deliberately.
    defaults.styles[plotId] = {
      visible: !plot.hidden,
      ...(plot.style ? { ...plot.style } : { plottype: 0 }),
      color: plot.color || '#2962FF',
      linewidth: 1
    }
    idByTitle.set(label, plotId)
  }

  return { plots, specs, styles, defaults, extra }
}

/**
 * A Pine shape token as the library's `plottype`, falling back to a circle.
 *
 * The two vocabularies are nearly identical (`shape_triangle_up` on both sides)
 * but not entirely: Pine's `style_arrowup`/`style_arrowdown` map to the
 * library's `shape_arrow_up`/`shape_arrow_down`, and anything unrecognised must
 * still draw something rather than being dropped.
 */
function normaliseShape (isShape, shape, char) {
  const token = String(shape || '').trim()
  const alias = {
    style_arrowup: 'shape_arrow_up',
    style_arrowdown: 'shape_arrow_down',
    style_circle: 'shape_circle',
    style_square: 'shape_square',
    style_diamond: 'shape_diamond',
    style_flag: 'shape_flag',
    style_xcross: 'shape_xcross',
    style_triangleup: 'shape_triangle_up',
    style_triangledown: 'shape_triangle_down'
  }
  if (!isShape) return { char: String(char || 'X') }
  return { plottype: alias[token] || (token.startsWith('shape_') ? token : 'shape_circle') }
}

/**
 * A Pine location token as the library's `MarkLocation`.
 *
 * The vocabularies match exactly; the fallback is the side the shape itself
 * implies, because a marker with no location renders at the price level and
 * would read as a different signal.
 */
function normaliseLocation (location) {
  const token = String(location || '').trim()
  const allowed = ['AboveBar', 'BelowBar', 'Top', 'Bottom', 'Right', 'Left', 'Absolute', 'AbsoluteUp', 'AbsoluteDown']
  return allowed.includes(token) ? token : 'AboveBar'
}

/**
 * The library's `StudyInputType` for a Pine input spec.
 *
 * Pine names ten families (`input.int`, `input.timeframe`, ...) and the library
 * names almost the same ten, but the words differ and the fallback matters:
 * an unknown family must render as a text field rather than make the whole
 * settings dialog fail to build.
 */
const STUDY_INPUT_TYPES = {
  int: 'integer',
  float: 'float',
  price: 'price',
  bool: 'bool',
  color: 'color',
  source: 'source',
  symbol: 'symbol',
  timeframe: 'resolution',
  session: 'session',
  time: 'time',
  bar_time: 'bar_time',
  str: 'text',
  enum: 'text'
}

/**
 * Pine's named colours, as the library's colour inputs want them.
 *
 * The runtime hands plot colours over as CSS already, but an input default can
 * still be the bare constant `color.red` (or a `color.new(color.red, 20)` the
 * script uses for its own signal). Without this table those defaults would
 * arrive as the literal string "color.red", which the colour picker cannot
 * parse. Values are the palette the chart itself uses, so a default signal
 * colour reads the same in the dialog as on the chart.
 */
const PINE_COLOURS = {
  red: '#F23645',
  green: '#089981',
  blue: '#2962FF',
  yellow: '#FDD835',
  orange: '#FF9800',
  purple: '#9C27B0',
  aqua: '#00BCD4',
  black: '#000000',
  white: '#FFFFFF',
  gray: '#787B86',
  grey: '#787B86',
  silver: '#B2B5BE',
  lime: '#00E676',
  fuchsia: '#E040FB',
  maroon: '#880E4F',
  navy: '#311B92',
  olive: '#808000',
  teal: '#00897B'
}

const DEFAULT_STUDY_COLOUR = '#2962FF'

/** A Pine colour expression (constant, hex, or `color.new(...)`) as CSS. */
function studyColour (value) {
  let text = String(value == null ? '' : value).trim()
  if (!text) return DEFAULT_STUDY_COLOUR
  // `color.new(colour, transparency)` wraps the colour it derives from; the
  // transparency it adds is already baked into the plot data, so only the inner
  // colour is needed here.
  while (text.startsWith('color.new(') && text.endsWith(')')) {
    text = text.slice('color.new('.length, -1).split(',')[0].trim()
  }
  const named = /^color\.([a-z_]+)$/i.exec(text)
  if (named) return PINE_COLOURS[named[1].toLowerCase()] || DEFAULT_STUDY_COLOUR
  const hex = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text)
  if (hex) return `#${hex[1].slice(0, 6).toUpperCase()}`
  return DEFAULT_STUDY_COLOUR
}

function studyNumber (value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Turn Pine input specs into the library's `inputs` meta list.
 *
 * The list is what the native Settings dialog renders, and its ids are what
 * `getInputValues()` returns, so the id here is the same `in_<n>` the runtime
 * assigns -- that is the one stable handle both sides agree on when a saved
 * override has to address a declaration the user has since retitled.
 *
 * `params` are the current values (a saved indicator's defaults, or what the
 * user last picked); anything missing falls back to the script's own default so
 * the dialog opens showing what the chart is actually drawing.
 */
export function buildStudyInputs (specs, params) {
  const values = params || {}
  const inputs = []
  const defaults = {}
  // id -> the Pine title that keys `params`, so a value edited in the native
  // dialog can be turned back into the override the runtime understands.
  const byId = {}
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (!spec || !spec.name || !spec.pineInputId) continue
    const type = STUDY_INPUT_TYPES[spec.type] || 'text'
    const raw = Object.prototype.hasOwnProperty.call(values, spec.name) ? values[spec.name] : spec.defaultValue
    const id = spec.pineInputId
    const info = { id, name: String(spec.name), type }
    if (spec.group) info.group = String(spec.group)
    if (spec.description) info.tooltip = String(spec.description)
    switch (type) {
      case 'integer':
      case 'float':
      case 'price':
        info.defval = studyNumber(raw)
        break
      case 'bool':
        info.defval = Boolean(raw)
        break
      case 'color':
        info.defval = studyColour(raw)
        break
      case 'time':
      case 'bar_time':
        info.defval = studyNumber(raw)
        break
      case 'text':
        info.defval = raw == null ? '' : String(raw)
        if (Array.isArray(spec.values) && spec.values.length) info.options = spec.values.map(value => String(value))
        break
      default:
        info.defval = raw == null ? '' : String(raw)
    }
    if (['integer', 'float', 'price'].includes(type)) {
      if (Number.isFinite(Number(spec.min))) info.min = Number(spec.min)
      if (Number.isFinite(Number(spec.max))) info.max = Number(spec.max)
      if (Number.isFinite(Number(spec.step)) && Number(spec.step) > 0) info.step = Number(spec.step)
    }
    inputs.push(info)
    defaults[id] = info.defval
    byId[id] = String(spec.name)
  }
  return { inputs, defaults, byId }
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
export async function resolveCustomIndicators ({ indicators, market, symbol, timeframe, cache, exchangeId = '', marketType = '', instrumentId = '', barCache = null }) {
  const built = []
  const failures = []
  const list = indicators || []
  // Every study on this chart runs over one series, so fetch it once up front
  // when the caller provided a shared cache. Resolving the studies afterwards
  // needs no network at all for the chart timeframe.
  // One fetch sized for the largest study on the chart: a shorter series would
  // truncate the study that asked for more, and fetching per study was the
  // flood. No studies means no request at all.
  const widest = list.reduce(
    (widestSoFar, item) => Math.max(widestSoFar, Math.min(Number(item.limit) || DEFAULT_STUDY_BARS, MAX_STUDY_BARS)),
    0
  )
  const sharedBars = barCache && widest > 0
    ? await barCache.load({
      market,
      symbol,
      timeframe,
      limit: widest,
      exchangeId,
      marketType,
      instrumentId
    })
    : null
  const loadBars = barCache
    ? (args) => barCache.load(args)
    : null
  // Resolve every study at once. They share one series now, so the only work
  // left per study is evaluating its script -- which is CPU, and CPU that the
  // browser can interleave instead of waiting out one script before starting the
  // next. The order of `built` still follows the checked set, because the
  // studies are collected by index rather than by completion.
  const resolved = await Promise.all(list.map(async (indicator) => {
    const indicatorId = indicatorIdOf(indicator)
    const inlineCode = String(indicator.code || '')
    // An editor draft has no saved row to key on, so its own text is the
    // identity. Hashing keeps the key short and stops a long script from
    // bloating the cache map.
    if (!indicatorId && !inlineCode.trim()) return null
    const revision = inlineCode.trim() ? draftRevision(inlineCode) : ''
    const paramsKey = paramsFingerprint(indicator.params)
    // The native Settings dialog is built from these, so they are parsed once
    // per study here rather than per bar. A script whose source is not in hand
    // simply gets no dialog inputs -- there is nothing honest to render.
    const inputSpecs = inlineCode.trim() ? parsePineInputSpecs(inlineCode) : []
    const key = seriesKey({ indicatorId, market, symbol, timeframe, revision, params: paramsKey })
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
          limit: indicator.limit || DEFAULT_STUDY_BARS,
          params: indicator.params || {},
          code: inlineCode,
          name: indicator.name || indicator.display_name || '',
          exchangeId,
          marketType,
          instrumentId,
          bars: sharedBars,
          loadBars
        })
      } catch (err) {
        // One indicator that fails to run -- a Pine error, or a symbol it has
        // no data for -- must not take the chart down with it. The library
        // draws the bars and simply omits this study.
        return { failure: { indicatorId, reason: err?.message || String(err) } }
      }
      cache.set(key, loaded)
    }
    const series = loaded?.plots
    // A script whose only output is a table or a label has no plots at all, and
    // dropping it here is what made 7 of the corpus draw an empty study. It is
    // kept when it has drawings to hand to the chart instead.
    const labels = Array.isArray(loaded?.labels) ? loaded.labels : []
    const tables = Array.isArray(loaded?.tables) ? loaded.tables : []
    if ((!series || !series.length) && !labels.length && !tables.length) return null
    return {
      study: buildCustomIndicator({
        indicatorId,
        name: indicator.name || indicator.display_name || indicator.title,
        series: series || [],
        candleTimes: loaded?.candleTimes,
        labels,
        tables,
        inputSpecs,
        params: indicator.params || {},
        key
      })
    }
  }))
  for (const entry of resolved) {
    if (!entry) continue
    if (entry.failure) failures.push(entry.failure)
    else built.push(entry.study)
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
