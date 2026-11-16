/**
 * The Pine libraries a chart script may import.
 *
 * PineTS does not download libraries from TradingView: a script that says
 * `import TradingView/ta/14` fails outright unless a resolver can hand back the
 * library's source. That is the right default for a library whose source the
 * caller may never have seen, but the official `ta` library is different -- it
 * is published by TradingView, it is stable, and the handful of functions our
 * stored scripts reach for are small enough to state here. Vendoring them keeps
 * those scripts runnable in the browser instead of turning them into errors.
 *
 * Only functions whose behaviour can be reproduced faithfully are declared. A
 * library we cannot reproduce is better left unresolved (the chart then reports
 * the import in its warning strip) than answered with a placeholder that draws
 * a wrong line.
 */

/**
 * `TradingView/ta` — the official helpers our scripts call.
 *
 * `requestVolumeDelta` is the only entry that matters in practice: it is what
 * volume-bubble style scripts use to split a bar into buy and sell volume.
 *
 * The upstream implementation aggregates tick/trade data that a chart datafeed
 * does not carry, so it reads the same window through `request.security` and
 * splits it on the bar's own direction. That is the same decomposition every
 * downstream formula expects (up + down = volume, delta = up - down); it only
 * differs from TradingView where intrabar prints disagree with the bar's net
 * direction, which no OHLCV feed can express.
 */
const TAV_LIBRARY = `//@version=6
library("ta")

// Four-value form of the volume split every caller destructures as
// [up, down, volume, delta].
export requestVolumeDelta(string timeframe) =>
    float opened = request.security(syminfo.tickerid, timeframe, open)
    float closed = request.security(syminfo.tickerid, timeframe, close)
    float traded = request.security(syminfo.tickerid, timeframe, volume)
    float bought = closed >= opened ? traded : 0.0
    float sold = closed < opened ? traded : 0.0
    float delta = bought - sold
    [bought, sold, traded, delta]
`

/** The libraries this build can answer for, keyed by `user/library`. */
const VENDORED = {
  'TradingView/ta': TAV_LIBRARY
}

/**
 * The library source for an import path, or null when we have none.
 *
 * `user/library/version` resolves by `user/library`, because a version bump
 * changes which release is asked for but not which library the script means --
 * and we only vendor one implementation of each.
 *
 * @param {string} path import path as written in the script
 * @returns {string|null}
 */
export function librarySource (path) {
  const parts = String(path || '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return VENDORED[`${parts[0]}/${parts[1]}`] || null
}

/** The import paths this build can serve, for error messages and tests. */
export function vendoredLibraries () {
  return Object.keys(VENDORED)
}

/**
 * A resolver in the shape `pineTS.setImportResolver` accepts.
 *
 * A plain function is a supported resolver form, so this needs no dependency on
 * PineTS's resolver classes and stays testable without the runtime.
 */
export function pineImportResolver () {
  return (path) => librarySource(path)
}
