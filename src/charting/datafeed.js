/**
 * TradingView Charting Library datafeed backed by the QuantDinger backend.
 *
 * The library asks for bars through this interface instead of owning a network
 * stack, which is why the same widget can be pointed at our own `/api/kline`
 * endpoint and keep every venue mapping the backend already resolves.
 */

import request from '@/utils/request'
import ExchangeKlineWs, { getExchangeInterval } from '@/utils/exchangeWs'

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

/** Bars per `getBars` request. The backend caps a response at 20000 rows. */
const DEFAULT_BARS = 300
const MAX_BARS_PER_REQUEST = 20000

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

/**
 * Bar time the library accepts, in milliseconds.
 *
 * `Bar.time` is documented as "Amount of **milliseconds** since Unix epoch"
 * (charting_library.d.ts, the `Bar` interface). The backend stores and serves
 * bar times in seconds, and passing those straight through put every candle in
 * 1970. The backend has sent milliseconds historically too, so both widths are
 * accepted here and normalised to milliseconds.
 */
function toBarTimeMs (value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return numeric > 1e11 ? Math.floor(numeric) : Math.floor(numeric * 1000)
}

/** One backend row as a library bar. Times are milliseconds, as the library requires. */
function parseBar (item) {
  const time = toBarTimeMs(item?.time ?? item?.timestamp)
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
 * One socket tick as a library bar.
 *
 * The venue reports the candle's open time in milliseconds, which is exactly
 * what the library keys its last bar on; the tick's own receipt time is never
 * used, or every tick would append a candle.
 */
function parseTick (tick) {
  if (!tick) return null
  const time = toBarTimeMs(tick.timestamp)
  if (time == null) return null
  const open = Number(tick.open)
  const high = Number(tick.high)
  const low = Number(tick.low)
  const close = Number(tick.close)
  if (![open, high, low, close].every(Number.isFinite)) return null
  const volume = Number(tick.volume)
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }
}

/**
 * Price scale that keeps the venue's actual decimals readable.
 *
 * A chart whose pricescale is too coarse silently rounds the last digits off
 * the axis, which is worse than an error because it looks correct.
 */function priceScaleFor (bars) {
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
  /**
   * Oldest bar time this chart has ever received, in milliseconds.
   *
   * Used to tell "the venue has no older history" apart from "this one request
   * came back empty". Only the former may end the data.
   */
  let earliestSeenMs = null
  /** The live venue socket for this chart, if one is running. */
  let stream = null
  let streamResolution = ''

  /**
   * Open the venue's public K-line socket and feed its ticks to the library.
   *
   * Crypto only: the venues we support publish a public kline stream for free,
   * while an equity needs an authenticated feed we do not proxy. When the
   * venue is not one of them, or the socket cannot be opened, the chart simply
   * keeps its history — no polling timer is introduced here.
   */
  const startStream = (resolution) => {
    if (stopped || stream) return
    const timeframe = timeframeFromResolution(resolution)
    if (!timeframe) return
    // `getExchangeInterval` is the same venue table the stream client uses, so
    // agreeing with it here means never opening a socket for a pair it cannot
    // subscribe to.
    if (!getExchangeInterval(symbolInfo.exchangeId, timeframe)) return
    const client = new ExchangeKlineWs()
    stream = client
    streamResolution = resolution
    const started = client.connect(
      symbolInfo.ticker,
      timeframe,
      {
        onTick: (tick) => {
          const bar = parseTick(tick)
          // The bar carries the candle's open time, so a repeated push updates
          // the last candle instead of growing a new one per tick.
          if (bar) pushBarInternal(bar, streamResolution)
          onRealtimeBar?.({ bar })
        },
        onError: () => {
          // The client gave up after exhausting its reconnects, or the venue
          // refused the subscription. Keep the history the chart already has
          // and leave the panes usable; a later resubscribe may retry.
          stream = null
          streamResolution = ''
        }
      },
      symbolInfo.exchangeId,
      { marketType: symbolInfo.marketType, instrumentId: symbolInfo.instrumentId }
    )
    if (!started) {
      stream = null
      streamResolution = ''
    }
  }

  const stopStream = () => {
    if (stream) stream.disconnect()
    stream = null
    streamResolution = ''
  }

  const requestParams = (extra) => ({
    market: symbolInfo.market,
    symbol: symbolInfo.ticker,
    exchange_id: symbolInfo.exchangeId || undefined,
    market_type: symbolInfo.marketType || undefined,
    instrument_id: symbolInfo.instrumentId || undefined,
    ...extra
  })

  /** Deliver a bar to the listeners registered for its resolution. */
  const pushBarInternal = (bar, resolution) => {
    if (!bar) return
    for (const [, listener] of listeners) {
      if (listener.resolution !== resolution) continue
      listener.onRealtimeCallback(bar)
    }
  }

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
      const seconds = resolutionSeconds(resolution)
      const wanted = Math.max(1, Math.min(MAX_BARS_PER_REQUEST, Number(countBack) || DEFAULT_BARS))
      // The library asks for a window, not a page: `to` is the exclusive right
      // edge and `countBack` the bar count it needs ending there. Asking the
      // backend for "the newest N bars" instead (the old `before_time` call,
      // which the endpoint ignores) returned the same page on every scroll, so
      // the client filter dropped everything and the chart locked its left
      // edge.
      const end = Number.isFinite(Number(to)) && Number(to) > 0
        ? Math.floor(Number(to))
        : Math.floor(Date.now() / 1000)
      const span = seconds > 0 ? seconds * wanted : 0
      const requestedStart = Number.isFinite(Number(from)) && Number(from) > 0
        ? Math.min(Math.floor(Number(from)), end - 1)
        : Math.max(0, end - span)
      try {
        const response = await request({
          url: '/api/market-data/candles',
          method: 'get',
          params: requestParams({ timeframe, limit: wanted, start: requestedStart, end }),
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
          .sort((a, b) => a.time - b.time)
        if (bars.length) earliestSeenMs = earliestSeenMs == null ? bars[0].time : Math.min(earliestSeenMs, bars[0].time)
        const scale = priceScaleFor(bars)
        if (scale) symbolInfo = { ...symbolInfo, pricescale: scale }
        // Claiming end-of-data on the first empty answer locks the chart for
        // good, which is exactly what a cold store used to do. Only an empty
        // page that reaches back past everything we have ever seen means the
        // history is exhausted; a transient empty answer keeps the chart able
        // to ask again.
        const endMs = end * 1000
        const exhausted = bars.length === 0 &&
          (firstDataRequest === true || (earliestSeenMs != null && endMs <= earliestSeenMs))
        onResult(bars, exhausted ? { noData: true } : {})
      } catch (err) {
        if (!stopped) onError?.(err?.message || String(err))
      }
    },

    subscribeBars (symbolInfoArg, resolution, onRealtimeCallback, listenerGuid) {
      listeners.set(listenerGuid, { resolution, onRealtimeCallback })
      onRealtimeBar?.({ listenerGuid, resolution, symbolInfo: symbolInfoArg })
      startStream(resolution)
    },

    unsubscribeBars (listenerGuid) {
      listeners.delete(listenerGuid)
      // One stream serves the chart, so it outlives a single listener only when
      // the library keeps another one (it does while a study subscribes too).
      if (listeners.size === 0) stopStream()
    },

    /**
     * Push one bar to whichever listeners asked for its resolution.
     *
     * The library wants the callback called "every time you want to update the
     * most recent bar or to add a new one" (charting_library.d.ts, the
     * subscribeBars contract), so a forming bar is forwarded too: it replaces
     * the last candle because it carries that candle's open time. Dropping
     * forming bars here -- which this method used to do -- left a live feed
     * with nothing to show until the period closed.
     */
    pushBar (bar, resolution) {
      pushBarInternal(bar, resolution)
    },

    getListenerCount () {
      return listeners.size
    },

    destroy () {
      stopped = true
      stopStream()
      listeners.clear()
    }
  }
}

export default createDatafeed
