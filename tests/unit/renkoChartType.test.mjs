import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildRenkoBricks, calculateRenkoBoxSize } from '../../src/utils/renko.mjs'
import { buildHeikinAshiRows, buildHlcAreaRows, buildRangeBars } from '../../src/utils/price-chart-transforms.mjs'

const indicatorIdePath = fileURLToPath(new URL('../../src/views/indicator-ide/index.vue', import.meta.url))
const klineChartPath = fileURLToPath(new URL('../../src/views/indicator-analysis/components/KlineChart.vue', import.meta.url))
const localePath = fileURLToPath(new URL('../../src/locales/chart-type-overrides.js', import.meta.url))
const indicatorIdeSource = fs.readFileSync(indicatorIdePath, 'utf8')
const klineChartSource = fs.readFileSync(klineChartPath, 'utf8')
const localeSource = fs.readFileSync(localePath, 'utf8')

function row (timestamp, close, volume = 10) {
  return {
    timestamp,
    open: close,
    high: close + 0.25,
    low: close - 0.25,
    close,
    volume
  }
}

test('Renko bricks use fixed boxes and require two boxes for a reversal', () => {
  const bricks = buildRenkoBricks([
    row(1_000, 100),
    row(2_000, 102.2),
    row(3_000, 103.2),
    row(4_000, 100.5)
  ], { boxSize: 1 })

  assert.deepEqual(bricks.map(item => [item.open, item.close]), [
    [100, 101],
    [101, 102],
    [102, 103],
    [102, 101]
  ])
  assert.ok(bricks.every((item, index) => index === 0 || item.timestamp > bricks[index - 1].timestamp))
})

test('automatic Renko box size is based on recent true range', () => {
  const rows = [
    row(1_000, 100),
    row(2_000, 101),
    row(3_000, 102),
    row(4_000, 104)
  ]
  const boxSize = calculateRenkoBoxSize(rows, 3)

  assert.ok(Number.isFinite(boxSize))
  assert.ok(boxSize > 0)
  assert.ok(buildRenkoBricks(rows, { atrLength: 3 }).length > 0)
})

test('derived chart types calculate real price series', () => {
  const rows = [
    { timestamp: 1_000, open: 10, high: 14, low: 8, close: 12, volume: 20 },
    { timestamp: 2_000, open: 12, high: 16, low: 10, close: 14, volume: 30 },
    { timestamp: 3_000, open: 14, high: 18, low: 12, close: 17, volume: 40 }
  ]
  const heikinAshi = buildHeikinAshiRows(rows)
  assert.equal(heikinAshi[0].open, 11)
  assert.equal(heikinAshi[0].close, 11)
  assert.equal(heikinAshi[1].open, 11)
  assert.equal(heikinAshi[1].close, 13)

  const hlc = buildHlcAreaRows(rows)
  assert.equal(hlc[0].close, (14 + 8 + 12) / 3)

  const rangeBars = buildRangeBars(rows, { rangeSize: 1 })
  assert.equal(rangeBars.length, 5)
  assert.ok(rangeBars.every(item => Math.abs(item.close - item.open) === 1))
  assert.ok(rangeBars.every((item, index) => index === 0 || item.timestamp > rangeBars[index - 1].timestamp))
})

test('indicator workspace exposes Renko and calculates indicators from displayed bricks', () => {
  assert.match(indicatorIdeSource, /supportedChartTypes = new Set\(\[[\s\S]*'renko'/)
  assert.match(indicatorIdeSource, /supportedChartTypes = new Set\(\[[\s\S]*'heikin_ashi'/)
  assert.match(indicatorIdeSource, /supportedChartTypes = new Set\(\[[\s\S]*'hlc_area'/)
  assert.match(indicatorIdeSource, /supportedChartTypes = new Set\(\[[\s\S]*'range'/)
  assert.match(indicatorIdeSource, /codeDrawerVisible:\s*true/)
  assert.match(klineChartSource, /buildRenkoBricks\(sourceRows, \{ atrLength: 14 \}\)/)
  assert.match(klineChartSource, /buildHeikinAshiRows\(sourceRows\)/)
  assert.match(klineChartSource, /buildHlcAreaRows\(sourceRows\)/)
  assert.match(klineChartSource, /buildRangeBars\(sourceRows, \{ atrLength: 14 \}\)/)
  assert.match(klineChartSource, /usesDerivedPriceBars = \(\) => \['heikin_ashi', 'hlc_area', 'renko', 'range'\]\.includes\(props\.candleType\)/)
  assert.doesNotMatch(klineChartSource, /isRenkoMode/)
  assert.match(klineChartSource, /convertToInternalFormat\(chartDisplayData\(\)\)/)
  assert.match(klineChartSource, /class="indicator-library-trigger"/)
  assert.equal((localeSource.match(/indicatorIde\.chartType\.renko/g) || []).length, 11)
  assert.equal((localeSource.match(/indicatorIde\.chartType\.heikinAshi/g) || []).length, 11)
  assert.equal((localeSource.match(/indicatorIde\.chartType\.hlcArea/g) || []).length, 11)
  assert.equal((localeSource.match(/indicatorIde\.chartType\.range/g) || []).length, 11)
})
