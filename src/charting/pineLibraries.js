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
 * A library body that declares nothing.
 *
 * Used only while *reading a script's inputs*. Transpiling a script needs each
 * import to resolve to a parseable library, but it does not need that library's
 * functions to exist -- and an empty body satisfies the parser while binding no
 * names. So a script that imports Trendoscope can still show its settings panel
 * instead of reporting an unresolvable import for a library it may only touch
 * on one branch.
 *
 * It must never be used to *run* a script: the first `ut.Theme` would be a
 * property of nothing.
 */
const EMPTY_LIBRARY = '//@version=6\nlibrary("stub")\n'

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
export function pineImportResolver ({ allowMissing = false, source = '' } = {}) {
  return (path) => {
    const vendored = librarySource(path)
    if (vendored) return vendored
    if (!allowMissing) return null
    // Stubbed from the script that needs it, not from a fixed body: the members
    // a study names are the ones the stub has to carry, and a script that names
    // a hundred of them is no different from this code's point of view.
    return source ? libraryStub(source, path) : EMPTY_LIBRARY
  }
}

/**
 * Name the libraries an import list needs but this build does not carry.
 *
 * The runtime's own message names one path and talks about
 * `pineTS.setImportResolver`, which is an implementation detail the author
 * cannot act on and cannot see. This turns the same fact into "this build does
 * not bundle X", which is both true and the reason the study is missing from
 * the chart.
 */
export function missingLibraries (paths) {
  const needed = (paths || []).filter(path => !librarySource(path))
  return [...new Set(needed.map(path => String(path).split('/').slice(0, 2).join('/')))]
}

/** The `import` paths a script names, in source order. */
export function importPaths (source) {
  const paths = []
  const re = /^\s*import\s+([A-Za-z_][\w./]*)(?:\s+as\s+\w+)?\s*$/gm
  let match
  while ((match = re.exec(String(source || ''))) !== null) paths.push(match[1])
  return paths
}

/** `alias -> import path` for every aliased import in a script. */
export function importAliases (source) {
  const aliases = new Map()
  const re = /^\s*import\s+([A-Za-z_][\w./]*)\s+as\s+([A-Za-z_]\w*)\s*$/gm
  let match
  while ((match = re.exec(String(source || ''))) !== null) aliases.set(match[2], match[1])
  return aliases
}

/** Whether `alias.member(` appears in the script, for any alias of `path`. */
function isCalled (source, path, member) {
  for (const [alias, aliasPath] of importAliases(source)) {
    if (aliasPath !== path) continue
    if (new RegExp(`\\b${alias}\\.${member}\\s*\\(`).test(String(source || ''))) return true
  }
  return false
}

/** Whether `alias.member` names a type, as in `array<zg.Zigzag>` or a declaration. */
function isTypeUsed (source, path, member) {
  const text = String(source || '')
  for (const [alias, aliasPath] of importAliases(source)) {
    if (aliasPath !== path) continue
    const dotted = `${alias}\\.${member}\\b`
    // `zg.Zigzag.new(...)` constructs a user-defined type: the member is the
    // type, `new` is its constructor. A plain `zg.Zigzag(` call would be a
    // different thing, and Pine has none of those.
    if (new RegExp(`${dotted}\\.new\\s*\\(`).test(text)) return true
    // `array.new<o.OHLC>()` is the usual spelling, so the constructor call sits
    // between the collection and the type argument.
    if (new RegExp(`(array|matrix)(\\.\\w+)?<${dotted}`).test(text)) return true
    if (new RegExp(`map(\\.\\w+)?<[^,]+,\\s*${dotted}`).test(text)) return true
    if (new RegExp(`^\\s*${dotted}\\s+[A-Za-z_]`, 'm').test(text)) return true
    if (new RegExp(`\\btype\\b[^\\n]*${dotted}`).test(text)) return true
  }
  return false
}

/**
 * A stand-in library for one this build does not bundle.
 *
 * PineTS runs a script against a library it only partly satisfies, as long as
 * every member the script *names* exists. So the members are read out of the
 * script itself: `LEI.lei(close)` needs an `lei` in the library, and nothing
 * else does. What the stub returns is `na`, which is exactly what an
 * unavailable reading is, and scripts written against these libraries already
 * handle `na` -- they have to, because their inputs can be switched off.
 *
 * That is the honest part: the study draws, and the sections that depend on the
 * library come out blank instead of showing a made-up number. It is also why
 * this must not be described as a faithful reimplementation.
 *
 * Types are stubbed too, because a script may write `array<zg.Zigzag>` in a
 * declaration, and a missing type is a parse error while a missing value is
 * only an `na`.
 */
export function libraryStub (source, path) {
  const name = String(path || '').split('/').slice(0, 2).join('/')
  const members = new Set()
  for (const [alias, aliasPath] of importAliases(source)) {
    if (aliasPath !== path) continue
    const re = new RegExp(`\\b${alias}\\.([A-Za-z_]\\w*)`, 'g')
    let match
    while ((match = re.exec(String(source || ''))) !== null) members.add(match[1])
  }
  const lines = ['//@version=6', `library(${JSON.stringify(name)})`]
  const fields = stubFields(source)
  for (const member of [...members].sort()) {
    if (isCalled(source, path, member)) lines.push(`export ${member}() => na`)
    else if (isTypeUsed(source, path, member)) {
      lines.push(`export type ${member}`)
      for (const field of fields) lines.push(`    float ${field}`)
      if (!fields.length) lines.push('    float value')
    } else {
      lines.push(`export enum ${member}`, '    DARK', '    LIGHT')
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Field names a stubbed type has to carry.
 *
 * A stub type that lacks a field the script reads breaks at run time --
 * `zigzag.flags` is `undefined`, and `.newPivot` on that throws. Too many fields
 * is harmless (a wrong field is only ever read, never written by the stub's own
 * code), so every dotted name in the script that is not a well-known Pine
 * namespace goes in. The receiver cannot be resolved without a real type
 * checker, and this is a stand-in, not a compiler.
 */
function stubFields (source) {
  const namespaces = new Set([
    'ta', 'math', 'str', 'array', 'matrix', 'map', 'request', 'input', 'color',
    'label', 'line', 'box', 'table', 'strategy', 'timeframe', 'syminfo',
    'barstate', 'display', 'shape', 'location', 'size', 'format', 'alert', 'chart'
  ])
  for (const alias of importAliases(source).keys()) namespaces.add(alias)
  const receivers = new Set()
  const fields = new Set()
  const text = String(source || '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  // `z.flags.newPivot` is what makes `flags` load-bearing; `zg.Zigzag.new()` is a
  // library member, and the member name is not a field of anything.
  const re = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g
  let match
  while ((match = re.exec(text)) !== null) {
    if (namespaces.has(match[1])) continue
    // `a.b.c` reads `c` off the object in field `b`, so `b` has to hold an
    // object. Pine has no field defaults, and a library cannot declare a
    // constructor for its own type (`Only functions, methods, types`), so the
    // stub cannot fill it. It is positioned first instead: the type's field
    // order is arbitrary here, and Pine leaves a field that `new()` was not
    // given an `na` -- and reading a property off that is what throws.
    if (match[3]) receivers.add(match[2])
    fields.add(match[2])
  }
  return [...receivers].sort().concat([...fields].sort().filter(name => !receivers.has(name)))
}
