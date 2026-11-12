/**
 * TradingView Charting Library datafeed backed by the QuantDinger backend.
 *
 * The library asks for bars through this interface instead of owning a network
 * stack, which is why the same widget can be pointed at our own `/api/kline`
 * endpoint and keep every venue mapping the backend already resolves.
 */

import request from '@/utils/request'

/**
 * Library resolution -> the timeframe name the backend accepts.
 *
 * The library counts minutes ("60"), while `/api/market-data/candles` speaks
 * the venue vocabulary ("1H"). Keeping the translation in one table means a
 * resolution the backend does not know is rejected up front instead of
 * arriving as an unsupported-timeframe error on every bar request.
 */
const RESOLUTION_TIMEFRAMES = {
  1: '1m',
  3: '3m',
  5: '5m',
  15: '15m',
  30: '30m',
  60: '1H',
  240: '4H',
  '1D': '1D',
  '1W': '1W'
}

const RESOLUTION_SECONDS = {
  D: 86400,
  W: 604800
}

/**
 * Translate the library's resolution into the timeframe the backend expects.
 *
 * The library speaks in minutes ("60") while the backend names the same bar
 * "1H". Anything the backend does not know is rejected so the widget shows an
 * honest error instead of an empty chart.
 */
export function timeframeFromResolution (resolution) {
  const raw = String(resolution || '').trim()
  if (RESOLUTION_TIMEFRAMES[raw]) return RESOLUTION_TIMEFRAMES[raw]
  const asNumber = Number(raw)
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null
  return RESOLUTION_TIMEFRAMES[String(asNumber)] || null
}

/** Seconds per bar for a resolution, used to discard the still-forming bar. */
export function resolutionSeconds (resolution) {
  const raw = String(resolution || '').trim().toUpperCase()
  if (RESOLUTION_SECONDS[raw]) return RESOLUTION_SECONDS[raw]
  const asNumber = Number(raw)
  if (!Number.isFinite(asNumber) || asNumber <= 0) return 0
  // A bare resolution is a count of minutes regardless of size, so "1" is one
  // minute and "240" is four hours; there is no seconds form in this branch.
  return asNumber * 60
}

/**
 * Build the symbol descriptor the library renders in its legend.
 *
 * `pricescale` comes from the venue's own precision once the first bars arrive,
 * but resolution happens before any bar is fetched, so a permissive default is
 * used here and corrected in `getBars`.
 */
/** Session and instrument type per market: an equity is not a 24x7 crypto pair. */
const MARKET_PROFILES = {
  Crypto: { type: 'crypto', session: '24x7', timezone: 'Etc/UTC', pricescale: 1000000 },
  USStock: { type: 'stock', session: '0930-1600', timezone: 'America/New_York', pricescale: 10000 },
  CNStock: { type: 'stock', session: '0930-1130,1300-1500', timezone: 'Asia/Shanghai', pricescale: 10000 },
  HKStock: { type: 'stock', session: '0930-1200,1300-1600', timezone: 'Asia/Hong_Kong', pricescale: 10000 },
  Forex: { type: 'forex', session: 'sunrise-2359,0-1700', timezone: 'Etc/UTC', pricescale: 100000 },
  Futures: { type: 'futures', session: '24x7', timezone: 'America/Chicago', pricescale: 10000 }
}

export function buildSymbolInfo ({ symbol, market, exchangeId, marketType, instrumentId, timeframe }) {
  const ticker = String(symbol || '').trim()
  const marketLabel = String(market || 'Crypto').trim()
  const profile = MARKET_PROFILES[marketLabel] || MARKET_PROFILES.Crypto
  return {
    name: ticker,
    ticker: ticker,
    description: exchangeId ? `${ticker} · ${exchangeId}` : ticker,
    type: profile.type,
    session: profile.session,
    timezone: profile.timezone,
    exchange: marketLabel,
    listed_exchange: marketLabel,
    format: 'price',
    pricescale: profile.pricescale,
    minmov: 1,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    has_empty_bars: true,
    supports_marks: false,
    supports_timescale_marks: false,
    supports_time: true,
    // Only resolutions the backend actually serves; offering 2H here would let
    // the user pick a bar the data source rejects.
    intraday_multipliers: ['1', '3', '5', '15', '30', '60', '240'],
    data_status: 'streaming',
    // Carried through the library's opaque symbol object so getBars and the
    // realtime stream do not have to re-resolve the venue.
    market: marketLabel,
    exchangeId: exchangeId || '',
    marketType: marketType || '',
    instrumentId: instrumentId || '',
    timeframe: timeframe || ''
  }
}

function toUnixSeconds (value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  // The backend has sent both seconds and milliseconds historically; anything
  // past the year 2286 in seconds is really milliseconds.
  return numeric > 1e11 ? Math.floor(numeric / 1000) : Math.floor(numeric)
}

function parseBar (item) {
  const time = toUnixSeconds(item?.time ?? item?.timestamp)
  if (time == null) return null
  const open = Number(item?.open)
  const high = Number(item?.high)
  const low = Number(item?.low)
  const close = Number(item?.close)
  if (![open, high, low, close].every(Number.isFinite)) return null
  const volume = Number(item?.volume)
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }
}

/**
 * Price scale that keeps the venue's actual decimals readable.
 *
 * A chart whose pricescale is too coarse silently rounds the last digits off
 * the axis, which is worse than an error because it looks correct.
 */
function priceScaleFor (bars) {
  if (!bars.length) return null
  const smallest = bars.reduce((acc, bar) => {
    const value = Math.abs(bar.close)
    return value > 0 && value < acc ? value : acc
  }, Number.POSITIVE_INFINITY)
  if (!Number.isFinite(smallest)) return null
  const decimals = smallest >= 100 ? 2 : smallest >= 1 ? 4 : smallest >= 0.01 ? 6 : 8
  return 10 ** decimals
}

/**
 * Create a datafeed bound to one chart context.
 *
 * The library instantiates a datafeed per chart and calls these methods in a
 * fixed order, so state that belongs to the chart lives in this closure rather
 * than in module scope where two charts would collide.
 */
export function createDatafeed ({ market, symbol, exchangeId, marketType, instrumentId, timeframe, onRealtimeBar }) {
  let symbolInfo = buildSymbolInfo({ symbol, market, exchangeId, marketType, instrumentId, timeframe })
  const listeners = new Map()
  let stopped = false

  const requestParams = (extra) => ({
    market: symbolInfo.market,
    symbol: symbolInfo.ticker,
    exchange_id: symbolInfo.exchangeId || undefined,
    market_type: symbolInfo.marketType || undefined,
    instrument_id: symbolInfo.instrumentId || undefined,
    ...extra
  })

  return {
    onReady (callback) {
      // The library tolerates an async answer here and needs it: reporting
      // support synchronously makes some builds render before the theme loads.
      setTimeout(() => {
        // Not a Node-style error-first callback: the library's onReady takes the
        // configuration object as its first argument, so the literal is correct.
        // eslint-disable-next-line node/no-callback-literal
        callback({
          supported_resolutions: ['1', '3', '5', '15', '30', '60', '240', '1D', '1W'],
          exchanges: [
            { value: symbolInfo.market, name: symbolInfo.market, desc: symbolInfo.market }
          ],
          symbols_types: [{ name: 'All', value: 'all' }],
          currency_codes: ['USD', 'USDT', 'USDC']
        })
      }, 0)
    },

    resolveSymbol (requestedName, onResolve, onError) {
      try {
        if (requestedName) {
          symbolInfo = { ...symbolInfo, name: requestedName, ticker: requestedName }
        }
        onResolve(symbolInfo)
      } catch (err) {
        onError?.(err)
      }
    },

    async getBars (symbolInfoArg, resolution, periodParams, onResult, onError) {
      const timeframe = timeframeFromResolution(resolution)
      if (!timeframe) {
        onError(`Unsupported resolution ${resolution}`)
        return
      }
      const { from, to, countBack, firstDataRequest } = periodParams || {}
      // countBack is a hard requirement: asking for a fixed limit and then
      // filtering client side leaves gaps whenever the venue is closed, which
      // the library renders as a broken chart.
      const limit = Math.max(1, Math.min(1000, Number(countBack) || 300))
      try {
        const response = await request({
          url: '/api/market-data/candles',
          method: 'get',
          params: requestParams({ timeframe, limit, before_time: firstDataRequest ? undefined : Math.ceil((to || 0)) }),
          timeout: 45000
        })
        if (stopped) return
        if (response?.code !== 1 || !Array.isArray(response.data)) {
          onError?.(response?.msg || 'Failed to load bars')
          return
        }
        const bars = response.data
          .map(parseBar)
          .filter(Boolean)
          .filter(bar => (!from || bar.time >= from) && (!to || bar.time <= to))
          .sort((a, b) => a.time - b.time)
        const scale = priceScaleFor(bars)
        if (scale) symbolInfo = { ...symbolInfo, pricescale: scale }
        onResult(bars, { noData: bars.length === 0 })
      } catch (err) {
        if (!stopped) onError?.(err?.message || String(err))
      }
    },

    subscribeBars (symbolInfoArg, resolution, onRealtimeCallback, listenerGuid) {
      listeners.set(listenerGuid, { resolution, onRealtimeCallback })
      onRealtimeBar?.({ listenerGuid, resolution, symbolInfo: symbolInfoArg })
    },

    unsubscribeBars (listenerGuid) {
      listeners.delete(listenerGuid)
    },

    /**
     * Push one bar to whichever listeners asked for its resolution.
     *
     * Bars are only forwarded once their period has closed, because the library
     * treats every callback as a finished bar and will otherwise rewrite the
     * last candle with a half-formed one.
     */
    pushBar (bar, resolution) {
      if (!bar) return
      const seconds = resolutionSeconds(resolution)
      if (seconds && Date.now() < (bar.time + seconds) * 1000) return
      for (const [, listener] of listeners) {
        if (listener.resolution !== resolution) continue
        listener.onRealtimeCallback(bar)
      }
    },

    getListenerCount () {
      return listeners.size
    },

    destroy () {
      stopped = true
      listeners.clear()
    }
  }
}

export default createDatafeed
