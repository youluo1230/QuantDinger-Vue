import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LAYOUT_MODES,
  WORKSPACE_VERSION,
  encodeWorkspace,
  isLegacyTemplate,
  legacyWorkspaceFromIndicators,
  paneFromArchive,
  paramsFromWorkspace,
  serialisePane,
  workspaceFromLegacyState,
  workspaceFromTemplate
} from '../../src/views/indicator-ide/workspaceModel.js'

const cryptoPane = {
  id: 'pane-1',
  market: 'Crypto',
  symbol: 'BTC/USDT',
  exchangeId: 'binance',
  marketType: 'swap',
  instrumentId: 'BTC/USDT',
  timeframe: '1H',
  candleType: 'candle_solid',
  visibleIndicatorIds: [7, 9]
}

const info = (id) => ({ 7: { name: 'EMA', params: { Length: 21 } }, 9: { name: 'RSI', params: {} } }[id] || {})

test('a pane travels as one encoded ticker, not as loose venue fields', () => {
  assert.deepEqual(serialisePane(cryptoPane, info), {
    symbol: 'QD:BTC/USDT:Crypto:swap:binance',
    timeframe: '1H',
    chartType: 'candle_solid',
    indicators: [
      { id: 7, name: 'EMA', params: { Length: 21 }, visible: true },
      { id: 9, name: 'RSI', params: {}, visible: true }
    ]
  })
})

test('duplicate, empty and non-numeric checkbox values never reach the archive', () => {
  const pane = { ...cryptoPane, visibleIndicatorIds: [7, 7, 0, 'x', 9] }
  const ids = serialisePane(pane, info).indicators.map(item => item.id)
  assert.deepEqual(ids, [7, 9])
})

test('the archive keeps the layout, the active pane and the editor state', () => {
  const workspace = encodeWorkspace({
    panes: [cryptoPane, { ...cryptoPane, id: 'pane-2', symbol: 'ETH/USDT', instrumentId: 'ETH/USDT', visibleIndicatorIds: [9] }],
    layoutMode: 2,
    activePane: 1,
    editorOpen: false,
    indicatorInfo: info
  })
  assert.equal(workspace.version, WORKSPACE_VERSION)
  assert.equal(workspace.layoutMode, 2)
  assert.equal(workspace.activePane, 1)
  assert.equal(workspace.editorOpen, false)
  assert.equal(workspace.panes.length, 2)
  assert.equal(workspace.panes[0].symbol, 'QD:BTC/USDT:Crypto:swap:binance')
  assert.equal(workspace.panes[0].timeframe, '1H')
})

test('a layout the IDE cannot draw falls back to one pane and pane zero', () => {
  const workspace = encodeWorkspace({ panes: [cryptoPane], layoutMode: 3, activePane: 9, editorOpen: true })
  assert.equal(workspace.layoutMode, 1)
  assert.equal(workspace.activePane, 0)
  assert.ok(LAYOUT_MODES.includes(workspace.layoutMode))
})

test('loading a pane restores the venue the ticker carries', () => {
  const pane = paneFromArchive(
    { symbol: 'QD:SOL/USDT:crypto:spot:okx', timeframe: '4H', chartType: 'line', indicators: [{ id: '5' }, { id: 0 }] },
    { id: 'pane-1', market: 'USStock', symbol: 'AAPL', exchangeId: 'nasdaq', marketType: 'spot', instrumentId: 'AAPL', timeframe: '1D', candleType: 'candle_solid' }
  )
  assert.equal(pane.market, 'Crypto')
  assert.equal(pane.symbol, 'SOL/USDT')
  assert.equal(pane.exchangeId, 'okx')
  assert.equal(pane.marketType, 'spot')
  assert.equal(pane.instrumentId, 'SOL/USDT')
  assert.equal(pane.timeframe, '4H')
  assert.equal(pane.candleType, 'line')
  assert.deepEqual(pane.visibleIndicatorIds, [5])
})

test('a lower-case market in a ticker comes back canonical', () => {
  // The candles endpoint only accepts the documented spelling, so an archive
  // written by hand (or by an older client) must not reach the request as
  // "crypto" and 400.
  const pane = paneFromArchive({ symbol: 'QD:ETH/USDT:crypto:spot:binance', timeframe: '1H' })
  assert.equal(pane.market, 'Crypto')
})

test('a legacy pane without a symbol keeps whatever instrument is on screen', () => {
  const pane = paneFromArchive(
    { symbol: '', timeframe: '', chartType: '', indicators: [{ id: 3 }] },
    { market: 'USStock', symbol: 'MSFT', exchangeId: 'nasdaq', instrumentId: 'MSFT', timeframe: '1D', candleType: 'area' }
  )
  assert.equal(pane.market, 'USStock')
  assert.equal(pane.symbol, 'MSFT')
  assert.equal(pane.exchangeId, 'nasdaq')
  assert.equal(pane.timeframe, '1D')
  assert.equal(pane.candleType, 'area')
})

test('old indicator-list templates become a single pane that keeps the instrument', () => {
  const workspace = legacyWorkspaceFromIndicators([
    { id: '12', name: 'MACD', params: { fast: 12 } },
    { id: 12, name: 'duplicate' },
    { indicator_id: 15, type: 'pine' }
  ])
  assert.equal(workspace.panes.length, 1)
  assert.equal(workspace.panes[0].symbol, '')
  assert.deepEqual(workspace.panes[0].indicators.map(item => item.id), [12, 15])
  assert.deepEqual(workspace.panes[0].indicators[0].params, { fast: 12 })
  assert.equal(workspace.panes[0].indicators[1].name, '')
})

test('template rows are read in either shape', () => {
  assert.equal(isLegacyTemplate({ id: 'a', name: 'old', indicators: [] }), true)
  assert.equal(workspaceFromTemplate({ id: 'a', name: 'new', workspace: encodeWorkspace({ panes: [cryptoPane] }) }).panes[0].symbol, 'QD:BTC/USDT:Crypto:swap:binance')
  assert.equal(workspaceFromTemplate({ id: 'b', indicators: [{ id: 4 }] }).panes[0].indicators[0].id, 4)
  assert.equal(workspaceFromTemplate(null), null)
})

test('the local cache of the older IDE migrates into one workspace', () => {
  const workspace = workspaceFromLegacyState({
    chartPanes: [
      { ...cryptoPane, id: 'pane-1', visibleIndicatorIds: [7] },
      { ...cryptoPane, id: 'pane-2', symbol: 'ETH/USDT', instrumentId: 'ETH/USDT', visibleIndicatorIds: [9] }
    ],
    chartLayoutMode: 2,
    activeChartPaneId: 'pane-2',
    codeDrawerVisible: false
  }, {
    indicatorInfo: info,
    chartType: 'candle_stroke',
    params: { 9: { Length: 30 } }
  })
  assert.equal(workspace.layoutMode, 2)
  assert.equal(workspace.activePane, 1)
  assert.equal(workspace.editorOpen, false)
  assert.equal(workspace.panes[1].symbol, 'QD:ETH/USDT:Crypto:swap:binance')
  assert.equal(workspace.panes[0].indicators[0].params.Length, 21)
  assert.equal(workspace.panes[1].indicators[0].params.Length, 30)
  assert.equal(workspace.panes[0].chartType, 'candle_solid')
  assert.equal(workspace.panes[0].indicators[0].name, 'EMA')
})

test('the stored chart-type preference fills panes that never picked one', () => {
  const workspace = workspaceFromLegacyState({ chartPanes: [{ ...cryptoPane, candleType: '' }] }, { chartType: 'line' })
  assert.equal(workspace.panes[0].chartType, 'line')
})

test('an empty legacy cache still migrates to a usable workspace', () => {
  const workspace = workspaceFromLegacyState({}, { chartType: 'line' })
  assert.equal(workspace.layoutMode, 1)
  assert.equal(workspace.activePane, 0)
  assert.equal(workspace.panes.length, 1)
  assert.equal(workspace.panes[0].symbol, '')
})

test('input values are gathered once per indicator for the editor to reuse', () => {
  const workspace = encodeWorkspace({
    panes: [cryptoPane, { ...cryptoPane, id: 'pane-2', visibleIndicatorIds: [9] }],
    indicatorInfo: (id) => (id === 7 ? { name: 'EMA', params: { Length: 21 } } : { name: 'RSI', params: { Length: 14 } })
  })
  assert.deepEqual(paramsFromWorkspace(workspace), { 7: { Length: 21 }, 9: { Length: 14 } })
})
