import { decodeSymbolTicker, encodeSymbolTicker } from '../../charting/symbolTicker.js'

/**
 * The workspace the IDE archives on the backend.
 *
 * It is the whole chart, not a list of indicators: the backend used to store
 * "which scripts did this user check", which cannot restore a four-pane layout
 * or remember what the chart looked like when the user left it. The shape here
 * is the one the server validates in
 * `backend_api_python/app/services/user_preferences.py` (`normalize_workspace`).
 */
export const WORKSPACE_VERSION = 1
export const LAYOUT_MODES = [1, 2, 4]

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function paneIndex (panes, activePaneId) {
  const index = (panes || []).findIndex(pane => pane && pane.id === activePaneId)
  return index >= 0 ? index : 0
}

function indicatorParams (value) {
  if (!isObject(value)) return {}
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue
    out[String(key)] = raw
  }
  return out
}

/**
 * One pane, reduced to what the server needs to rebuild it.
 *
 * The symbol is the library's own identity for the instrument, so it has to be
 * the encoded ticker: the pane's market, exchange and instrument only survive a
 * save/load round trip if they travel together. Legacy rows without a market
 * fall back to the human symbol and the next load keeps whatever venue the pane
 * already had.
 */
export function serialisePane (pane, indicatorInfo = () => ({})) {
  const source = pane || {}
  const ids = Array.isArray(source.visibleIndicatorIds) ? source.visibleIndicatorIds : []
  const indicators = []
  const seen = new Set()
  for (const rawId of ids) {
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    const info = indicatorInfo(id) || {}
    indicators.push({
      id,
      name: String(info.name || ''),
      params: indicatorParams(info.params),
      visible: info.visible !== false
    })
  }
  const ticker = encodeSymbolTicker({
    market: source.market,
    marketType: source.marketType,
    exchangeId: source.exchangeId,
    instrumentId: source.instrumentId,
    symbol: source.symbol
  })
  return {
    symbol: ticker || String(source.symbol || ''),
    timeframe: String(source.timeframe || ''),
    chartType: String(source.candleType || ''),
    indicators
  }
}

export function encodeWorkspace ({ panes, layoutMode, activePane, editorOpen, indicatorInfo } = {}) {
  const mode = LAYOUT_MODES.includes(Number(layoutMode)) ? Number(layoutMode) : 1
  const source = Array.isArray(panes) ? panes.filter(Boolean) : []
  const visible = source.slice(0, mode)
  const encoded = visible.map(pane => serialisePane(pane, indicatorInfo))
  let active = Number(activePane)
  if (!Number.isInteger(active) || active < 0 || active >= encoded.length) active = 0
  return {
    version: WORKSPACE_VERSION,
    layoutMode: mode,
    activePane: active,
    editorOpen: editorOpen !== false,
    panes: encoded
  }
}

/**
 * A saved pane back into the shape the IDE keeps in memory.
 *
 * An empty symbol means the template was written before the workspace existed:
 * its indicators are applied to the pane that is already on screen instead of
 * replacing the instrument.
 */
export function paneFromArchive (entry, current = {}) {
  const row = entry || {}
  const base = { ...(current || {}) }
  const decoded = decodeSymbolTicker(row.symbol)
  const ids = Array.isArray(row.indicators)
    ? row.indicators.map(item => Number(item && item.id)).filter(id => Number.isInteger(id) && id > 0)
    : []
  return {
    ...base,
    market: decoded ? decoded.market : base.market,
    symbol: decoded ? decoded.instrumentId : String(row.symbol || '') || base.symbol,
    exchangeId: decoded ? decoded.exchangeId : base.exchangeId,
    marketType: decoded ? decoded.marketType : base.marketType,
    instrumentId: decoded ? decoded.instrumentId : base.instrumentId,
    timeframe: String(row.timeframe || '') || base.timeframe,
    candleType: String(row.chartType || '') || base.candleType,
    visibleIndicatorIds: ids,
    indicatorRunning: true
  }
}

/**
 * Per-indicator input values captured with the workspace.
 *
 * The chart editor is the only writer; the settings dialog reports its values
 * back through this map so a reloaded workspace runs with the numbers the user
 * last saw.
 */
export function paramsFromWorkspace (workspace) {
  const out = {}
  for (const pane of (workspace && workspace.panes) || []) {
    for (const item of (pane && pane.indicators) || []) {
      const id = String(item && item.id)
      if (!id || id === '0' || id === 'undefined') continue
      const params = indicatorParams(item && item.params)
      if (Object.keys(params).length) out[id] = params
    }
  }
  return out
}

export function legacyWorkspaceFromIndicators (items) {
  const indicators = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item)) continue
    const id = Number(item.id != null ? item.id : item.indicator_id)
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    indicators.push({
      id,
      name: String(item.name || ''),
      params: indicatorParams(item.params),
      visible: item.visible !== false
    })
  }
  return {
    version: WORKSPACE_VERSION,
    layoutMode: 1,
    activePane: 0,
    editorOpen: true,
    panes: [{ symbol: '', timeframe: '', chartType: '', indicators }]
  }
}

export function isLegacyTemplate (template) {
  return Boolean(template) && !isObject(template.workspace)
}

/**
 * A template row from the API, old shape or new, as a workspace.
 */
export function workspaceFromTemplate (template) {
  if (!template || typeof template !== 'object') return null
  if (isObject(template.workspace) && Array.isArray(template.workspace.panes)) {
    return template.workspace
  }
  if (Array.isArray(template.indicators)) return legacyWorkspaceFromIndicators(template.indicators)
  return null
}

/**
 * The localStorage state the older IDE wrote, brought forward once.
 *
 * `ui` is `qd_indicator_ide_ui_v2_<uid>`, `params` is
 * `qd_indicator_param_defaults_v2_<uid>` and `chartType` is the per-user style
 * preference. Whatever the last session left on screen becomes a template; the
 * keys are removed by the caller after the template is saved, so a half-written
 * migration can simply run again.
 */
export function workspaceFromLegacyState (ui, { indicatorInfo = () => ({}), chartType = '', params = {} } = {}) {
  const state = isObject(ui) ? ui : {}
  const panes = Array.isArray(state.chartPanes)
    ? state.chartPanes
      .filter(pane => isObject(pane))
      .map(pane => {
        const ids = Array.isArray(pane.visibleIndicatorIds)
          ? pane.visibleIndicatorIds.map(Number).filter(id => Number.isInteger(id) && id > 0)
          : []
        return {
          ...pane,
          visibleIndicatorIds: ids,
          candleType: pane.candleType || chartType || 'candle_solid'
        }
      })
    : []
  const info = (id) => {
    const base = indicatorInfo(id) || {}
    return {
      ...base,
      params: {
        ...indicatorParams(base.params),
        ...indicatorParams((params || {})[String(id)])
      }
    }
  }
  return encodeWorkspace({
    panes: panes.length ? panes : [{}],
    layoutMode: state.chartLayoutMode,
    activePane: paneIndex(panes, state.activeChartPaneId),
    editorOpen: state.codeDrawerVisible !== false,
    indicatorInfo: info
  })
}
