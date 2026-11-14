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

test('saved indicators are replayed from backend output, not evaluated in the browser', () => {
  assert.match(component, /import \{ createSeriesCache, resolveCustomIndicators \} from '@\/charting\/indicatorPlots'/)
  assert.match(component, /customIndicators: \(\) => this\.loadIndicators\(\)/)
  // One broken indicator must not blank the chart, so it is reported separately.
  assert.match(component, /indicatorError/)
  assert.match(component, /v-else-if="indicatorError"/)
})

test('the widget accepts indicators as a loader so previews are not spent up front', () => {
  assert.match(host, /const loadIndicators = typeof customIndicators === 'function'/)
  assert.match(host, /custom_indicators_getter: loadIndicators/)
})
