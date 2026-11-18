/**
 * Library ticker <-> venue context.
 *
 * The library identifies a symbol with one opaque string it echoes back on
 * every `resolveSymbol` and `getBars` call, while the same instrument can exist
 * on several venues (BTC/USDT as a spot pair and as a perpetual). Encoding the
 * venue in the ticker is what lets a search result survive that round trip:
 * the bare symbol alone would resolve against whatever venue the pane happened
 * to hold, and two venues with the same pair would be indistinguishable in a
 * saved layout.
 *
 * The format is `QD:<market>:<marketType>:<exchangeId>:<instrumentId>`. Empty
 * middle segments are kept so the position of each part is fixed; custom
 * studies and the legend read `name` and `description` instead of this string,
 * so it only ever needs to be machine-readable.
 */

const TICKER_PREFIX = 'QD'
const SEPARATOR = ':'

function part (value) {
  return String(value == null ? '' : value).trim()
}

/**
 * Build the ticker for one venue-scoped instrument.
 *
 * `instrumentId` falls back to the human symbol because the library always
 * needs a non-empty ticker to mount, and a chart whose instrument is unknown is
 * still a chart of that symbol.
 */
export function encodeSymbolTicker ({ market, marketType, exchangeId, instrumentId, symbol } = {}) {
  const instrument = part(instrumentId) || part(symbol)
  if (!instrument) return ''
  return [TICKER_PREFIX, part(market), part(marketType), part(exchangeId), instrument].join(SEPARATOR)
}

/**
 * Decode a ticker produced by `encodeSymbolTicker`.
 *
 * Returns null for anything else, including the bare symbols the IDE passes in
 * before a search has taken over: a bare symbol is a valid ticker too, and it
 * should keep meaning "the venue this pane already holds".
 */
export function decodeSymbolTicker (ticker) {
  const raw = part(ticker)
  if (!raw) return null
  const [prefix, market, marketType, exchangeId, ...rest] = raw.split(SEPARATOR)
  if (String(prefix).toUpperCase() !== TICKER_PREFIX) return null
  const instrumentId = rest.join(SEPARATOR).trim()
  if (!market || !instrumentId) return null
  return {
    market,
    marketType: marketType || '',
    exchangeId: exchangeId || '',
    instrumentId
  }
}

export function isEncodedSymbolTicker (ticker) {
  return decodeSymbolTicker(ticker) != null
}
