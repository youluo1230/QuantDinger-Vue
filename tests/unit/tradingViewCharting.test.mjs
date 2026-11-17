import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The Charting Library datafeed cannot be imported by these tests directly:
 * `datafeed.js` pulls in `@/utils/request`, which drags in ant-design-vue and
 * the i18n bundle. Those need the Vite alias table and a DOM. So the contract
 * is asserted against the source text, in the same style as the other
 * experience tests here -- the properties under test are exactly the ones that
 * were wrong when the file was first written.
 */

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const datafeed = read('src/charting/datafeed.js')
const host = read('src/charting/tradingview.js')
const component = read('src/components/TradingViewChart/index.vue')

test('chart bars come from the unified market-data endpoint', () => {
  assert.match(datafeed, /url: '\/api\/market-data\/candles'/)
  // The legacy endpoint stays only as documentation of where this used to go.
  assert.doesNotMatch(datafeed, /url: '\/api\/indicator\/kline'/)
})

test('every offered resolution maps onto a timeframe the backend serves', () => {
  // The library counts minutes; the backend names bars. Shipping "60" straight
  // through made every bar request fail on an unsupported timeframe.
  assert.match(datafeed, /60: '1H'/)
  assert.match(datafeed, /240: '4H'/)
  assert.match(datafeed, /'1D': '1D'/)
  assert.match(datafeed, /1: '1m'/)
  // The backend has no 2H, so the library must not offer it.
  assert.doesNotMatch(datafeed, /'120': '2H'/)
  assert.match(
    datafeed,
    /supported_resolutions: \['1', '3', '5', '15', '30', '60', '240', '1D', '1W'\]/
  )
})

test('symbol metadata follows the market instead of assuming crypto', () => {
  assert.match(datafeed, /session: '0930-1600'/)
  assert.match(datafeed, /timezone: 'America\/New_York'/)
  assert.match(datafeed, /type: 'stock'/)
  assert.match(datafeed, /type: 'forex'/)
  // A crypto profile must still exist, or the default market breaks.
  assert.match(datafeed, /Crypto: \{ type: 'crypto', session: '24x7'/)
})

test('realtime forwards the forming bar instead of swallowing it', () => {
  // The library's contract is "call the callback every time you want to update
  // the most recent bar", so the old early-return on a still-forming bar made a
  // live feed invisible until the period closed.
  assert.match(datafeed, /pushBar\s*\(bar, resolution\)/)
  assert.match(datafeed, /pushBarInternal/)
  const internal = datafeed.slice(datafeed.indexOf('const pushBarInternal'))
  const body = internal.slice(0, internal.indexOf('\n  }'))
  assert.doesNotMatch(body, /Date\.now\(\)/, 'a bar must not be filtered by wall clock')
  assert.match(body, /listener\.onRealtimeCallback\(bar\)/)
})

test('a crypto chart is fed by the venue socket, not a timer', () => {
  // The operator's requirement: real time means a stream. Swapping this for
  // setInterval would silently reintroduce polling.
  assert.match(datafeed, /from '@\/utils\/exchangeWs'/)
  assert.match(datafeed, /new ExchangeKlineWs\(\)/)
  assert.match(datafeed, /client\.connect\(/)
  assert.match(datafeed, /getExchangeInterval\(symbolInfo\.exchangeId, timeframe\)/)
  assert.doesNotMatch(datafeed, /setInterval/)
})

test('bar times reach the library in milliseconds', () => {
  // `Bar.time` is documented as milliseconds; seconds put every candle in 1970.
  assert.match(datafeed, /Math\.floor\(numeric \* 1000\)/)
  assert.match(datafeed, /function toBarTimeMs/)
  // The endpoint returns seconds, so the multiply is on the only parse path.
  const parseBar = datafeed.slice(datafeed.indexOf('function parseBar'))
  assert.match(parseBar.slice(0, 220), /toBarTimeMs/)
})

test('history pagination asks for a window, not a page', () => {
  // `before_time` is not a parameter of /api/market-data/candles, so every
  // scroll re-fetched the newest bars and the chart locked its left edge.
  assert.match(datafeed, /start: requestedStart/)
  assert.match(datafeed, /end \}\)/)
  assert.doesNotMatch(datafeed, /before_time:/)
  assert.match(datafeed, /countBack/)
})

test('an empty page alone does not declare the history exhausted', () => {
  assert.match(datafeed, /earliestSeenMs/)
  assert.match(datafeed, /exhausted/)
})

test('the library is loaded as a vendored classic script, once', () => {
  assert.match(host, /charting_library\.standalone\.js/)
  assert.match(host, /LIBRARY_PATH = '\/charting_library\/'/)
  // A second copy on a route change would re-register its custom elements.
  assert.match(host, /const SCRIPT_ATTR = 'data-tv-library'/)
  assert.match(host, /querySelector\(`script\[\$\{SCRIPT_ATTR\}\]`\)/)
})

test('the widget is torn down explicitly because Vue cannot unmount foreign DOM', () => {
  assert.match(host, /export async function mountTradingViewChart/)
  assert.match(host, /widget\.remove\?\.\(\)/)
  assert.match(component, /beforeDestroy \(\)/)
  assert.match(component, /this\.handle\.destroy\(\)/)
})

test('a missing vendored bundle surfaces as a message, not a blank page', () => {
  assert.match(component, /this\.error = err\?\.message \|\| String\(err\)/)
  assert.match(component, /v-if="error"/)
})

test('the vendored library ships next to the app so its licence travels with it', () => {
  const bundles = read('public/charting_library/charting_library.standalone.js')
  assert.ok(bundles.length > 1000)
})

test('saved indicators are resolved by the charting module, not by this component', () => {
  // The import list is asserted by name so that adding a collaborator here
  // cannot silently drop one of them.
  assert.match(component, /from '@\/charting\/indicatorPlots'/)
  assert.match(component, /\bcreateSeriesCache\b/)
  assert.match(component, /\bresolveCustomIndicators\b/)
  assert.match(component, /customIndicators: \(\) => this\.loadIndicators\(\)/)
  // One broken indicator must not blank the chart, so it is reported separately.
  assert.match(component, /indicatorError/)
  assert.match(component, /v-else-if="indicatorError"/)
})

test('the widget accepts indicators as a loader so previews are not spent up front', () => {
  assert.match(host, /const loadIndicators = typeof customIndicators === 'function'/)
  assert.match(host, /custom_indicators_getter: loadIndicators/)
})

test('studies are registered and then drawn, and a rebuild keeps the viewport', () => {
  const component = read('src/components/TradingViewChart/index.vue')

  // Registering a custom indicator only fills the library's study registry; the
  // bundle pushes into `studyLibrary` and stops. Nothing appears on the chart
  // until `createStudy` is called, so both steps have to be present.
  assert.match(component, /customIndicators: \(\) => this\.loadIndicators\(\)/)
  assert.match(component, /createStudy\(/)
  assert.match(component, /onChartReady/)

  // Drawing is deferred to the ready callback: before that, `createStudy`
  // resolves to null and the study silently never appears.
  const mount = component.slice(component.indexOf('async mount ()'), component.indexOf('async reconcileStudies'))
  assert.match(mount, /onChartReady/)
  assert.doesNotMatch(mount, /^\s+await this\.drawStudies\(\)/m)

  // A changed set rebuilds the widget, which must not read as a reload.
  const reconcile = component.slice(component.indexOf('async reconcileStudies'), component.indexOf('captureViewport () {'))
  assert.match(reconcile, /captureViewport/)
  assert.match(reconcile, /restoreViewport/)
})

test('a re-render with the same studies does not rebuild the chart', () => {
  // The parent passes this prop as a method call, so identity changes on every
  // render. A watcher keyed on identity therefore remounts the widget -- and
  // re-downloads the history -- for a page that changed nothing but a counter.
  assert.match(component, /lastIndicatorsSignature/)
  assert.match(component, /if \(signature === this\.lastIndicatorsSignature\) return/)
  assert.match(component, /indicatorsSignature \(list\)/)
  // A fingerprint rather than the full source: the signature is compared on
  // every render, so it cannot be O(script length).
  assert.match(component, /codeFingerprint\(item\?\.code\)/)
  assert.doesNotMatch(
    component,
    /indicators: \{\s*\/\/[\s\S]{0,400}?deep: true/,
    'a deep watch on the array makes every re-render a rebuild'
  )
})

test('a rebuild keeps both caches, because both are keyed by what produced them', () => {
  // Bars are the market's answer and plots are the script's, but neither is
  // made stale by *drawing a different set* of studies: each entry is keyed by
  // the series, the script revision, and the input values. Clearing either one
  // on a rebuild means paying for work that is still valid.
  assert.match(component, /barCache: createStudyBarCache\(\)/)
  const reconcile = component.slice(
    component.indexOf('async reconcileStudies ()'),
    component.indexOf('/** The visible time range')
  )
  assert.doesNotMatch(reconcile, /this\.seriesCache\.clear\(\)/)
  assert.doesNotMatch(reconcile, /this\.barCache\.clear\(\)/)
  // Changing a length input must not serve the plot computed with the old one.
  assert.match(read('src/charting/indicatorPlots.js'), /params: paramsKey/)
})

test('a rebuilt chart repaints from memory instead of re-downloading its bars', () => {
  // Changing the study set tears the widget down and builds it again, which is
  // unavoidable: the library reads its study registry once at mount. What is not
  // unavoidable is paying for the same candles twice.
  assert.match(datafeed, /export function createBarStore/)
  assert.match(datafeed, /barStore\?\.read\(/)
  assert.match(datafeed, /barStore\?\.remember\(/)
  // Coverage is judged per bar, not per request: a rebuilt chart asks for a
  // slightly different window than the one it was given.
  assert.match(datafeed, /toleranceMs/)
  assert.match(host, /barStore/)
  assert.match(component, /barStore: createBarStore\(\)/)
})
