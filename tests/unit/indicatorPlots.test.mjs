/**
 * Indicator replay onto the Charting Library.
 *
 * Three things matter here and all of them are about not lying to the user:
 *
 * 1. an indicator may be drawn with per-point colours, and dropping them turns a
 *    coloured regime ribbon into a flat line that reads as a different study;
 * 2. a point the indicator left undefined must stay a gap. Filling it with the
 *    previous value would fabricate data the user never asked for;
 * 3. the values must land on the bars they were computed for. The library
 *    appends live bars and prepends older ones while the study keeps being
 *    called, so a replay keyed on call order drifts -- an extra bar at the end
 *    walks off the array and a scroll-back draws the whole line shifted. Both
 *    failures look like a plausible chart and are therefore worse than a crash.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// indicatorPlots imports `@/utils/request`, which needs the Vite alias table and
// a DOM. Only the pure helpers are exercised here, so the module is re-created
// with the import stripped -- the same trick the datafeed discussion settled on.
// The stub reads `globalThis.__qdRequest` when a test installs one, which is how
// the fetch path is exercised without a network or an axios mock.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../../src/charting/indicatorPlots.js', import.meta.url), 'utf8')
const stubbed = source
  .replace(
    /^import request from '@\/utils\/request'$/m,
    'const request = (...args) => (globalThis.__qdRequest || (async () => ({ data: null })))(...args)'
  )
  // The Pine runtime is a sibling import with no alias, but it also pulls in the
  // real `pinets` package, which these tests do not need: what they exercise is
  // the replay contract and the wiring, not the interpreter. The stub keeps the
  // same surface and resolves `globalThis.__qdPine` on every call, so a test can
  // swap in its own runtime without reloading the module.
  .replace(
    /^import \{[\s\S]*?\} from '\.\/pineRuntime'$/m,
    [
      'const qdPine = () => globalThis.__qdPine || {',
      '  runPineStudy: async () => ({ plots: [], signals: [], candleTimes: [] })',
      '}',
      'const DEFAULT_STUDY_BARS = 1500',
      'const MAX_STUDY_BARS = 20000',
      'const runPineStudy = (...args) => qdPine().runPineStudy(...args)',
      'const toPineBar = (row) => {',
      '  const time = Number(row?.time)',
      '  if (!Number.isFinite(time) || time <= 0) return null',
      '  const open = Number(row.open); const high = Number(row.high)',
      '  const low = Number(row.low); const close = Number(row.close)',
      '  if (![open, high, low, close].every(Number.isFinite)) return null',
      '  return { time: time > 1e11 ? time : time * 1000, open, high, low, close, volume: Number(row.volume) || 0 }',
      '}'
    ].join('\n')
  )
const modulePath = join(tmpdir(), `qd_indicatorPlots_${process.pid}.mjs`)
writeFileSync(modulePath, stubbed)
const plots = await import(pathToFileURL(modulePath).href)

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const START = Date.UTC(2024, 0, 2, 9, 0, 0)

/** Candle open times in milliseconds, evenly spaced. */
function candleTimesMs (count, { start = START, step = HOUR } = {}) {
  return Array.from({ length: count }, (_unused, index) => start + index * step)
}

/**
 * A stand-in for the context the library hands `main`.
 *
 * Its real shape is `{ symbol: <ISymbolInstrument> }` with the running bar on
 * `symbol.time` -- see `barTimeCandidates`. This helper is deliberately that
 * shape only, so a test that passes proves the code reads exactly what the
 * library provides.
 */
function ctxAt (timeMs) {
  return { symbol: { time: timeMs } }
}

/** A study over `values`, keyed to `candleTimesMs`, ready to be asked for bars. */
function studyOver ({ values, times, extra = {} }) {
  return plots.buildCustomIndicator({
    indicatorId: 1,
    name: 'X',
    key: 'k',
    series: [{ kind: 'line', name: 'X', values, overlay: true }],
    candleTimes: times,
    ...extra
  })
}

/**
 * Run one resolve with a stub market-data response and Pine runtime.
 *
 * The study path has two inputs now: the bars, which come from the candles
 * endpoint, and the plots, which come from executing the script. `candles: null`
 * stands for an endpoint that answered nothing, and `plots: null` for a runtime
 * that produced nothing -- both must surface as a reported failure rather than
 * an empty chart with no explanation.
 */
async function withStudy ({ candles = null, plots = null, run }) {
  globalThis.__qdRequest = async () => ({ data: candles })
  if (plots) globalThis.__qdPine = { runPineStudy: async () => plots }
  try {
    return await run()
  } finally {
    delete globalThis.__qdRequest
    delete globalThis.__qdPine
  }
}

/** Candles shaped like `/api/market-data/candles` answers them: seconds. */
function candleRows (times) {
  return times.map((time, index) => ({
    time: time / 1000,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1000
  }))
}

describe('normalizePlots', () => {
  it('reduces scalar points to plain numbers', () => {
    const series = plots.normalizePlots([
      { name: 'EMA', type: 'line', overlay: true, data: [1, 2, null, 4] }
    ])
    assert.equal(series.length, 1)
    assert.deepEqual(series[0].values, [1, 2, null, 4])
    assert.equal(series[0].overlay, true)
  })

  it('keeps per-point colours, because dropping them changes the study', () => {
    const series = plots.normalizePlots([
      {
        name: 'Ribbon',
        type: 'line',
        data: [
          { value: 1, color: '#22C55E' },
          { value: 2, color: '#EF4444' },
          null
        ]
      }
    ])
    assert.deepEqual(series[0].values, [1, 2, null])
    assert.deepEqual(series[0].colors, ['#22C55E', '#EF4444', null])
  })

  it('splits a cloud into both of its edges', () => {
    const series = plots.normalizePlots([
      {
        name: 'Trend cloud',
        type: 'cloud',
        data: [{ upper: 10, lower: 8 }, { top: 12, bottom: 9 }, null]
      }
    ])
    assert.equal(series[0].kind, 'cloud')
    assert.deepEqual(series[0].upper, [10, 12, null])
    assert.deepEqual(series[0].lower, [8, 9, null])
    // A cloud drawn as one line would look like a different indicator.
    assert.equal(series[0].values, undefined)
  })

  it('detects a cloud from its point shape when the type is missing', () => {
    const series = plots.normalizePlots([
      { name: 'Band', data: [{ upper: 3, lower: 1 }] }
    ])
    assert.equal(series[0].kind, 'cloud')
  })

  it('marks bar plots so they are not drawn as a line', () => {
    const series = plots.normalizePlots([{ name: 'Volume', type: 'bar', data: [1, 2] }])
    assert.equal(series[0].kind, 'bar')
  })

  it('drops plots that cannot be labelled or are not objects', () => {
    const series = plots.normalizePlots([null, 'x', { data: [1] }, { name: 'ok', data: [1] }])
    assert.equal(series.length, 1)
    assert.equal(series[0].name, 'ok')
  })

  it('treats a non-array as empty rather than throwing', () => {
    assert.deepEqual(plots.normalizePlots(undefined), [])
    assert.deepEqual(plots.normalizePlots({}), [])
  })
})

describe('barTimeMs', () => {
  it('reads the backend second-based times as milliseconds', () => {
    // The preview route divides milliseconds by 1000 before serialising, so
    // every candle time from the API is in seconds.
    assert.equal(plots.barTimeMs(1704186000), 1704186000000)
  })

  it('leaves a value that is already in milliseconds alone', () => {
    assert.equal(plots.barTimeMs(1704186000000), 1704186000000)
  })

  it('treats what cannot be a time as missing', () => {
    assert.equal(plots.barTimeMs(null), null)
    assert.equal(plots.barTimeMs(undefined), null)
    assert.equal(plots.barTimeMs(''), null)
    assert.equal(plots.barTimeMs('nope'), null)
    assert.equal(plots.barTimeMs(0), null)
    assert.equal(plots.barTimeMs(-5), null)
    assert.equal(plots.barTimeMs(Number.NaN), null)
  })
})

describe('barTimeCandidates', () => {
  it('reads the running bar time off the context symbol', () => {
    assert.deepEqual(plots.barTimeCandidates(ctxAt(START)), [START])
  })

  it('falls back to the documented bartime() accessor', () => {
    // `symbol.time` missing is not hypothetical: it is NaN before the first bar.
    const ctx = { symbol: { bartime: () => START } }
    assert.deepEqual(plots.barTimeCandidates(ctx), [START])
  })

  it('offers both when they disagree, because DWM realigns one of them', () => {
    const ctx = { symbol: { time: START, bartime: () => START + HOUR } }
    assert.deepEqual(plots.barTimeCandidates(ctx), [START, START + HOUR])
  })

  it('returns nothing for a context with no bar yet', () => {
    // This is the construction call, before any bar is loaded.
    assert.deepEqual(plots.barTimeCandidates({ symbol: { time: Number.NaN } }), [])
    assert.deepEqual(plots.barTimeCandidates({}), [])
    assert.deepEqual(plots.barTimeCandidates(null), [])
  })

  it('survives a bartime() that throws, because no session is set up yet', () => {
    const ctx = {
      symbol: {
        bartime: () => {
          throw new Error('no session')
        }
      }
    }
    assert.deepEqual(plots.barTimeCandidates(ctx), [])
  })
})

describe('buildBarTimeIndex', () => {
  const times = candleTimesMs(3)

  it('keys values by the bar time they were computed for', () => {
    const index = plots.buildBarTimeIndex({
      plotSpecs: [{ name: 'X', values: [10, 20, 30] }],
      candleTimes: times
    })
    assert.equal(index.size, 3)
    assert.deepEqual(index.at(times[2]), [30])
    // A time the preview never covered is absent, not the nearest value.
    assert.equal(index.at(times[2] + HOUR), null)
    assert.equal(index.at(Number.NaN), null)
  })

  it('does not let a backfilled hole borrow a neighbour', () => {
    const index = plots.buildBarTimeIndex({
      plotSpecs: [{ name: 'X', values: [10, null, 30] }],
      candleTimes: times
    })
    assert.ok(Number.isNaN(index.at(times[1])[0]))
  })

  it('accepts second-based candle times from the API', () => {
    const index = plots.buildBarTimeIndex({
      plotSpecs: [{ name: 'X', values: [7] }],
      candleTimes: [times[0] / 1000]
    })
    assert.deepEqual(index.at(times[0]), [7])
  })

  it('keeps each value attached to its own bar time when the input is unsorted', () => {
    // Values are 1:1 with the times array, so an unsorted times array means
    // value 10 belongs to the bar at times[2]. Sorting for lookup must not
    // re-order the values it points at -- that would relabel every bar.
    const index = plots.buildBarTimeIndex({
      plotSpecs: [{ name: 'X', values: [10, 20, 30] }],
      candleTimes: [times[2], times[0], times[1]]
    })
    assert.deepEqual(index.at(times[2]), [10])
    assert.deepEqual(index.at(times[0]), [20])
    assert.deepEqual(index.at(times[1]), [30])
  })

  it('is empty rather than broken without candle times', () => {
    const index = plots.buildBarTimeIndex({ plotSpecs: [{ name: 'X', values: [1] }] })
    assert.equal(index.size, 0)
    assert.equal(index.at(Date.now()), null)
  })

  it('buckets a daily series by UTC day, because the library realigns DWM bars', () => {
    const daily = candleTimesMs(3, { step: 24 * HOUR })
    const index = plots.buildBarTimeIndex({
      plotSpecs: [{ name: 'X', values: [10, 20, 30] }],
      candleTimes: daily
    })
    assert.equal(index.daily, true)
    // The library reports a session-aligned time for a daily bar; the backend
    // reported the raw open. Same day, so it is the same bar.
    assert.deepEqual(index.at(daily[1] + 5 * HOUR), [20])
  })

  it('never bucket-matches an intraday series', () => {
    const index = plots.buildBarTimeIndex({
      plotSpecs: [{ name: 'X', values: [10, 20, 30] }],
      candleTimes: times
    })
    assert.equal(index.daily, false)
    // Same day, different bar: a day bucket here would invent a value.
    assert.equal(index.at(times[0] + 30 * MINUTE), null)
  })
})

describe('seriesKey', () => {
  it('separates the same indicator across symbol and timeframe', () => {
    const base = { indicatorId: 7, market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H' }
    const other = { ...base, symbol: 'ETH/USDT' }
    assert.notEqual(plots.seriesKey(base), plots.seriesKey(other))
    // Replaying another pair's numbers would draw a plausible, false line.
    assert.match(plots.seriesKey(base), /^7\|Crypto\|BTC\/USDT\|1H\|\|$/)
  })

  it('keeps an unsaved draft apart from the saved row behind the same id', () => {
    const base = { indicatorId: 7, market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H' }
    const draft = { ...base, revision: plots.draftRevision('plot(close)') }
    // An editor preview must not be served from the stored indicator's entry,
    // or the first look at a draft shows the previous version's lines.
    assert.notEqual(plots.seriesKey(base), plots.seriesKey(draft))
    assert.match(plots.seriesKey(draft), /^7\|Crypto\|BTC\/USDT\|1H\|[a-z0-9]+\|$/)
  })

  it('gives two different drafts different revisions', () => {
    assert.notEqual(plots.draftRevision('plot(close)'), plots.draftRevision('plot(open)'))
    assert.equal(plots.draftRevision('plot(close)'), plots.draftRevision('plot(close)'))
  })
})

describe('buildCustomIndicator', () => {
  const times = candleTimesMs(3)

  it('reports overlay placement from the primary plot', () => {
    const study = plots.buildCustomIndicator({
      indicatorId: 3,
      name: 'EMA cross',
      key: 'k',
      series: [{ kind: 'line', name: 'EMA', values: [1, 2], overlay: true }],
      candleTimes: times
    })
    assert.equal(study.metainfo.overlay, true)
    assert.equal(study.metainfo.is_price_study, true)
    assert.equal(study.metainfo.id, 'qd_indicator_3')
    assert.equal(study.metainfo.name, 'EMA cross')
    assert.equal(typeof study.constructor, 'function')
  })

  it('puts a pane study on its own pane', () => {
    const study = plots.buildCustomIndicator({
      indicatorId: 4,
      name: 'RSI',
      key: 'k',
      series: [{ kind: 'line', name: 'RSI', values: [50], overlay: false }],
      candleTimes: times
    })
    assert.equal(study.metainfo.overlay, false)
  })

  it('returns the value computed for the bar the library is asking about', () => {
    const study = studyOver({ values: [10, 20, 30], times })
    const instance = new study.constructor()
    assert.deepEqual(instance.main(ctxAt(times[0])), [10])
    assert.deepEqual(instance.main(ctxAt(times[1])), [20])
    assert.deepEqual(instance.main(ctxAt(times[2])), [30])
  })

  it('is a lookup, not a cursor: asking again returns the same bar', () => {
    const study = studyOver({ values: [10, 20, 30], times })
    const instance = new study.constructor()
    // A recalculation and a redraw both re-ask for bars already seen. A cursor
    // would hand back the next value here and shift everything after it.
    assert.deepEqual(instance.main(ctxAt(times[0])), [10])
    assert.deepEqual(instance.main(ctxAt(times[0])), [10])
    assert.deepEqual(instance.main(ctxAt(times[1])), [20])
    assert.deepEqual(instance.main(ctxAt(times[0])), [10])
  })

  it('keeps an undefined point a gap instead of carrying a value forward', () => {
    const study = studyOver({ values: [10, null, 30], times })
    const instance = new study.constructor()
    const row = instance.main(ctxAt(times[1]))
    assert.equal(row.length, 1)
    // NaN is the library's "no value here"; undefined would be read as a break
    // too, but it also breaks arithmetic on the result.
    assert.ok(Number.isNaN(row[0]))
  })

  it('answers a live bar past the end with a gap, not a crash', () => {
    // The socket appends the forming candle and the library asks for it. This is
    // the failure the cursor design could not survive: one more call than there
    // were precomputed values.
    const study = studyOver({ values: [10, 20, 30], times })
    const instance = new study.constructor()
    for (const time of times) instance.main(ctxAt(time))
    const live = instance.main(ctxAt(times[2] + HOUR))
    assert.equal(live.length, 1)
    assert.ok(Number.isNaN(live[0]))
    // The bar before it still has its own value: a live bar must not consume it.
    assert.deepEqual(instance.main(ctxAt(times[2])), [30])
  })

  it('does not let a scroll-back shift the line', () => {
    const study = studyOver({ values: [10, 20, 30], times })
    // Scrolling left loads older bars and the library replays the study against
    // a window that now starts before the fetched one. The cursor started again
    // at zero here, so the whole line moved left by the number of prepended bars.
    const prepended = candleTimesMs(3, { start: START - 3 * HOUR })
    const instance = new study.constructor()
    const got = [...prepended, ...times].map(time => instance.main(ctxAt(time))[0])
    // The older bars are gaps and the original bars kept their own values. Under
    // the cursor this would have been [10, 20, 30, NaN, NaN, NaN].
    assert.deepEqual(got, [Number.NaN, Number.NaN, Number.NaN, 10, 20, 30])
  })

  it('spends no precomputed value on the call the library makes before any bar', () => {
    // `Mv.init` runs the study's init and then one `main` at construction, when
    // `symbol.time` is NaN. The cursor spent the first value on that call, so
    // every bar was drawn with the next bar's number.
    const study = studyOver({ values: [10, 20, 30], times })
    const instance = new study.constructor()
    const construction = instance.main({ symbol: { time: Number.NaN } })
    assert.equal(construction.length, 1)
    assert.ok(Number.isNaN(construction[0]))
    assert.deepEqual(instance.main(ctxAt(times[0])), [10])
  })

  it('has no init hook, because a time-keyed lookup has nothing to restart', () => {
    const study = studyOver({ values: [1], times })
    // `init?` is optional in the contract; leaving it out is the honest signal
    // that no state carries between calculation runs.
    assert.equal(study.constructor.prototype.init, undefined)
    assert.equal(typeof study.constructor.prototype.main, 'function')
  })

  it('gives a cloud two plots so both edges reach the chart', () => {
    const study = plots.buildCustomIndicator({
      indicatorId: 7,
      name: 'Band',
      key: 'k',
      series: [{ kind: 'cloud', name: 'Band', upper: [5, 6], lower: [3, 4] }],
      candleTimes: times.slice(0, 2)
    })
    assert.equal(study.metainfo.plots.length, 2)
    const instance = new study.constructor()
    assert.deepEqual(instance.main(ctxAt(times[0])), [5, 3])
    assert.deepEqual(instance.main(ctxAt(times[1])), [6, 4])
  })

  it('keeps a per-point colour array on the series it publishes', () => {
    // The colours drive a coloured ribbon; only the numeric channel is replayed,
    // so the colour channel has to survive on the descriptor.
    const series = plots.normalizePlots([
      { name: 'Ribbon', type: 'line', data: [{ value: 1, color: '#22C55E' }, { value: 2, color: '#EF4444' }] }
    ])
    const study = plots.buildCustomIndicator({
      indicatorId: 8,
      name: 'Ribbon',
      key: 'k',
      series,
      candleTimes: times.slice(0, 2)
    })
    assert.deepEqual(study.series[0].colors, ['#22C55E', '#EF4444'])
    assert.deepEqual(study.series[0].values, [1, 2])
    assert.deepEqual(new study.constructor().main(ctxAt(times[1])), [2])
  })
})

describe('plot kinds in the study contract', () => {
  const times = candleTimesMs(3)

  it('declares a shapes plot with the shape and location the script asked for', () => {
    const series = plots.normalizePlots([
      {
        name: 'Up',
        kind: 'shape',
        shape: 'shape_triangle_up',
        location: 'BelowBar',
        color: '#00e676',
        textColor: '#FFFFFF',
        text: 'BUY',
        data: [null, 1, null]
      }
    ])
    const study = plots.buildCustomIndicator({ indicatorId: 11, name: 'Markers', key: 'k', series, candleTimes: times })
    assert.deepEqual(study.metainfo.plots, [{ id: 'plot_0', type: 'shapes' }])
    assert.equal(study.metainfo.defaults.styles.plot_0.plottype, 'shape_triangle_up')
    assert.equal(study.metainfo.defaults.styles.plot_0.location, 'BelowBar')
    // The value is 1 on the bar that fires and a gap everywhere else.
    const instance = new study.constructor()
    assert.deepEqual(instance.main(ctxAt(times[1])), [1])
    assert.ok(Number.isNaN(instance.main(ctxAt(times[0]))[0]))
  })

  it('declares four OHLC plots for a candle drawing', () => {
    // The library reads one value per declared plot, so a candle has to be
    // declared as open/high/low/close or three of the four prices vanish.
    const series = plots.normalizePlots([
      {
        name: 'Candles',
        kind: 'candle',
        color: '#4CAF50',
        data: [{ open: 10, high: 12, low: 9, close: 11 }, null]
      }
    ])
    const study = plots.buildCustomIndicator({ indicatorId: 12, name: 'Candles', key: 'k', series, candleTimes: times.slice(0, 2) })
    assert.deepEqual(study.metainfo.plots.map(plot => plot.type), ['ohlc_open', 'ohlc_high', 'ohlc_low', 'ohlc_close'])
    assert.equal(study.metainfo.plots[0].target, 'plotcandle_0')
    assert.equal(study.metainfo.ohlcPlots.plotcandle_0.title, 'Candles')
    const instance = new study.constructor()
    assert.deepEqual(instance.main(ctxAt(times[0])), [10, 12, 9, 11])
  })

  it('declares a colourer plot with a palette built from the colours used', () => {
    const series = plots.normalizePlots([
      { name: 'Bar colour', kind: 'barcolor', colors: ['#2962FF', null, '#EF4444'] }
    ])
    const study = plots.buildCustomIndicator({ indicatorId: 13, name: 'Bars', key: 'k', series, candleTimes: times })
    assert.equal(study.metainfo.plots[0].type, 'bar_colorer')
    const palette = study.metainfo.palettes.palette_0
    assert.equal(palette.colors.length, 2)
    // Values are 1-based so index 0 is free: a bar the script never coloured
    // must not share a palette entry with the first real colour.
    assert.deepEqual(Object.keys(palette.valToIndex), ['1', '2'])
    const instance = new study.constructor()
    assert.deepEqual(instance.main(ctxAt(times[0])), [1])
    assert.deepEqual(instance.main(ctxAt(times[2])), [2])
    // An uncoloured bar answers NaN, which the library reads as "no colour"
    // rather than as palette entry zero.
    assert.ok(Number.isNaN(instance.main(ctxAt(times[1]))[0]))
  })

  it('fills between two named plots', () => {
    const series = plots.normalizePlots([
      { name: 'A', kind: 'line', data: [5, 6] },
      { name: 'B', kind: 'line', data: [3, 4] },
      { name: 'Fill A / B', kind: 'fill', plot1: 'A', plot2: 'B', color: '#2962FF33' }
    ])
    const study = plots.buildCustomIndicator({ indicatorId: 14, name: 'Band', key: 'k', series, candleTimes: times.slice(0, 2) })
    assert.equal(study.metainfo.filledAreas.length, 1)
    assert.equal(study.metainfo.filledAreas[0].objAId, 'plot_0')
    assert.equal(study.metainfo.filledAreas[0].objBId, 'plot_1')
    assert.equal(study.metainfo.defaults.filledAreasStyle.fill_0.color, '#2962FF33')
  })

  it('drops a fill whose sides were never declared', () => {
    const series = plots.normalizePlots([
      { name: 'A', kind: 'line', data: [5] },
      { name: 'Fill A / Missing', kind: 'fill', plot1: 'A', plot2: 'Missing' }
    ])
    const study = plots.buildCustomIndicator({ indicatorId: 15, name: 'Half', key: 'k', series, candleTimes: times.slice(0, 1) })
    assert.equal(study.metainfo.filledAreas, undefined)
    assert.equal(study.metainfo.plots.length, 1)
  })

  it('passes the line style through to the plot defaults', () => {
    const series = plots.normalizePlots([
      { name: 'Hist', kind: 'line', style: { plottype: 1 }, data: [1, 2] }
    ])
    const study = plots.buildCustomIndicator({ indicatorId: 16, name: 'Hist', key: 'k', series, candleTimes: times.slice(0, 2) })
    assert.equal(study.metainfo.defaults.styles.plot_0.plottype, 1)
  })
})

describe('resolveCustomIndicators', () => {
  it('reports a failing indicator instead of taking the chart down', async () => {
    const cache = plots.createSeriesCache()
    const result = await plots.resolveCustomIndicators({
      indicators: [{ indicatorId: 1, name: 'Empty', code: '//@version=5\nindicator("x")\nplot(close)' }],
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache
    })
    // The stub request returns no bars, so the study cannot run. The chart still
    // draws its own candles; the failure is reported, not propagated.
    assert.deepEqual(result.indicators, [])
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].indicatorId, 1)
    assert.match(result.failures[0].reason, /No bars for/)
  })

  it('ignores entries without an id', async () => {
    const built = await plots.resolveCustomIndicators({
      indicators: [{}, { name: 'no id' }],
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache: plots.createSeriesCache()
    })
    assert.deepEqual(built.indicators, [])
    assert.deepEqual(built.failures, [])
  })

  it('caches the bar times with the plots they belong to', async () => {
    const times = candleTimesMs(3)
    const cache = plots.createSeriesCache()
    const code = '//@version=5\nindicator("e")\nplot(close)'
    const run = () => plots.resolveCustomIndicators({
      indicators: [{ indicatorId: 2, name: 'EMA', code }],
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache
    })
    const first = await withStudy({
      candles: candleRows(times),
      plots: {
        plots: [{ name: 'EMA', type: 'line', overlay: true, data: [10, 20, 30] }],
        signals: [],
        candleTimes: times
      },
      run
    })
    assert.equal(first.indicators.length, 1)
    // Without the times the cached plots are an ordered list with no link back
    // to the bars, and every bar of a cached study would be a gap.
    // The key carries the draft revision: an edited buffer is a different
    // program and must not share the saved row's entry.
    const cached = cache.get(plots.seriesKey({
      indicatorId: 2,
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      revision: plots.draftRevision(code)
    }))
    assert.deepEqual(cached.candleTimes, times)
    assert.equal(cached.plots.length, 1)

    // A second resolve is served from the cache and still replays correctly.
    const second = await withStudy({ candles: null, run })
    assert.equal(second.indicators.length, 1)
    assert.deepEqual(new second.indicators[0].constructor().main(ctxAt(times[1])), [20])
  })

  it('tolerates a cache seeded with a bare plot array', async () => {
    const cache = plots.createSeriesCache()
    cache.set(
      plots.seriesKey({ indicatorId: 5, market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H' }),
      [{ kind: 'line', name: 'X', values: [1], overlay: true }]
    )
    const built = await plots.resolveCustomIndicators({
      indicators: [{ indicatorId: 5, name: 'X' }],
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache
    })
    // No bar times is not an error; it just means the study draws gaps.
    assert.equal(built.indicators.length, 1)
    const instance = new built.indicators[0].constructor()
    assert.ok(Number.isNaN(instance.main(ctxAt(START))[0]))
  })

  it('replays a real study onto the bar times it was computed for', async () => {
    // The end-to-end shape of the defect: a computed window, then a live bar.
    const times = candleTimesMs(4)
    const built = await withStudy({
      candles: candleRows(times),
      plots: {
        plots: [{ name: 'EMA', type: 'line', overlay: true, data: [10, 20, 30, 40] }],
        signals: [],
        candleTimes: times
      },
      run: () => plots.resolveCustomIndicators({
        indicators: [{ indicatorId: 9, name: 'EMA', code: '//@version=5\nindicator("e")\nplot(close)' }],
        market: 'Crypto',
        symbol: 'BTC/USDT',
        timeframe: '1H',
        cache: plots.createSeriesCache()
      })
    })
    const instance = new built.indicators[0].constructor()
    assert.deepEqual(times.map(time => instance.main(ctxAt(time))[0]), [10, 20, 30, 40])
    // The forming candle the socket pushed: no computed value exists yet.
    assert.ok(Number.isNaN(instance.main(ctxAt(times[3] + HOUR))[0]))
    // Older bar loaded by a scroll-back: also outside the computed window.
    assert.ok(Number.isNaN(instance.main(ctxAt(times[0] - HOUR))[0]))
    // And neither of those disturbed the bars that were computed.
    assert.deepEqual(times.map(time => instance.main(ctxAt(time))[0]), [10, 20, 30, 40])
  })
})

describe('replay design', () => {
  it('no longer counts its own invocations', () => {
    // The defect was a self-incrementing cursor on the study instance.
    assert.doesNotMatch(source, /__qdIndex/)
    assert.doesNotMatch(source, /values\[index\]/)
  })

  it('keys the replay on the bar time from the context', () => {
    assert.match(source, /Study\.prototype\.main = function \(ctx\)/)
    assert.match(source, /barTimeCandidates\(ctx\)/)
    assert.match(source, /buildBarTimeIndex/)
  })

  it('indexes the plots against the candle times the preview returned', () => {
    // `candleTimes` used to be fetched and then ignored, which is what made an
    // ordinal replay the only option.
    assert.match(source, /candleTimes: result\.candleTimes/)
    assert.match(source, /buildBarTimeIndex\(\{ plotSpecs, candleTimes \}\)/)
    assert.match(source, /candleTimes: loaded\?\.candleTimes/)
  })
})

describe('createSeriesCache', () => {
  it('stores and clears', () => {
    const cache = plots.createSeriesCache()
    cache.set('a', [1])
    assert.deepEqual(cache.get('a'), [1])
    assert.equal(cache.size, 1)
    cache.clear()
    assert.equal(cache.size, 0)
  })
})

describe('createStudyBarCache', () => {
  /**
   * Install a request stub that answers with `bars` and counts its calls.
   *
   * The count is the assertion that matters: a cache that is not consulted looks
   * identical on screen, so only the call count distinguishes "one download
   * shared by five studies" from "five downloads".
   */
  function countRequests (bars) {
    const calls = []
    globalThis.__qdRequest = async (options) => {
      calls.push(options.params)
      return { data: bars }
    }
    return calls
  }

  const bars = Array.from({ length: 3 }, (_unused, index) => ({
    time: 1700000000 + index * 3600,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10
  }))

  it('downloads one series once however many studies ask for it', async () => {
    const calls = countRequests(bars)
    const cache = plots.createStudyBarCache()
    const args = { market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H', limit: 1500 }
    const [first, second, third] = await Promise.all([
      cache.load(args), cache.load(args), cache.load(args)
    ])
    assert.equal(calls.length, 1)
    assert.equal(first.length, 3)
    // The same array, not three equal copies: every study runs over one series.
    assert.equal(first, second)
    assert.equal(second, third)
  })

  it('downloads again for a different timeframe', async () => {
    const calls = countRequests(bars)
    const cache = plots.createStudyBarCache()
    await cache.load({ market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H', limit: 1500 })
    await cache.load({ market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1D', limit: 1500 })
    assert.equal(calls.length, 2)
  })

  it('retries a failed download instead of caching the failure', async () => {
    let attempts = 0
    globalThis.__qdRequest = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('network down')
      return { data: bars }
    }
    const cache = plots.createStudyBarCache()
    const args = { market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H', limit: 1500 }
    await assert.rejects(() => cache.load(args), /network down/)
    const recovered = await cache.load(args)
    assert.equal(attempts, 2)
    assert.equal(recovered.length, 3)
  })

  it('is keyed per venue, so spot and perpetual never share a series', async () => {
    const calls = countRequests(bars)
    const cache = plots.createStudyBarCache()
    await cache.load({ market: 'Crypto', symbol: 'BTC/USDT', timeframe: '4H', limit: 1500, marketType: 'spot' })
    await cache.load({ market: 'Crypto', symbol: 'BTC/USDT', timeframe: '4H', limit: 1500, marketType: 'swap' })
    assert.equal(calls.length, 2)
  })

  it('clears', async () => {
    countRequests(bars)
    const cache = plots.createStudyBarCache()
    await cache.load({ market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H', limit: 1500 })
    assert.equal(cache.size, 1)
    cache.clear()
    assert.equal(cache.size, 0)
  })
})

describe('resolveCustomIndicators', () => {
  it('fetches the shared series once for a whole set of studies', async () => {
    // Five checked indicators used to mean five 1500-bar downloads of the same
    // symbol, which is what made the first load look like a request storm.
    const calls = []
    globalThis.__qdRequest = async (options) => {
      calls.push(options.params)
      return {
        data: Array.from({ length: 5 }, (_unused, index) => ({
          time: 1700000000 + index * 3600,
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 10
        }))
      }
    }
    globalThis.__qdPine = {
      runPineStudy: async ({ code }) => ({
        plots: [{ name: code, values: [1, 2, 3, 4, 5], type: 'line' }],
        signals: [],
        candleTimes: [1700000000000, 1700003600000, 1700007200000, 1700010800000, 1700014400000]
      })
    }
    const indicators = Array.from({ length: 5 }, (_unused, index) => ({
      indicatorId: index + 1,
      name: `study ${index + 1}`,
      code: `//@version=6\nindicator("s${index + 1}")\nplot(close)`
    }))
    const result = await plots.resolveCustomIndicators({
      indicators,
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache: plots.createSeriesCache(),
      barCache: plots.createStudyBarCache()
    })
    assert.equal(calls.length, 1, 'one download for five studies')
    assert.equal(result.failures.length, 0)
    assert.equal(result.indicators.length, 5)
    // The checked order survives the parallel resolve.
    assert.deepEqual(
      result.indicators.map(item => item.name),
      ['study 1', 'study 2', 'study 3', 'study 4', 'study 5']
    )
  })

  it('sizes the download for the widest study in the set', async () => {
    const calls = []
    globalThis.__qdRequest = async (options) => {
      calls.push(options.params)
      return { data: [{ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] }
    }
    await plots.resolveCustomIndicators({
      indicators: [
        { indicatorId: 1, name: 'a', code: '//@version=6\nindicator("a")\nplot(close)' },
        { indicatorId: 2, name: 'b', code: '//@version=6\nindicator("b")\nplot(close)', limit: 3000 }
      ],
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache: plots.createSeriesCache(),
      barCache: plots.createStudyBarCache()
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].limit, 3000)
  })

  it('asks for nothing when there are no studies', async () => {
    const calls = []
    globalThis.__qdRequest = async (options) => {
      calls.push(options.params)
      return { data: [] }
    }
    const result = await plots.resolveCustomIndicators({
      indicators: [],
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache: plots.createSeriesCache(),
      barCache: plots.createStudyBarCache()
    })
    assert.equal(calls.length, 0)
    assert.deepEqual(result, { indicators: [], failures: [] })
  })
})

describe('seriesKey with input values', () => {
  it('separates two runs of one script that use different settings', () => {
    // A cached plot is the output of the script *and* its input values. Serving
    // the length=20 line after the author typed 50 would look like the input was
    // ignored, which is a worse bug than recomputing.
    const base = { indicatorId: 7, market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H' }
    const twenty = { ...base, params: plots.paramsFingerprint({ Length: 20 }) }
    const fifty = { ...base, params: plots.paramsFingerprint({ Length: 50 }) }
    assert.notEqual(plots.seriesKey(twenty), plots.seriesKey(fifty))
  })

  it('ignores the order the settings were written in', () => {
    // The panel builds its map from a form, so key order is whatever the DOM
    // produced; the same values must not look like a different run.
    assert.equal(
      plots.paramsFingerprint({ Length: 20, Source: 'close' }),
      plots.paramsFingerprint({ Source: 'close', Length: 20 })
    )
  })

  it('keeps values from running into each other', () => {
    // `{a: 'bc'}` and `{ab: 'c'}` concatenate to the same text without a
    // separator, which would let two different settings share a cache entry.
    assert.notEqual(
      plots.paramsFingerprint({ a: 'bc' }),
      plots.paramsFingerprint({ ab: 'c' })
    )
  })
})
