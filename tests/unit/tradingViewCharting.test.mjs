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

test('the candles request carries a market label the backend accepts', () => {
  // Archives and hand-written tickers drift to lower case; the endpoint only
  // takes `Crypto`, so the label is canonicalised once, before any request.
  assert.match(datafeed, /market: canonicalMarket\(symbolInfo\.market\)/)
  assert.match(datafeed, /market: canonicalMarket\(symbolInfo\.market\),[\s\S]{0,80}keyword,/)
  assert.match(datafeed, /export function canonicalMarket/)
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
  const mount = component.slice(component.indexOf('async mount ('), component.indexOf('async reconcileStudies'))
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

test('a rebuild paints the replacement before it removes the chart on screen', () => {
  // Teardown-then-mount leaves an empty pane for as long as the widget takes to
  // build, which is the flash. The replacement is built into a second host and
  // the visible one is retired only afterwards.
  assert.match(component, /hostSlot/)
  assert.match(component, /chartHostSpare/)
  const remount = component.slice(component.indexOf('async remount ()'))
  assert.match(remount, /this\.handle = null/, 'mount() refuses to run while a handle exists')
  assert.match(remount, /await this\.mount\(nextSlot\)/)
  // The slot is switched only once the new widget is up, and the old one is
  // destroyed after that.
  assert.match(remount, /this\.hostSlot = nextSlot[\s\S]*previous\?\.destroy\(\)/)
  // If the replacement fails to build, the old chart stays visible: a failed
  // rebuild must not leave the user with nothing.
  assert.match(remount, /this\.handle = previous/)
  assert.match(component, /visibility: hidden/)
  assert.match(component, /&--active/)
})

test('a study that draws a label paints it where its own bar is', () => {
  // The library's shape API takes a chart time, and the resolver has already
  // turned the runtime's bar index into that time. Drawing without the time
  // would put every label at the epoch.
  const draw = component.slice(component.indexOf('drawStudyDrawings'))
  assert.match(draw, /chart\.createShape/)
  assert.match(draw, /shape: 'text'/)
  assert.match(draw, /label\.time \/ 1000/, 'the library counts seconds, the datafeed counts milliseconds')
  // A study's labels are not the user's annotations: they must not be
  // selectable, saved, or put on the undo stack.
  assert.match(draw, /disableSelection: true/)
  assert.match(draw, /disableSave: true/)
  assert.match(draw, /disableUndo: true/)
  // A tooltip-only label draws no box in Pine, and the text tool always draws
  // one, so those are skipped rather than drawn empty.
  assert.match(draw, /if \(!label\.boxed\) continue/)
})

test('a study that draws a table gets it drawn, since the library has no table tool', () => {
  assert.match(component, /tv-chart__tables/)
  assert.match(component, /tableRows\s*\(table\)/)
  const rows = component.slice(component.indexOf('tableRows (table)'))
  // The runtime hands back a sparse grid; the holes are part of the layout, so
  // a missing cell must stay missing instead of sliding the next one left.
  assert.match(rows, /byRow/)
})

test('a table is placed at the corner the script named', () => {
  for (const position of ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'middle-center', 'bottom-center']) {
    assert.match(component, new RegExp(`&--${position}`), `no style for table position ${position}`)
  }
  // Pine's own names use underscores; the classes use hyphens.
  assert.match(component, /position\.replace\(\/_\/g, '-'\)/)
})

test('the drawings belong to the study and go when it does', () => {
  const teardown = component.slice(component.indexOf('teardown ()'))
  assert.match(teardown, /this\.indicatorTables = \[\]/)
  assert.match(teardown, /this\.drawnLabels = \[\]/)
  // Redrawing without removing first would stack a second copy of every label
  // on top of the first one.
  const clear = component.slice(component.indexOf('clearStudyDrawings'))
  assert.match(clear, /removeEntity/)
})

test('the library search is answered by the datafeed', () => {
  // `header_symbol_search` is unfrozen, and the bundle calls `searchSymbols`
  // unconditionally, so a datafeed without it throws on the first keystroke.
  assert.match(datafeed, /async searchSymbols \(userInput, exchange, symbolType, onResult, onError\)/)
  assert.match(datafeed, /url: '\/api\/market\/symbols\/search'/)
  assert.match(datafeed, /keyword,/)
  // Each hit is encoded with the venue that produced it, or picking a swap
  // instrument from the spot list would chart a different market.
  assert.match(datafeed, /const ticker = encodeSymbolTicker\(/)
})

test('the encoded ticker is identity, the instrument is what gets fetched', () => {
  // The candles endpoint and the venue socket both take the human instrument;
  // the `QD:` ticker only has to survive `resolveSymbol` round trips.
  assert.match(datafeed, /symbol: symbolInfo\.instrument \|\| symbolInfo\.ticker/)
  assert.match(datafeed, /client\.connect\(/)
  assert.match(datafeed, /instrument \|\| symbolInfo\.ticker,/)
})

test('the venue is no longer offered as a second symbol authority', () => {
  // The toolbar's exchange/product pickers were deleted in this phase; leaving
  // the lists populated would show the library two competing answers.
  assert.match(datafeed, /exchanges: \[\]/)
  assert.match(datafeed, /symbols_types: \[\]/)
})

test('a symbol resolved by the library is reported back to the pane', () => {
  assert.match(datafeed, /onSymbolResolved\?\.\(symbolInfo\)/)
  assert.match(datafeed, /onSymbolResolved/)
  // The new bars must not be served from the previous symbol's store: it is
  // keyed by timeframe, so a stale banner's bars would be replayed as history.
  const resolve = datafeed.slice(datafeed.indexOf('resolveSymbol (requestedName'))
  assert.match(resolve, /stopStream\(\)/)
  assert.match(resolve, /barStore\?\.clear\?\.\(\)/)
})

test('a study is created with the inputs its settings dialog will show', () => {
  // An empty `inputs: []` made every custom study open an empty Settings
  // dialog, and `getInputValues()` had no ids to report.
  assert.match(component, /createStudy\(study\.name, study\.metainfo\.overlay === true, false, this\.studyInputValues\(study\)\)/)
  assert.match(component, /study\?\.inputs/)
  assert.match(component, /inputMap/)
})

test('a study set change edits the live chart instead of rebuilding it', () => {
  // `custom_indicators_getter` runs once, so registered names can be added and
  // removed in place; only names the mount did not register need a rebuild.
  const sync = component.slice(component.indexOf('syncStudies ()'))
  assert.match(sync.slice(0, 2400), /chart\.removeEntity\(/)
  assert.match(sync.slice(0, 2400), /chart\.createStudy\(/)
  assert.match(sync, /remount\(\)/)
  assert.match(sync, /registeredStudyNames/)
})

test('editing an input in the native dialog reruns the script', () => {
  // The dialog is the only input surface now, so the value has to travel back
  // through `getInputValues` and a study update -- otherwise the chart keeps
  // drawing the old parameters while the dialog shows the new ones.
  assert.match(component, /widget\.subscribe\('study_properties_changed'/)
  assert.match(component, /getStudyById\(entityId\)\.getInputValues\(\)/)
  assert.match(component, /record\.descriptor\.update\?\.\(/)
})

test('the header chart type and pickers are wired back to the pane', () => {
  // The old dropdown wrote a field nothing read. `setChartType` is the real
  // switch, and the header's own menus must report back or the next rebuild
  // would restore the previous interval/symbol.
  assert.match(component, /seriesTypeFor\(this\.candleType\)/)
  assert.match(component, /chart\.setChartType\(/)
  assert.match(component, /chart\.onIntervalChanged/)
  assert.match(component, /chart\.onSymbolChanged/)
  assert.match(component, /this\.\$emit\('interval-change', \{ timeframe \}\)/)
  assert.match(component, /\$emit\('symbol-change'/)
})

test('the IDE stores what the library reported', () => {
  const ide = read('src/views/indicator-ide/index.vue')
  assert.match(ide, /@symbol-change="payload => handlePaneSymbolChange\(pane\.id, payload\)"/)
  assert.match(ide, /@interval-change="payload => handlePaneIntervalChange\(pane\.id, payload\)"/)
  assert.match(ide, /handlePaneSymbolChange \(paneId, change\)/)
  assert.match(ide, /handlePaneIntervalChange \(paneId, change\)/)
})

test('a context change drops every bar cache, not only the studies', () => {
  // Both stores are keyed by timeframe. Rebuilding on a symbol change and
  // answering from them would paint the new symbol's legend over the previous
  // symbol's candles.
  const watcher = component.slice(component.indexOf('dataContext ()'), component.indexOf('theme ()'))
  assert.match(watcher, /this\.barCache\.clear\(\)/)
  assert.match(watcher, /this\.barStore\.clear\(\)/)
  // The study series are cached by symbol+timeframe only, so a venue change on
  // the same pair would serve the previous venue's plots.
  assert.match(watcher, /this\.seriesCache\.clear\(\)/)
  assert.match(watcher, /this\.remount\(\)/)
})

test('the widget rebuild runs one at a time', () => {
  // A search result carries symbol and venue; when both change in one tick a
  // second `mount` would race the first for the spare host element.
  const remount = component.slice(component.indexOf('async remount ()'))
  assert.match(remount.slice(0, 700), /if \(this\.remounting\)/)
  assert.match(remount, /this\.remountQueued = true/)
  assert.match(remount, /await this\.swapChart\(\)/)
})

test('a Settings-dialog value outlives the live-bar re-evaluation', () => {
  // The pane prop keeps the saved indicator values; a live bar re-runs the
  // script from that prop. Without the dialog overrides being layered back in,
  // the chart would snap back to the old inputs on the next tick.
  const merge = component.slice(component.indexOf('withStudyParams (indicators)'), component.indexOf('/** Resolve the checked indicators'))
  assert.match(merge, /this\.studyParams\[item\?\.name \|\| ''\]/)
  assert.match(merge, /params: \{ \.\.\.\(item\?\.params \|\| \{\}\), \.\.\.overrides \}/)
  const live = component.slice(component.indexOf('async refreshLiveStudies ()'), component.indexOf('captureMarketPreview'))
  assert.match(live, /this\.withStudyParams\(this\.indicators\)/)
})

test('a failed re-evaluation keeps the old input values', () => {
  const settings = component.slice(component.indexOf('async onStudyPropertiesChanged (entityId)'), component.indexOf('teardown ()'))
  const evaluated = settings.indexOf('const next = indicators && indicators[0]')
  const remembered = settings.indexOf('this.$set(this.studyParams, record.name, params)')
  assert.ok(evaluated > -1 && remembered > evaluated, 'the override is recorded only after the script ran')
})

test('a four-pane layout drops the header controls that no longer fit', () => {
  // Four panes mean four native headers; compare, screenshot and undo/redo are
  // the controls that stop fitting, so a dense layout trades them for height.
  const options = read('src/charting/tradingview.js')
  assert.match(options, /\.\.\.\(compactHeader \? \['header_compare', 'header_screenshot', 'header_undo_redo'\] : \[\]\)/)
  assert.match(component, /compactHeader: this\.compactHeader/)
  assert.match(component, /compactHeader \(\) \{[\s\S]*?this\.remount\(\)/)
  const ide = read('src/views/indicator-ide/index.vue')
  assert.match(ide, /:compact-header="chartLayoutMode === 4"/)
})
