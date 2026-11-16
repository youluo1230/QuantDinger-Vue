/**
 * Read the settings a Pine script declares.
 *
 * The Indicator IDE builds its parameter panel from this, so it has to be
 * synchronous and tolerant: the author is typing, and a panel that blanks out
 * on an unterminated call is worse than one that shows the settings it could
 * read. PineTS also exposes `getInputsMeta()`, but that needs a transpile pass
 * and a promise, so it is used where accuracy matters (the run) and this is
 * used where immediacy matters (the form).
 *
 * What is parsed is the declaration grammar, not Pine:
 *
 *     input.int(14, "Lookback", minval = 1, maxval = 200, group = "Params")
 *
 * The first positional argument is the default and the second is the title,
 * which is the order TradingView documents. Named `defval=`/`title=` forms and
 * a bare `input(...)` are recognised too.
 *
 * A v2/v3/v4 script is read through `pineUpgrade.js` instead, because the bare
 * `input(30, "period")` form it uses carries no type in the call name.
 */

import { applyLegacyInputValues, needsUpgrade, upgradeLegacyPine } from './pineUpgrade.js'

/** Pine's input constructors and the panel type each one renders as. */
const INPUT_TYPES = {
  int: 'int',
  float: 'float',
  bool: 'bool',
  string: 'str',
  color: 'color',
  source: 'source',
  timeframe: 'timeframe',
  symbol: 'symbol',
  session: 'session',
  price: 'price',
  time: 'time',
  text_area: 'str',
  // `input.enum` takes a Pine `enum` member, so its default is an identifier
  // rather than a literal; the panel shows the options and leaves the value
  // alone until the author picks one.
  enum: 'str'
}

const BARE_TYPE = 'str'

/**
 * Find `input.<type>(` / `input(` calls and return their balanced argument text.
 *
 * A regex cannot match balanced parentheses, and default values are full of
 * calls (`input.int(math.round(x), ...)`), so the parenthesis is counted.
 */
function findInputCalls (source) {
  const calls = []
  const pattern = /\binput\s*(?:\.\s*(int|float|bool|string|color|source|timeframe|symbol|session|price|time|text_area|enum)\s*)?\(/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const open = pattern.lastIndex - 1
    const close = matchParen(source, open)
    if (close === -1) break
    calls.push({
      kind: match[1] || '',
      argsText: source.slice(open + 1, close),
      start: match.index,
      // The argument span is what a rewrite edits, so it has to be addressable.
      open,
      close,
      // `len = input.int(...)` binds the declaration to a variable; the
      // runtime can address the input by that name even after the title is
      // edited, so it is worth carrying.
      varId: assignedName(source, match.index)
    })
    pattern.lastIndex = close + 1
  }
  return calls
}

/**
 * The variable a declaration is assigned to, when it is a plain assignment.
 *
 * A tuple destructuring (`a, b = ...`) or a bare call has no single name, so it
 * yields an empty string rather than a guess.
 */
function assignedName (source, at) {
  const head = source.slice(Math.max(0, at - 200), at)
  const match = /([A-Za-z_]\w*)\s*=\s*$/.exec(head)
  if (!match) return ''
  // `if x == y` would look like an assignment to this regex; `namedArg` uses a
  // negative lookahead for the same reason and the check is repeated here.
  const before = head.slice(0, head.length - match[0].length)
  if (/[=!<>]$/.test(before.trimEnd())) return ''
  return match[1]
}

/** Index of the `)` that closes the `(` at `open`, ignoring string contents. */
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
    // A comment runs to the end of the line; parentheses inside it do not count.
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      index = newline === -1 ? source.length : newline
      continue
    }
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) return index
    }
  }
  // Unterminated: take the rest of the source rather than losing the input.
  return -1
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

/** `name = value` → `['name', 'value']`; otherwise null. */
function namedArg (text) {
  const match = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(text)
  if (!match) return null
  return [match[1], match[2].trim()]
}

/** A quoted string literal's contents, or null. */
function stringLiteral (text) {
  const match = /^(["'])([\s\S]*)\1$/.exec(String(text || '').trim())
  return match ? match[2] : null
}

/**
 * A literal value for the panel, or undefined when it is an expression.
 *
 * `input.int(timeframe.period)` has no default the form can show before the
 * script runs; guessing one would put a wrong number in front of the author.
 */
function literalValue (text, type) {
  const raw = String(text || '').trim()
  if (!raw) return undefined
  const quoted = stringLiteral(raw)
  if (quoted != null) return quoted
  if (type === 'bool') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
  }
  if (type === 'color') {
    const hex = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(raw)
    if (hex) return `#${hex[1].slice(0, 6).toUpperCase()}`
    return undefined
  }
  // Numeric literals only: an arithmetic expression is not a default.
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) {
    const numeric = Number(raw)
    return Number.isFinite(numeric) ? numeric : undefined
  }
  return undefined
}

/**
 * Literal values of the script's scalar constants, keyed by name.
 *
 * Scripts declare `const int FAST_DEFAULT = 12` near the top and reference the
 * name in every `input.*` call, so without this the panel would show no default
 * for most real settings. Only single-line literal assignments are recorded: a
 * constant computed from others needs evaluation, which is the runtime's job.
 */
function constantTable (source) {
  const table = {}
  const pattern = /^[ \t]*(?:const\s+|var\s+|varip\s+)?(?:int|float|bool|string|color)?\s*([A-Za-z_]\w*)\s*=\s*([^\n]+)$/gm
  let match
  while ((match = pattern.exec(source)) !== null) {
    const value = match[2].trim()
    // A call is not a constant; `x = input.int(...)` must not shadow itself.
    if (value.split('#')[0].includes('(')) continue
    table[match[1]] = value
  }
  return table
}

/** Follow an identifier to its literal, leaving anything else untouched. */
function resolveConstant (text, constants, depth = 0) {
  const token = String(text || '').trim()
  if (depth > 8 || !(token in constants)) return token
  return resolveConstant(constants[token], constants, depth + 1)
}

/** Parse `options = ["a", "b"]` into the values a select may offer. */
function optionValues (text) {
  const inner = String(text || '').trim().replace(/^\[|\]$/g, '')
  return splitArgs(inner)
    .map(item => stringLiteral(item))
    .filter(item => item != null)
}

/**
 * The input specs a Pine source declares, in declaration order.
 *
 * A spec carries what the panel renders and what an override is keyed by:
 * `name` is the title (the runtime accepts it), and `pineVarId`/`pineInputId`
 * are kept for callers that would rather address the declaration directly.
 */
/**
 * Every `input.*` call in the source, with the parts both the panel and a
 * rewrite need. `name` is empty when the call declares no title.
 *
 * Reading the calls once and handing the same list to both callers is what
 * keeps a panel value and the argument it rewrites pointing at the same
 * declaration: a script with one untitled call would otherwise shift every
 * later pairing by one.
 */
function collectInputs (source) {
  const text = String(source || '')
  if (!text.trim()) return []
  const constants = constantTable(text)
  const out = []
  for (const call of findInputCalls(text)) {
    const type = INPUT_TYPES[call.kind] || BARE_TYPE
    const args = splitArgs(call.argsText)
    const positional = []
    const named = {}
    for (const arg of args) {
      const pair = namedArg(arg)
      if (pair) named[pair[0]] = pair[1]
      else positional.push(arg)
    }
    const defaultText = resolveConstant(
      named.defval !== undefined ? named.defval : positional[0],
      constants
    )
    const titleText = resolveConstant(
      named.title !== undefined ? named.title : positional[1],
      constants
    )
    // Scripts pad titles with em spaces to hang them under a group header; the
    // runtime trims them, so the key the form shows has to be the trimmed one.
    const title = String(
      stringLiteral(titleText) ?? (titleText ? String(titleText).trim() : '')
    ).trim()
    const options = named.options ? optionValues(named.options) : undefined
    out.push({
      call,
      spec: {
        name: title,
        pineVarId: call.varId,
        pineInputId: '',
        type,
        defaultValue: literalValue(defaultText, type),
        rawDefault: defaultText,
        description: stringLiteral(resolveConstant(named.tooltip, constants)) ?? '',
        label: title,
        group: stringLiteral(resolveConstant(named.group, constants)) ?? '',
        values: options && options.length ? options : undefined,
        min: numberOrUndefined(resolveConstant(named.minval, constants)),
        max: numberOrUndefined(resolveConstant(named.maxval, constants)),
        step: positiveOrUndefined(named.step)
      }
    })
  }
  return out
}

export function parsePineInputSpecs (source) {
  const text = String(source || '')
  // A pre-v5 script declares settings as bare `input(30, "period")`, which says
  // nothing about the type. Translating it first is what lets the panel render
  // a number field instead of a text box for a script from 2019.
  const code = needsUpgrade(text) ? upgradeLegacyPine(text).code : text
  const specs = []
  let autoId = 0
  for (const entry of collectInputs(code)) {
    if (!entry.spec.name) continue
    // The id the runtime would assign, so a saved override can address the
    // declaration even after the title is edited.
    entry.spec.pineInputId = `in_${autoId++}`
    specs.push(entry.spec)
  }
  return specs
}
/** The defaults map the panel starts from. */
export function parsePineInputDefaults (source) {
  const out = {}
  for (const spec of parsePineInputSpecs(source)) {
    if (spec.defaultValue !== undefined) out[spec.name] = spec.defaultValue
  }
  return out
}

/**
 * Where each top-level argument of an argument list starts and ends.
 *
 * Rewriting a default needs the span, not just the text: `defval` may be the
 * first positional argument or a named one, and the two sit at different
 * offsets.
 */
function argumentSpans (text) {
  const spans = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let index = 0; index <= text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\') { index++; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(' || char === '[' || char === '{') { depth++; continue }
    if (char === ')' || char === ']' || char === '}') { depth--; continue }
    if (index === text.length || (char === ',' && depth === 0)) {
      const raw = text.slice(start, index)
      const trimmedStart = raw.search(/\S/)
      if (trimmedStart !== -1) {
        let end = raw.length
        while (end > trimmedStart && /\s/.test(raw[end - 1])) end--
        spans.push({ start: start + trimmedStart, end: start + end })
      }
      start = index + 1
    }
  }
  return spans
}

/** The span of the `defval` value inside one call's argument text, or null. */
function defaultValueSpan (argsText) {
  for (const span of argumentSpans(argsText)) {
    const text = argsText.slice(span.start, span.end)
    const pair = namedArg(text)
    if (pair && pair[0] === 'defval') {
      const valueStart = text.indexOf('=', 6) + 1
      const lead = text.slice(valueStart).search(/\S/)
      return { start: span.start + valueStart + Math.max(0, lead), end: span.end }
    }
  }
  // No named `defval`: the default is the first positional argument.
  const first = argumentSpans(argsText)[0]
  if (!first) return null
  if (namedArg(argsText.slice(first.start, first.end))) return null
  return first
}

/** A Pine literal for a value the panel produced. */
function pineLiteral (value, type) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (type === 'color') {
    const hex = /^#?([0-9a-fA-F]{6})$/.exec(String(value || '').trim())
    // An unquoted `#RRGGBB` is a colour; a quoted one is a string, which
    // `input.color` rejects in v5 and later.
    return hex ? `#${hex[1].toUpperCase()}` : String(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return JSON.stringify(String(value ?? ''))
}

/**
 * Write panel values back into the script's `input.*` defaults.
 *
 * The panel edits an override map that only this process understands; this is
 * how the author turns those numbers into code they can keep. Only the default
 * argument is touched, so a title, group, tooltip or bounds the script declares
 * survives the edit.
 *
 * A default that was spelled as a constant (`defval = FAST_LEN_DEFAULT`) is
 * replaced by the literal. Inlining is deliberate: the same constant may back
 * several inputs, and rewriting it would silently change the others too.
 */
/**
 * Whether a panel value can legally be written into an input of this type.
 *
 * A script may declare two inputs with the same title — a real corpus script
 * has both a session and a bool called `London` — and the panel keys a setting
 * by its title, so one override reaches both declarations. Matching on the
 * value rather than on declaration order is what keeps a checkbox out of a
 * session string and a colour out of a length.
 */
function valueFitsType (value, type) {
  if (typeof value === 'boolean') return type === 'bool'
  if (typeof value === 'number') return type === 'int' || type === 'float'
  if (value === null || value === undefined) return false
  const text = String(value)
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return type === 'color'
  return type !== 'bool' && type !== 'int' && type !== 'float' && type !== 'color'
}

export function applyPineInputValues (source, params) {
  const text = String(source || '')
  if (!text.trim() || !params || typeof params !== 'object') return text
  // A legacy script is edited in its own dialect: its offsets are the ones the
  // author sees, and rewriting them into a newer Pine version behind their back
  // would be a surprise they did not ask for.
  if (needsUpgrade(text)) return applyLegacyInputValues(text, params)
  const edits = []
  for (const { call, spec } of collectInputs(text)) {
    // An untitled input has no key the panel could have shown, so it is skipped
    // here for the same reason it is skipped there.
    if (!spec.name) continue
    if (!Object.prototype.hasOwnProperty.call(params, spec.name)) continue
    if (!valueFitsType(params[spec.name], spec.type)) continue
    const argsText = text.slice(call.open + 1, call.close)
    const span = defaultValueSpan(argsText)
    if (!span) continue
    const literal = pineLiteral(params[spec.name], spec.type)
    if (argsText.slice(span.start, span.end) === literal) continue
    edits.push({
      from: call.open + 1 + span.start,
      to: call.open + 1 + span.end,
      literal
    })
  }
  if (!edits.length) return text
  // Splice from the end so earlier offsets stay valid.
  let out = text
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.literal + out.slice(edit.to)
  }
  return out
}

function numberOrUndefined (text) {
  if (text === undefined) return undefined
  const value = literalValue(text, 'float')
  return Number.isFinite(value) ? value : undefined
}

function positiveOrUndefined (text) {
  const value = numberOrUndefined(text)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export default parsePineInputSpecs
