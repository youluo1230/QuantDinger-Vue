/**
 * Indicator replay onto the Charting Library.
 *
 * Two things matter here and both are about not lying to the user:
 *
 * 1. an indicator may be drawn with per-point colours, and dropping them turns a
 *    coloured regime ribbon into a flat line that reads as a different study;
 * 2. a point the indicator left undefined must stay a gap. Filling it with the
 *    previous value would fabricate data the user never asked for.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// indicatorPlots imports `@/utils/request`, which needs the Vite alias table and
// a DOM. Only the pure helpers are exercised here, so the module is re-created
// with the import stripped -- the same trick the datafeed discussion settled on.
import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../../src/charting/indicatorPlots.js', import.meta.url), 'utf8')
const stubbed = source.replace(
  /^import request from '@\/utils\/request'$/m,
  'const request = async () => ({ data: null })'
)
const modulePath = join(tmpdir(), `qd_indicatorPlots_${process.pid}.mjs`)
writeFileSync(modulePath, stubbed)
const plots = await import(pathToFileURL(modulePath).href)

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

describe('seriesKey', () => {
  it('separates the same indicator across symbol and timeframe', () => {
    const base = { indicatorId: 7, market: 'Crypto', symbol: 'BTC/USDT', timeframe: '1H' }
    const other = { ...base, symbol: 'ETH/USDT' }
    assert.notEqual(plots.seriesKey(base), plots.seriesKey(other))
    // Replaying another pair's numbers would draw a plausible, false line.
    assert.match(plots.seriesKey(base), /^7\|Crypto\|BTC\/USDT\|1H$/)
  })
})

describe('buildCustomIndicator', () => {
  it('reports overlay placement from the primary plot', () => {
    const study = plots.buildCustomIndicator({
      indicatorId: 3,
      name: 'EMA cross',
      key: 'k',
      series: [{ kind: 'line', name: 'EMA', values: [1, 2], overlay: true }]
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
      series: [{ kind: 'line', name: 'RSI', values: [50], overlay: false }]
    })
    assert.equal(study.metainfo.overlay, false)
  })

  it('replays values in call order and emits NaN for gaps', () => {
    const study = plots.buildCustomIndicator({
      indicatorId: 5,
      name: 'X',
      key: 'k',
      series: [{ kind: 'line', name: 'X', values: [10, null, 30], overlay: true }]
    })
    const seen = []
    const instance = new study.constructor()
    instance.__qdPlot = (name, value) => seen.push([name, value])
    instance.main()
    instance.main()
    instance.main()
    assert.equal(seen.length, 3)
    assert.deepEqual(seen[0], ['X', 10])
    // A gap must stay a gap; carrying the previous value forward would invent data.
    assert.ok(Number.isNaN(seen[1][1]))
    assert.deepEqual(seen[2], ['X', 30])
  })
})

describe('resolveCustomIndicators', () => {
  it('reports a failing indicator instead of taking the chart down', async () => {
    const cache = plots.createSeriesCache()
    const result = await plots.resolveCustomIndicators({
      indicators: [{ indicatorId: 1, name: 'Empty' }],
      market: 'Crypto',
      symbol: 'BTC/USDT',
      timeframe: '1H',
      cache
    })
    // The stub request returns no payload, so loadSeries throws. The chart still
    // draws its bars; the failure is reported, not propagated.
    assert.deepEqual(result.indicators, [])
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].indicatorId, 1)
    assert.match(result.failures[0].reason, /returned nothing/)
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
