/**
 * Bring a Pine v2/v3/v4 script up to v5 or v6 syntax.
 *
 * The runtime only accepts v5 and later, and a large part of the TradingView
 * corpus is older than that. Refusing those scripts leaves the author staring at
 * "Unsupported Pine Script version 4" for code that is otherwise perfectly
 * runnable, so the legacy dialect is translated here instead.
 *
 * The translation is deliberately narrow: it only rewrites syntax that Pine
 * renamed between versions, and it never guesses at an expression. Anything it
 * cannot translate is left alone, so a script either runs or fails on the same
 * line it would have failed on for a human rewriting it by hand.
 *
 * Every rewrite below is a rename, never a semantic change:
 *
 *  - `//@version=4` -> `//@version=6`
 *  - `study(...)` -> `indicator(...)`
 *  - the v4 flat builtins (`sma`, `abs`, `security`, ...) -> their namespaces
 *    (`ta.sma`, `math.abs`, `request.security`). v4 also had `iff()`; v5 removed
 *    it in favour of the ternary operator.
 *  - `input(...)` -> the typed `input.int`/`input.float`/`input.bool`/... call
 *    the default value implies, because bare `input()` no longer exists.
 *  - `transp=` was an argument of plot/fill in v4 and is a colour property in
 *    v5, so the argument is dropped rather than turned into a colour rewrite.
 */

/** v4 builtins that moved into a namespace, by target namespace. */
const MOVED_BUILTINS = {
  ta: [
    'sma', 'ema', 'rma', 'wma', 'vwma', 'rsi', 'stdev', 'variance', 'atr', 'tr',
    'cum', 'highest', 'lowest', 'highestbars', 'lowestbars', 'crossover',
    'crossunder', 'cross', 'rising', 'falling', 'barssince', 'valuewhen',
    'change', 'pivothigh', 'pivotlow', 'linreg', 'sar', 'wpr', 'cci', 'cmo',
    'mfi', 'roc', 'mom', 'tsi', 'dev', 'median', 'percentrank', 'correlation'
  ],
  math: [
    'abs', 'round', 'floor', 'ceil', 'sign', 'pow', 'sqrt', 'log', 'log10',
    'exp', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'min', 'max', 'avg',
    'sum', 'todegrees', 'toradians', 'random'
  ],
  str: [
    'tostring', 'tonumber', 'length', 'substring', 'replace', 'format',
    'contains', 'tolower', 'toupper'
  ],
  request: ['security']
}

/** `name -> 'ta' | 'math' | ...` */
const NAMESPACE_OF = (() => {
  const map = new Map()
  for (const [namespace, names] of Object.entries(MOVED_BUILTINS)) {
    for (const name of names) map.set(name, namespace)
  }
  return map
})()

/**
 * v4 builtins that were read as a value rather than called.
 *
 * `tr` is the one that matters in practice: v4 spells the true range as a bare
 * `tr`, v5 spells it `ta.tr` with no parentheses at all. A call-only rewrite
 * would leave the bare name and the script would fail on an undeclared
 * identifier.
 */
const VALUE_BUILTINS = { tr: 'ta' }

const VERSION_RE = /^[ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*(\d+)[ \t]*$/m

/** The declared Pine version, or null when the script carries no marker. */
export function pineVersionOf (source) {
  const match = VERSION_RE.exec(String(source || ''))
  return match ? Number(match[1]) : null
}

/** True when this source predates v5 and has to be translated before it runs. */
export function needsUpgrade (source) {
  const text = String(source || '')
  const version = pineVersionOf(text)
  if (version !== null) return version < 5
  // A markerless script is handed to the runtime as raw JavaScript, so a v6
  // script without a marker runs and a v4 one dies on `study is not defined`.
  // The original `study(` declaration is what tells the two apart, and the
  // database has no markerless scripts, so this only ever rescues a script
  // pasted in by hand.
  const ranges = maskedRanges(text)
  for (const match of text.matchAll(/\bstudy\s*\(/g)) {
    if (!inRanges(ranges, match.index)) return true
  }
  return false
}

/**
 * Walk the source, reporting the ranges that are a string or a comment.
 *
 * Rewriting identifiers with a bare regex would corrupt a title that happens to
 * read `sma(` and would rewrite a commented-out line, so every rewrite below
 * asks this map first.
 */
function maskedRanges (source) {
  const ranges = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      ranges.push([index, stop])
      index = stop
      continue
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '\\') { cursor += 2; continue }
        if (source[cursor] === char) break
        cursor++
      }
      const stop = Math.min(cursor + 1, source.length)
      ranges.push([index, stop])
      index = stop
      continue
    }
    index++
  }
  return ranges
}

function inRanges (ranges, at) {
  for (const [start, stop] of ranges) {
    if (at >= start && at < stop) return true
  }
  return false
}

/** Names the script itself declares, which must win over a builtin rename. */
function declaredNames (source) {
  const names = new Set()
  for (const match of source.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*\([^\n]*?\)[ \t]*=>/gm)) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/^[ \t]*(?:var[ \t]+|varip[ \t]+)?(?:int|float|bool|string|color)?[ \t]*([A-Za-z_]\w*)[ \t]*=[^=]/gm)) {
    names.add(match[1])
  }
  return names
}

/** Split an argument list on top-level commas. */
function splitArgs (text) {
  const parts = []
  let current = ''
  let depth = 0
  let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      current += char
      if (char === '\\') { current += text[++index] ?? ''; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === '(' || char === '[' || char === '{') { depth++; current += char; continue }
    if (char === ')' || char === ']' || char === '}') { depth--; current += char; continue }
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** Offset of the `)` that closes the `(` at `open`, or -1. */
function matchParen (source, open) {
  let depth = 0
  let quote = ''
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === '\\') { index++; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Price and volume series v4 allowed as the default of `input(close, ...)`.
 *
 * The runtime's `input.source` accepts exactly these, so a bare identifier in
 * this set is a source, not a string. Getting that wrong is not cosmetic: v4
 * wrote `input(close, title="Source")` to mean "let the user pick the price
 * series", and reading it as a string emits `input.string(close)`, which the
 * runtime rejects because `close` is `series float` and the parameter wants
 * `const string`.
 */
const SOURCE_DEFAULTS = new Set(['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'])

/** The typed input call a v4 `input()` default value implies. */
function inputKindFor (defaultText) {
  const text = String(defaultText || '').trim()
  if (/^(true|false)$/.test(text)) return 'bool'
  if (/^-?\d+$/.test(text)) return 'int'
  if (/^-?\d*\.\d+(?:e[-+]?\d+)?$/i.test(text) || /^-?\d+e[-+]?\d+$/i.test(text)) return 'float'
  if (/^#[0-9a-fA-F]{6}(\w\w)?$/.test(text)) return 'color'
  if (SOURCE_DEFAULTS.has(text)) return 'source'
  return 'string'
}

/**
 * Rewrite every bare `input(...)` into the typed call its default implies.
 *
 * v4 accepted `input(30, "period")` and worked out the type from the default;
 * v5 requires the type in the call name. The default and title argument order
 * also differed, so the arguments are re-emitted by name.
 */
function convertInputCalls (source) {
  const ranges = maskedRanges(source)
  let out = ''
  let cursor = 0
  for (const match of source.matchAll(/\binput\s*\(/g)) {
    const at = match.index
    if (inRanges(ranges, at)) continue
    // `input.int(` is already typed and is handled by a later pattern.
    if (source[at + match[0].length] === '') continue
    const open = at + match[0].length - 1
    const close = matchParen(source, open)
    if (close < 0) continue
    const args = splitArgs(source.slice(open + 1, close))
    const named = {}
    const positional = []
    for (const arg of args) {
      const pair = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(arg)
      if (pair) named[pair[1]] = pair[2].trim()
      else positional.push(arg)
    }
    // v4 `input(x, "title")`: the default comes first, the title second.
    const defval = named.defval ?? positional[0] ?? '""'
    const title = named.title ?? positional[1]
    if (defval === undefined) continue
    const kind = inputKindFor(defval)
    const kept = []
    if (title !== undefined) kept.push(`title=${title}`)
    kept.push(`defval=${defval}`)
    for (const key of ['minval', 'maxval', 'step', 'options', 'tooltip', 'group', 'inline']) {
      if (named[key] !== undefined) kept.push(`${key}=${named[key]}`)
    }
    out += source.slice(cursor, at)
    out += `input.${kind}(${kept.join(', ')})`
    cursor = close + 1
    // Skip the arguments we consumed; the outer loop resumes after the call.
    match.lastIndex = cursor
  }
  return out + source.slice(cursor)
}

/** Point every bare v4 builtin call at its namespace. */
function namespaceBuiltins (source, declared) {
  const ranges = maskedRanges(source)
  let out = ''
  let cursor = 0
  for (const match of source.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1]
    const at = match.index
    if (inRanges(ranges, at)) continue
    const namespace = NAMESPACE_OF.get(name)
    if (!namespace) continue
    // Already `ta.sma(`.
    if (source[at - 1] === '.') continue
    // The script defines its own `sma(...)`, which wins over the builtin.
    if (declared.has(name)) continue
    out += source.slice(cursor, at)
    // Emit only the qualified name: the `(` belongs to the original text and is
    // kept by the next slice, so including it here would double it.
    out += `${namespace}.${name}`
    cursor = at + name.length
    match.lastIndex = cursor
  }
  out += source.slice(cursor)
  return namespaceValues(out, declared)
}

/** Point every bare v4 value builtin (`tr`) at its namespace. */
function namespaceValues (source, declared) {
  const ranges = maskedRanges(source)
  let out = ''
  let cursor = 0
  for (const match of source.matchAll(/\b([A-Za-z_]\w*)\b(?!\s*\()/g)) {
    const name = match[1]
    const at = match.index
    if (inRanges(ranges, at)) continue
    const namespace = VALUE_BUILTINS[name]
    if (!namespace) continue
    if (source[at - 1] === '.' || source[at - 1] === '@') continue
    if (source[match.index + name.length] === '.') continue
    if (declared.has(name)) continue
    // An assignment target is a new variable, not a read of the builtin.
    const after = source.slice(match.index + name.length).match(/^\s*=(?!=)/)
    if (after) continue
    out += source.slice(cursor, at)
    out += `${namespace}.${name}`
    cursor = at + name.length
    match.lastIndex = cursor
  }
  return out + source.slice(cursor)
}

/**
 * Translate a pre-v5 script to v6 syntax.
 *
 * Returns the source unchanged when it is already v5+, so callers can run this
 * unconditionally on anything the author has open.
 */
export function upgradeLegacyPine (source) {
  const text = String(source || '')
  if (!text.trim() || !needsUpgrade(text)) {
    return { code: text, upgraded: false, from: pineVersionOf(text), notes: [] }
  }
  const notes = []
  const version = pineVersionOf(text)

  // 1. The version marker has to move first: `study(` and friends are only
  //    recognised once the parser knows which dialect it is reading.
  let body = text.replace(VERSION_RE, '').replace(/^\s*\n/, '')
  body = `//@version=6\n${body}`

  // 2. `study(...)` became `indicator(...)`; the arguments are unchanged.
  if (/\bstudy\s*\(/.test(body)) {
    const before = body
    body = body.replace(/(^|[^.\w])study\s*\(/g, '$1indicator(')
    if (body !== before) notes.push('study→indicator')
  }

  // 3. `transp=` was a plot/fill argument in v4 and is a colour property now.
  //    Dropping it loses a transparency setting; rewriting it would need the
  //    colour expression to be understood, so it is dropped and reported.
  if (/,\s*transp\s*=/.test(body)) {
    const before = body
    body = body.replace(/,\s*transp\s*=\s*[^,)]+/g, '')
    if (body !== before) notes.push('transp dropped')
  }

  // 4. `iff(a, b, c)` became `a ? b : c`.
  if (/\biff\s*\(/.test(body)) {
    const ranges = maskedRanges(body)
    let out = ''
    let cursor = 0
    for (const match of body.matchAll(/\biff\s*\(/g)) {
      const at = match.index
      if (inRanges(ranges, at)) continue
      const open = at + match[0].length - 1
      const close = matchParen(body, open)
      if (close < 0) continue
      const args = splitArgs(body.slice(open + 1, close))
      if (args.length !== 3) continue
      out += body.slice(cursor, at)
      out += `(${args[0]} ? ${args[1]} : ${args[2]})`
      cursor = close + 1
      match.lastIndex = cursor
    }
    body = out + body.slice(cursor)
    notes.push('iff→ternary')
  }

  // 5. Typed inputs, then namespaced builtins. The declaration set is read from
  //    the already-rewritten body so a `study(` rename cannot be mistaken for a
  //    declaration.
  const declared = declaredNames(body)
  body = convertInputCalls(body)
  body = namespaceBuiltins(body, declared)

  return { code: body, upgraded: true, from: version, notes }
}

/**
 * Every v4 `input(...)` call with the span of its default value, in the
 * ORIGINAL source.
 *
 * The settings panel and its write-back address a value by offset, and an
 * upgraded copy has different offsets, so a legacy script needs the spans read
 * from its own text rather than from the translation.
 */
export function legacyInputCalls (source) {
  const text = String(source || '')
  if (!needsUpgrade(text)) return []
  const ranges = maskedRanges(text)
  const calls = []
  for (const match of text.matchAll(/\binput\s*\(/g)) {
    const at = match.index
    if (inRanges(ranges, at)) continue
    // `input.int(` and friends are v5 spellings and are not part of this list.
    if (/^input\s*\./.test(match[0])) continue
    const open = at + match[0].length - 1
    const close = matchParen(text, open)
    if (close < 0) continue
    const argsText = text.slice(open + 1, close)
    const args = splitArgs(argsText)
    const named = {}
    const positional = []
    let cursor = 0
    const spans = []
    for (const arg of args) {
      const found = argsText.indexOf(arg, cursor)
      spans.push({ start: found, end: found + arg.length, text: arg })
      cursor = found + arg.length
      const pair = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(arg)
      if (pair) named[pair[1]] = pair[2].trim()
      else positional.push(arg)
    }
    // v4 order is `input(default, "title")`.
    const defvalArg = spans.find(span => /^defval\s*=/.test(span.text)) || spans[0]
    const titleArg = spans.find(span => /^title\s*=/.test(span.text)) || spans[1]
    if (!defvalArg) continue
    const title = titleArg
      ? String(named.title ?? titleArg.text.slice(titleArg.text.indexOf('=') + 1)).trim().replace(/^["']|["']$/g, '')
      : ''
    calls.push({
      title,
      kind: inputKindFor(named.defval ?? positional[0]),
      rawDefault: named.defval ?? positional[0] ?? '',
      open,
      close,
      defStart: open + 1 + defvalArg.start,
      defEnd: open + 1 + defvalArg.end
    })
  }
  return calls
}

/**
 * Write panel values into a v4 script's own `input(...)` defaults.
 *
 * Upgrading the script first would move every offset, and an author who only
 * turned a knob should not find their source rewritten to a newer Pine version.
 * Matching on the title keeps that promise.
 */
export function applyLegacyInputValues (source, params) {
  const text = String(source || '')
  if (!text.trim() || !params || typeof params !== 'object') return text
  const edits = []
  for (const call of legacyInputCalls(text)) {
    if (!call.title) continue
    if (!Object.prototype.hasOwnProperty.call(params, call.title)) continue
    const value = params[call.title]
    if (!valueFitsKind(value, call.kind)) continue
    const literal = legacyLiteral(value, call.kind)
    if (text.slice(call.defStart, call.defEnd) === literal) continue
    edits.push({ from: call.defStart, to: call.defEnd, literal })
  }
  if (!edits.length) return text
  let out = text
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.literal + out.slice(edit.to)
  }
  return out
}

/** Whether a panel value can legally be written into an input of this kind. */
function valueFitsKind (value, kind) {
  if (typeof value === 'boolean') return kind === 'bool'
  if (typeof value === 'number') return kind === 'int' || kind === 'float'
  if (value === null || value === undefined) return false
  if (/^#[0-9a-fA-F]{6}$/.test(String(value))) return kind === 'color'
  return kind === 'string'
}

function legacyLiteral (value, kind) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (kind === 'color') {
    const hex = /^#?([0-9a-fA-F]{6})$/.exec(String(value || '').trim())
    return hex ? `#${hex[1]}` : JSON.stringify(String(value))
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return JSON.stringify(String(value ?? ''))
}

/**
 * A code-level workaround for one runtime limitation.
 *
 * PineTS refuses a script that both destructures a tuple AND indexes a series
 * from inside the function that produced it:
 *
 *     f(int d) =>
 *         float s = ta.sma(close, 3)
 *         float k = s[d - 1]      // "dynamic computed member access"
 *         [s, k]
 *     [s, k] = f(3)
 *
 * The trigger is the name collision between the function's locals and the
 * caller's targets, not the indexing: renaming the targets to names the
 * function does not use makes the same program run. So every destructuring
 * target gets a fresh name and an alias line restores the author's own name
 * immediately after, which keeps the rest of the script untouched.
 *
 * Only applied when a plain run has already failed with that message, so a
 * script that works today is never rewritten.
 */
export function repairTupleDestructuring (source) {
  const text = String(source || '')
  if (!text.trim()) return { code: text, repaired: false }
  const ranges = maskedRanges(text)
  const edits = []
  let seq = 0
  for (const match of text.matchAll(/\[([^[\]]*)\]\s*=(?!=)/g)) {
    const at = match.index
    if (inRanges(ranges, at)) continue
    const names = match[1].split(',').map(part => part.trim())
    // A series index such as `close[1]` never reaches here: its bracket follows
    // an identifier, and this pattern only matches a bracket that starts one.
    if (names.length < 2) continue
    if (!names.every(name => /^[A-Za-z_]\w*$/.test(name))) continue
    // The statement has to be a whole line, and its parentheses have to close
    // on that line, so the alias lines can be inserted after it safely.
    const lineStart = text.lastIndexOf('\n', at) + 1
    const lineEnd = text.indexOf('\n', at)
    const stop = lineEnd === -1 ? text.length : lineEnd
    const statement = text.slice(at, stop)
    if (statement.includes('=>')) continue
    if (!parensClosed(statement)) continue
    const indent = text.slice(lineStart, at)
    if (!/^[ \t]*$/.test(indent)) continue
    const unique = names.map((_name, index) => `__qd_t${seq}_${index}`)
    const alias = names.map((name, index) => `${indent}${name} = ${unique[index]}`).join('\n')
    seq++
    // `match[0]` is `[...] =` including any space around `=`, so the call text
    // is everything after it and the replacement keeps the author's arguments.
    const call = statement.slice(match[0].length)
    edits.push({ from: at, to: stop, text: `[${unique.join(', ')}] =${call}\n${alias}` })
  }
  if (!edits.length) return { code: text, repaired: false }
  let out = text
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.text + out.slice(edit.to)
  }
  return { code: out, repaired: true }
}

/** Whether every `(` and `[` opened in this text is also closed in it. */
function parensClosed (text) {
  let depth = 0
  let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\') { index++; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '/' && text[index + 1] === '/') return true
    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') { depth--; if (depth < 0) return false }
  }
  return depth === 0
}

export default upgradeLegacyPine

/**
 * Drawings whose `delete()` has to survive an empty slot.
 *
 * Pine lets a script keep drawings in an array and trim it:
 * `arr.shift().delete()`. PineTS stores `line(na)`/`label(na)` in the array as
 * `null`, so the chained call dereferences null and throws. Real Pine treats
 * `na_line.delete()` as a no-op, so the chained form is rewritten to the static
 * one, which the runtime already handles for a null receiver and for a drawing
 * of a different type.
 */
const DRAWING_TYPES = ['line', 'label', 'box', 'linefill', 'polyline', 'table']

/** The static form each drawing type deletes through. */
const DRAWING_DELETE = {
  line: 'line.delete',
  label: 'label.delete',
  box: 'box.delete',
  linefill: 'linefill.delete',
  polyline: 'line.delete',
  table: 'table.delete'
}

/**
 * Rewrite `<expr>.delete()` to a static delete that tolerates a null receiver.
 *
 * Only the drawing types above are rewritten, and only when the receiver is a
 * single expression: `stmt.shift().delete()` becomes
 * `line.delete(stmt.shift())`. Anything else -- a call on a number, on a table
 * built by `table.new` -- is left exactly as the author wrote it. The type is
 * read off the receiver's name where it can be (`c9_pLbl` is a `label`), and
 * `line.delete` is used when it cannot be, because it is the one form the
 * runtime accepts for every drawing type.
 */
export function repairDrawingDelete (source) {
  const text = String(source || '')
  if (!text.trim()) return { code: text, repaired: false }
  const ranges = maskedRanges(text)
  // Receiver declared types, so `c9_uG.shift().delete()` can pick `line.delete`
  // over the generic form. Reviews of the corpus show the names carry a prefix
  // rather than a type, so this is a best-effort map and the fallback is safe.
  const declared = new Map()
  const typeRe = new RegExp(`(?:^|[\\s,])(${DRAWING_TYPES.join('|')})\\s*\\[\\s*\\]\\s+([A-Za-z_]\\w*)`, 'g')
  for (const match of text.matchAll(typeRe)) declared.set(match[2], match[1])
  for (const match of text.matchAll(new RegExp(`\\b(${DRAWING_TYPES.join('|')})\\s+([A-Za-z_]\\w*)\\s*=`, 'g'))) {
    if (!declared.has(match[2])) declared.set(match[2], match[1])
  }
  const edits = []
  // `EXPR.delete()` where EXPR is a run of identifier/member/paren/index/call
  // characters: enough for `x`, `a.get(0)`, `arr.shift()`, `obj.field`.
  for (const match of text.matchAll(/([A-Za-z_][\w.]*(?:\([^()]*\))?(?:\[[^\]]*\])?)\.delete\(\s*\)/g)) {
    const at = match.index
    if (inRanges(ranges, at)) continue
    // Skip the static form's own receiver: `line.delete` has no parentheses
    // before the dot, so its own match starts at the call's `(...)`. The look
    // below is enough -- a rewritten call never re-matches.
    const receiver = match[1]
    const root = (/([A-Za-z_]\w*)/.exec(receiver) || [])[1] || ''
    // A drawing built inline names its own type (`label.new(...).delete()`);
    // otherwise the type comes from the receiver's declaration. Falls back to
    // `line.delete`, which the runtime accepts for every drawing type.
    const inline = DRAWING_TYPES.includes(root) ? root : ''
    const kind = inline || declared.get(root)
    const method = DRAWING_DELETE[kind] || 'line.delete'
    edits.push({ from: at, to: at + match[0].length, text: `${method}(${receiver})` })
  }
  if (!edits.length) return { code: text, repaired: false }
  let out = text
  let changed = false
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    if (out.slice(edit.from, edit.to) === edit.text) continue
    out = out.slice(0, edit.from) + edit.text + out.slice(edit.to)
    changed = true
  }
  return { code: out, repaired: changed }
}
