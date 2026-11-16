/**
 * Pine Script execution in the browser.
 *
 * The Indicator IDE authors Pine, and Pine is what the chart draws. Running it
 * here rather than in the backend is not an optimisation detail -- it changes
 * what is possible:
 *
 *  - a study appears as soon as the editor buffer changes, with no round trip
 *    and no saved row standing between the author and the chart;
 *  - there is no window cap. The old pipeline computed a fixed 300-360 bars
 *    because the sandbox paid roughly 25ms *per bar*; here a 3000-bar run costs
 *    about a second and nothing is shipped over the wire;
 *  - scrolling back over a longer history recomputes instead of showing a gap.
 *
 * `pinets` is loaded lazily (it is ~800KB minified) so a chart with no studies
 * never downloads a Pine runtime.
 */

import { pineImportResolver } from './pineLibraries.js'
import { repairTupleDestructuring, upgradeLegacyPine } from './pineUpgrade.js'

/** Bars per study computation. Beyond this the cost stops being imperceptible. */
export const DEFAULT_STUDY_BARS = 1500

/** Hard ceiling, so a stray `limit` cannot freeze the tab. */
export const MAX_STUDY_BARS = 20000

const MS_PER_SECOND = 1000

/** A script that pulls in a library needs the resolver; one that does not, does not. */
const IMPORT_RE = /^[ \t]*import[ \t]+[A-Za-z_]/m

/**
 * The runtime's complaint about a series indexed by a computed offset inside a
 * tuple-returning function. Matched on text because the thrown class is an
 * internal one and its name is minified.
 */
const DYNAMIC_ACCESS_RE = /dynamic computed member access/

/**
 * A bar time in milliseconds, or null when the value is not a plausible time.
 *
 * The venue APIs answer in seconds while the library speaks milliseconds, and
 * PineTS requires milliseconds. Normalising at this boundary is the only place
 * the unit is ambiguous.
 */
export function toBarTimeMs (value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  // 1e11 seconds is the year 5138 and 1e11 milliseconds is 1973, so the value
  // itself says which unit it is in.
  return numeric > 1e11 ? Math.round(numeric) : Math.round(numeric * MS_PER_SECOND)
}

/**
 * One backend candle as a Pine bar.
 *
 * Returns null for a row the runtime could not use, so a malformed bar is
 * dropped rather than poisoning every arithmetic result downstream.
 */
export function toPineBar (row) {
  const time = toBarTimeMs(row?.time ?? row?.timestamp ?? row?.open_time)
  if (time == null) return null
  const open = Number(row?.open)
  const high = Number(row?.high)
  const low = Number(row?.low)
  const close = Number(row?.close)
  if (![open, high, low, close].every(Number.isFinite)) return null
  const volume = Number(row?.volume)
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }
}

/**
 * Convert PineTS `plots` into the plot objects the chart can draw.
 *
 * Pine has more ways to draw than "a line with numbers", and the library models
 * each of them as a different plot type. Dropping everything that is not a
 * numeric line is what made a marker-only script look broken: its source is
 * valid, it draws shapes on every signal, and the chart showed nothing. So each
 * Pine drawing call is classified here and keeps the metadata its library plot
 * type needs:
 *
 *  - `plot(style=…)` becomes a line with that visual style (columns, circles,
 *    stepline, …) rather than always a plain line;
 *  - `plotshape`/`plotchar` become marker plots, carrying the shape, location,
 *    text and colours the script asked for;
 *  - `plotcandle` becomes an OHLC plot, because its value is four prices and
 *    drawing its last number as a line loses the candle entirely;
 *  - `barcolor`/`bgcolor` become palette plots, carrying the per-bar colour;
 *  - `fill` becomes a filled area between the two plots it names.
 *
 * Dropped on purpose:
 *  - `__`-prefixed keys are PineTS's drawing collections (labels, boxes, lines,
 *    tables). They are not plot data and the study contract has no slot for
 *    them yet.
 *  - a series with no value anywhere draws nothing; emitting it would add an
 *    empty legend entry for a plot the author never actually drew on. Marker
 *    and colour plots are exempt: "no bar triggered" is a normal outcome for
 *    them, not an empty plot.
 *
 * A value of `null` is a gap and stays one. `Number(null)` is 0, which would
 * draw the line along the zero axis for every bar the script left undefined --
 * a fabricated series that looks authoritative and is not.
 */
export function plotsFromPine (plots) {
  const out = []
  if (!plots || typeof plots !== 'object') return out
  for (const [key, plot] of Object.entries(plots)) {
    if (!plot || typeof plot !== 'object') continue
    if (String(key).startsWith('__')) continue
    const rows = Array.isArray(plot.data) ? plot.data : []
    if (!rows.length) continue
    const options = plot.options && typeof plot.options === 'object' ? plot.options : {}
    const style = String(options.style || '')

    // A fill draws nothing itself: it names two other plots and shades between
    // them, so it becomes a filled area rather than a series.
    if (style === 'fill') {
      const fill = fillFromPine(key, options)
      if (fill) out.push(fill)
      continue
    }

    const kind = plotKindFor(style)
    const name = plotName(kind, key, plot)
    if (!name) continue

    if (kind === 'candle') {
      const candle = candleFromPine(name, rows, options)
      if (candle) out.push(candle)
      continue
    }
    if (kind === 'barcolor' || kind === 'bgcolor') {
      const colours = colourRows(rows)
      if (!colours.some(Boolean)) continue
      out.push({
        name,
        kind,
        // Both paint the chart's own bars, so both belong on the price pane
        // whether or not the script said `overlay = true` (barcolor has no
        // overlay argument at all).
        overlay: true,
        data: colours.map(colour => Boolean(colour)),
        colors: colours
      })
      continue
    }
    if (kind === 'shape' || kind === 'char') {
      const marks = markerFromPine(kind, name, rows, options)
      if (marks) out.push(marks)
      continue
    }

    let hasValue = false
    const data = rows.map((row) => {
      const raw = row?.value
      if (raw == null || typeof raw === 'boolean') return null
      const value = Number(raw)
      if (!Number.isFinite(value)) return null
      hasValue = true
      const colour = row?.options?.color
      return colour ? { value, color: colour } : value
    })
    if (!hasValue) continue
    out.push({
      name,
      type: 'line',
      kind: 'line',
      // The visual style travels with the plot: a histogram and a stepline are
      // the same numbers drawn in ways that mean different things.
      style: lineStyleFor(style),
      overlay: options.overlay !== false,
      data
    })
  }
  return out
}

/**
 * Which library plot type a Pine drawing call maps to.
 *
 * `candle` and the two colour calls are named by PineTS' style token; every
 * other style is a line variant and is handled by `lineStyleFor`.
 */
function plotKindFor (style) {
  if (style === 'shape') return 'shape'
  if (style === 'char') return 'char'
  if (style === 'candle') return 'candle'
  if (style === 'barcolor') return 'barcolor'
  if (style === 'background') return 'bgcolor'
  return 'line'
}

/**
 * The legend name for a plot.
 *
 * `bgcolor`/`barcolor` are anonymous in Pine and arrive as `bgcolor#0`,
 * `bgcolor#1`, …; a second one must not collide with the first in the legend,
 * so the suffix becomes the visible title.
 */
function plotName (kind, key, plot) {
  if (kind === 'barcolor') return suffixedName('Bar colour', key)
  if (kind === 'bgcolor') return suffixedName('Background', key)
  return String(plot.title || key || '').trim()
}

function suffixedName (base, key) {
  const match = /#(\d+)$/.exec(String(key || ''))
  const index = match ? Number(match[1]) : 0
  return index > 0 ? `${base} ${index + 1}` : base
}

/** A Pine line style token as the library's `plottype`/`linestyle` pair. */
function lineStyleFor (style) {
  switch (style) {
    case 'style_histogram': return { plottype: 1 }
    case 'style_cross': return { plottype: 3 }
    case 'style_area':
    case 'style_areabr': return { plottype: 4 }
    case 'style_columns': return { plottype: 5 }
    case 'style_circles': return { plottype: 6 }
    case 'style_linebr': return { plottype: 7 }
    case 'style_stepline': return { plottype: 9 }
    case 'style_steplinebr': return { plottype: 11 }
    case 'style_dotted': return { plottype: 0, linestyle: 1 }
    case 'style_dashed': return { plottype: 0, linestyle: 2 }
    default: return { plottype: 0 }
  }
}

function fillFromPine (key, options) {
  const plot1 = String(options.plot1 || '').trim()
  const plot2 = String(options.plot2 || '').trim()
  // Without both sides there is nothing to shade; half a fill would draw a
  // band against the price axis and claim it was the author's.
  if (!plot1 || !plot2) return null
  return {
    name: `Fill ${plot1} / ${plot2}`,
    kind: 'fill',
    key: String(key || ''),
    plot1,
    plot2,
    color: String(options.color || '')
  }
}

/**
 * `plotshape`/`plotchar` rows are booleans: true on the bars that draw.
 *
 * The library hides a marker whose value is NaN and draws one whose value is
 * finite, so the marker becomes 1 or a gap. Per-bar colours are ignored on
 * purpose -- a `shapes`/`chars` plot has a single colour in metainfo, so
 * honouring one bar's colour would repaint every marker.
 */
function markerFromPine (kind, name, rows, options) {
  // Kept even when no bar fires. PineTS emits a row for every bar whether or
  // not the condition held, so "no marks here" is a normal state of a working
  // script -- dropping the plot would remove the indicator from the legend and
  // make a loaded study look like one that failed.
  const data = rows.map(row => (row?.value === true ? 1 : null))
  const location = String(options.location || '')
  return {
    name,
    kind,
    style: { plottype: 0 },
    data,
    shape: kind === 'shape' ? String(options.shape || '') : '',
    char: kind === 'char' ? String(options.char || '') : '',
    location,
    color: String(options.color || ''),
    textColor: String(options.textcolor || options.textColor || ''),
    text: String(options.text || ''),
    overlay: options.overlay !== false
  }
}

/** A candle plot's rows carry four prices; anything else is a gap. */
function candleFromPine (name, rows, options) {
  const data = rows.map((row) => {
    const raw = row?.value
    if (!Array.isArray(raw) || raw.length < 4) return null
    const [open, high, low, close] = raw.map(Number)
    if (![open, high, low, close].every(Number.isFinite)) return null
    return { open, high, low, close }
  })
  if (!data.some(Boolean)) return null
  return {
    name,
    kind: 'candle',
    data,
    color: String(options.color || ''),
    overlay: options.overlay !== false
  }
}

/** Per-bar colours of a `barcolor`/`bgcolor` call. */
function colourRows (rows) {
  return rows.map(row => (row?.value === true ? String(row?.options?.color || '') || null : null))
}

/**
 * The settings declared by a Pine script, as input specs the IDE can render.
 *
 * Pine declares its own inputs, so this is the only source of truth for the
 * parameter panel -- there is no `# @param` comment to read and no defaults
 * map to keep in sync. `getInputsMeta()` needs a transpile pass, which is why
 * this is async and why the result is worth caching per source text.
 *
 * A script that does not compile returns an empty list rather than throwing:
 * the parameter panel showing nothing is a better answer than the whole editor
 * failing because the author is mid-keystroke.
 */
export async function readPineInputs ({ code }) {
  const source = String(code || '')
  if (!source.trim()) return []
  try {
    const { Indicator } = await import('pinets')
    const indicator = new Indicator(source)
    indicator.prepare()
    return toInputSpecs(indicator.getInputsMeta())
  } catch (_error) {
    return []
  }
}

/**
 * Map PineTS input metadata onto the spec shape the IDE already renders.
 *
 * `name` is the title, because that is what the author sees and what the
 * runtime accepts as an override key. `varId` and `id` are kept so an override
 * can be addressed the way the script itself names the input.
 */
export function toInputSpecs (meta) {
  if (!Array.isArray(meta)) return []
  const typeMap = {
    int: 'int',
    float: 'float',
    bool: 'bool',
    string: 'str',
    color: 'color',
    source: 'source',
    timeframe: 'timeframe',
    symbol: 'symbol',
    session: 'session',
    price: 'price',
    time: 'time',
    enum: 'str',
    text_area: 'str'
  }
  return meta.map((entry) => {
    const title = String(entry?.title || entry?.name || '').trim()
    const type = typeMap[entry?.type] || 'str'
    return {
      name: title || String(entry?.varId || entry?.id || ''),
      pineVarId: entry?.varId || '',
      pineInputId: entry?.id || '',
      type,
      defaultValue: entry?.defval,
      rawDefault: entry?.defval,
      description: String(entry?.tooltip || '').trim() || title,
      label: title || String(entry?.varId || ''),
      group: String(entry?.group || '').trim(),
      values: Array.isArray(entry?.options) ? entry.options : undefined,
      min: Number.isFinite(entry?.minval) ? entry.minval : undefined,
      max: Number.isFinite(entry?.maxval) ? entry.maxval : undefined,
      step: Number.isFinite(entry?.step) && entry.step > 0 ? entry.step : undefined
    }
  }).filter(spec => spec.name)
}

/**
 * Run a Pine script over the supplied bars and return drawable plots.
 *
 * `params` is keyed by the input titles `readPineInputs` reported, which is
 * also what the runtime accepts. A value the script never declares is ignored
 * by the runtime rather than injected, so a stale override cannot change
 * behaviour behind the author's back.
 */
export async function runPineStudy ({ code, bars, symbol = 'BTC/USDT', timeframe = '1h', interval, params, loadBars }) {
  const original = String(code || '')
  if (!original.trim()) throw new Error('No Pine source to run')
  // A v2/v3/v4 script is translated before it runs, so the chart can draw the
  // old corpus instead of refusing it. The editor still shows the author's own
  // text: the upgrade is a runtime concern, not something to write back.
  const { code: source, upgraded, from, notes } = upgradeLegacyPine(original)
  const rows = (bars || []).filter(Boolean)
  if (!rows.length) throw new Error('No bars to run the script over')
  // Imported here rather than at module scope: the runtime is large and a chart
  // with no Pine studies should not pay for it.
  const { PineTS, Indicator } = await import('pinets')
  const ticker = String(symbol || 'BTC/USDT')
  const period = String(interval || timeframe || '1h')
  const indicator = new Indicator(source)
  const overrides = normaliseInputOverrides(params)
  if (overrides) {
    indicator.prepare()
    // The runtime keys overrides by input id, variable id or exact title, and
    // titles are matched loosely nowhere: a declaration such as
    // `input.int(14, "  Padded  ")` keeps its spaces, so a title captured from
    // a form that trimmed them would silently not apply. Resolving to the id
    // first also disambiguates two inputs that share a title.
    const byId = resolveOverrideIds(indicator.getInputsMeta(), overrides)
    for (const [key, value] of byId) {
      try {
        indicator.input[key] = value
      } catch (_error) {
        // An override for an input the script no longer declares is stale, not
        // fatal: the script still runs with its own default.
      }
    }
  }
  const runtime = new PineTS(
    loadBars ? createBarProvider({ bars: rows, symbol: ticker, timeframe: period, loadBars }) : rows,
    ticker,
    period
  )
  // Installed only when the script imports something: an unimporting script
  // must not pay for a resolver call, and a broken resolver must never be able
  // to break a script that does not need one.
  if (IMPORT_RE.test(source)) runtime.setImportResolver(pineImportResolver())
  let context
  let repairedFor = ''
  try {
    context = await runtime.run(indicator)
  } catch (error) {
    // One retry, only for the destructuring limitation described on
    // `repairTupleDestructuring`. A script that ran is never rewritten, so the
    // 140-odd scripts that work today keep running byte-identically.
    if (!DYNAMIC_ACCESS_RE.test(String(error && error.message || error))) throw error
    const repaired = repairTupleDestructuring(source)
    if (!repaired.repaired) throw error
    const retry = new Indicator(repaired.code)
    if (overrides) {
      retry.prepare()
      for (const [key, value] of resolveOverrideIds(retry.getInputsMeta(), overrides)) {
        try {
          retry.input[key] = value
        } catch (_error) { /* stale override, as above */ }
      }
    }
    const retryRuntime = new PineTS(
      loadBars ? createBarProvider({ bars: rows, symbol: ticker, timeframe: period, loadBars }) : rows,
      ticker,
      period
    )
    if (IMPORT_RE.test(repaired.code)) retryRuntime.setImportResolver(pineImportResolver())
    context = await retryRuntime.run(retry)
    repairedFor = 'tuple-destructuring'
  }
  return {
    plots: plotsFromPine(context?.plots),
    // Pine has no separate signal channel; the strategy side reads them, and
    // the chart study has never drawn them.
    signals: [],
    candleTimes: rows.map(row => row.time),
    // Reported so the UI can say "read as v4" instead of silently showing a
    // different line than the one the source spells.
    upgrade: upgraded ? { from, notes } : null,
    // Set when the runtime needed the script rewritten before it would run.
    repaired: repairedFor
  }
}

/**
 * A PineTS market-data provider backed by the caller's bar loader.
 *
 * `request.security` is the one built-in that needs bars the caller did not
 * supply: it opens a secondary context for the other timeframe and asks its
 * data source for them. The array constructor cannot answer that call, so a
 * script reading a higher timeframe produced all-`na` plots and looked broken
 * while its source was perfectly valid.
 *
 * Bars must keep the runtime's Kline shape (`openTime`/`closeTime` as numbers)
 * because the alignment against the primary series reads those fields; the
 * `time` key alone is not enough.
 */
function createBarProvider ({ bars, symbol, timeframe, loadBars }) {
  return {
    configure () {},
    async getSymbolInfo () {
      return {
        tickerid: symbol,
        ticker: symbol,
        description: symbol,
        timezone: 'UTC',
        type: 'crypto',
        session: '24x7',
        minmove: 1,
        mintick: 0.01,
        pricescale: 100
      }
    },
    async getMarketData (_tickerId, requested) {
      const wanted = String(requested || '')
      // The primary series is already in hand; asking for it again would be a
      // wasted round trip and would also lose the exact window the chart is on.
      if (!wanted || wanted === timeframe) return toKlines(bars)
      const loaded = await loadBars({ timeframe: wanted })
      return toKlines(loaded || [])
    }
  }
}

/**
 * The bar shape the runtime's data source returns.
 *
 * A provider's rows are consumed by the alignment code, which needs each bar's
 * open and close timestamps. The close is derived from the neighbouring bar
 * rather than assumed: `1D` and `1h` bars are not the same length, and a fixed
 * guess would silently clip or overlap them.
 */
function toKlines (bars) {
  const rows = (bars || []).filter(Boolean)
  const spans = rows.map((bar, index) => {
    const explicit = Number(bar?.closeTime)
    if (Number.isFinite(explicit) && explicit > 0) return null
    const current = Number(bar?.time ?? bar?.openTime) || 0
    const next = Number(rows[index + 1]?.time ?? rows[index + 1]?.openTime) || 0
    return next > current ? next - current : 60000
  })
  return rows.map((bar, index) => {
    const openTime = Number(bar?.time ?? bar?.openTime) || 0
    const explicit = Number(bar?.closeTime)
    const closeTime = Number.isFinite(explicit) && explicit > 0
      ? explicit
      : openTime + spans[index] - 1
    return {
      openTime,
      open: Number(bar?.open) || 0,
      high: Number(bar?.high) || 0,
      low: Number(bar?.low) || 0,
      close: Number(bar?.close) || 0,
      volume: Number(bar?.volume) || 0,
      closeTime,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      ignore: 0
    }
  })
}

/**
 * Pair each override with the runtime key that will actually be honoured.
 *
 * The accepted keys are the input id (`in_N`), the variable the declaration is
 * assigned to, or the exact title. Callers hold one of those three, so all
 * three are tried, in that order of precision; a key that matches nothing is
 * still passed through so the runtime can ignore it (and so a typo stays
 * visible in a debugger rather than vanishing here).
 */
function resolveOverrideIds (meta, overrides) {
  const entries = Array.isArray(meta) ? meta : []
  const index = new Map()
  for (const entry of entries) {
    const id = String(entry?.id || '')
    if (!id) continue
    for (const candidate of [entry?.id, entry?.varId, entry?.title, entry?.name]) {
      const key = String(candidate ?? '')
      if (!key) continue
      if (!index.has(key)) index.set(key, id)
      // A title that differs only in surrounding whitespace must still resolve:
      // the IDE's parser trims titles for display.
      const trimmed = key.trim()
      if (trimmed && !index.has(trimmed)) index.set(trimmed, id)
    }
  }
  return Object.entries(overrides).map(([key, value]) => [index.get(key) || key, value])
}

/** Drop empty overrides so a blank field does not shadow the script default. */
function normaliseInputOverrides (params) {
  if (!params || typeof params !== 'object') return null
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return Object.keys(out).length ? out : null
}
