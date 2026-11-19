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
 * The format is `QD:<instrumentId>:<market>:<marketType>:<exchangeId>`. The
 * instrument sits in the second slot because the header's symbol button falls
 * back to the second colon-separated segment of the pro name (the build does
 * not carry `use_symbol_name_for_header_toolbar`), and a button reading
 * "CRYPTO" instead of "BTC/USDT" looks broken. Custom studies and the legend
 * read `name` and `description`, not this string, so it only needs to be
 * machine-readable.
 *
 * The older order (`QD:<market>:<marketType>:<exchangeId>:<instrumentId>`) is
 * still decoded so archives written before the swap keep loading.
 */

const TICKER_PREFIX = 'QD'
const SEPARATOR = ':'

/** Market labels this app encodes. Used only to tell the two orders apart. */
const KNOWN_MARKETS = ['Crypto', 'USStock', 'CNStock', 'HKStock', 'Forex', 'Futures']

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
  const venue = [part(market), part(marketType), part(exchangeId)]
  // An instrument that itself contains the separator cannot sit in a fixed
  // slot; fall back to the old order, where it comes last and is joined back
  // whole. The header then shows the market label for that symbol, which is
  // rare enough to accept over truncating the symbol.
  if (instrument.includes(SEPARATOR)) return [TICKER_PREFIX, ...venue, instrument].join(SEPARATOR)
  return [TICKER_PREFIX, instrument, ...venue].join(SEPARATOR)
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
  const parts = raw.split(SEPARATOR)
  const [prefix, second] = parts
  if (String(prefix).toUpperCase() !== TICKER_PREFIX) return null

  // The pre-swap order starts with the market label, which the new order never
  // does: its second part is an instrument such as "BTC/USDT".
  const legacyMarket = KNOWN_MARKETS.find(label => label.toLowerCase() === String(second).toLowerCase())
  if (parts.length >= 5 && legacyMarket) {
    const instrumentId = parts.slice(4).join(SEPARATOR).trim()
    if (!instrumentId) return null
    return {
      market: second,
      marketType: parts[2] || '',
      exchangeId: parts[3] || '',
      instrumentId
    }
  }

  const instrumentId = part(second)
  const market = part(parts[2])
  if (!instrumentId || !market) return null
  return {
    market,
    marketType: parts[3] || '',
    exchangeId: parts.slice(4).join(SEPARATOR).trim(),
    instrumentId
  }
}

export function isEncodedSymbolTicker (ticker) {
  return decodeSymbolTicker(ticker) != null
}
