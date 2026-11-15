/**
 * The chart workbench has to be reachable and wired to endpoints that exist.
 *
 * Both failures are silent in the browser: a route that is missing from the
 * config just shows a 404 page, and a template endpoint with the wrong prefix
 * answers 404 on save while the page still renders. Neither raises anything a
 * user could act on, so they are asserted here instead.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = fileURLToPath(new URL('../..', import.meta.url))
const read = relativePath => readFileSync(`${frontendRoot}/${relativePath}`, 'utf8')

test('the chart workbench route points at a real page', () => {
  const router = read('src/config/router.config.js')
  assert.match(router, /path: '\/tv-workbench'[\s\S]*?import\('@\/views\/tv-workbench'\)/)
  assert.equal(existsSync(`${frontendRoot}/src/views/tv-workbench/index.vue`), true)
})

test('chart templates use the /api/users prefix the blueprint is mounted at', () => {
  const page = read('src/views/tv-workbench/index.vue')
  assert.match(page, /'\/api\/users\/chart-templates'/)
  // `/api/user/...` resolves to nothing and saves silently fail.
  assert.doesNotMatch(page, /'\/api\/user\/chart-templates'/)
})

test('the page hands indicators to the chart instead of computing them itself', () => {
  const page = read('src/views/tv-workbench/index.vue')
  // The studies are replayed from backend output; a `calc` in the page would mean
  // the two paths had started to diverge.
  assert.match(page, /:indicators="activeIndicators"/)
  assert.doesNotMatch(page, /calculate\s*:/)
})

test('the chart component reports study failures upward', () => {
  const component = read('src/components/TradingViewChart/index.vue')
  assert.match(component, /\$emit\('indicator-error'/)
  assert.match(component, /resolveCustomIndicators/)
})

test('every rendered chart timeframe maps to a backend timeframe', () => {
  const page = read('src/views/tv-workbench/index.vue')
  const datafeed = read('src/charting/datafeed.js')
  const offered = page.match(/timeframes: \[([^\]]+)\]/)
  assert.ok(offered, 'the page should declare its timeframes')
  const values = offered[1].split(',').map(item => item.trim().replace(/^'|'$/g, ''))
  for (const timeframe of values) {
    // A timeframe the datafeed cannot translate reaches the API as an unknown
    // string, and the chart comes back empty with no useful error.
    assert.ok(
      datafeed.includes(`'${timeframe}'`),
      `${timeframe} must appear in the datafeed's timeframe table`
    )
  }
  assert.doesNotMatch(page, /'2H'/, 'the backend has no 2h timeframe')
})

test('the chart workspace is reachable from the sidebar, next to Indicators', () => {
  const layout = read('src/layouts/BasicLayout.vue')

  // The sidebar is assembled from a hand-written order list, so a route that is
  // missing from it sorts to the bottom of the menu — below Settings, which is
  // where nobody looks. The route existing is not the same as being findable.
  const order = layout.slice(layout.indexOf('const order = ['), layout.indexOf(']', layout.indexOf('const order = [')))
  assert.match(order, /'\/tv-workbench'/)
  assert.ok(
    order.indexOf("'/tv-workbench'") > order.indexOf("'/indicator-ide'"),
    'the chart entry belongs after Indicators, not at the end of the menu'
  )
  assert.ok(
    order.indexOf("'/tv-workbench'") < order.indexOf("'/strategy-ide'"),
    'the chart entry belongs with the analysis pages, not among the brokers'
  )
})
