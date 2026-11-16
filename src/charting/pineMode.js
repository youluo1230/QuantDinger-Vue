/**
 * CodeMirror mode for Pine Script.
 *
 * CodeMirror 5 ships no Pine mode, and writing one is cheaper than the
 * alternative: a user editing Pine with the Python mode gets Python's keywords
 * highlighted and Pine's not, which reads as "this editor does not know the
 * language". That impression costs more than the highlighting is worth, so the
 * mode is deliberately shallow -- enough to make the structure legible, not a
 * parser.
 *
 * The one non-obvious rule is `//@version`: it is a comment token to CodeMirror
 * but a directive to the compiler, so it is coloured as a meta line rather than
 * as prose.
 */
export const PINE_KEYWORDS = [
  'var', 'varip', 'if', 'else', 'for', 'to', 'by', 'while', 'switch', 'case',
  'default', 'break', 'continue', 'return', 'import', 'export', 'type',
  'method', 'and', 'or', 'not', 'true', 'false', 'na'
]

export const PINE_BUILTINS = [
  'open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'time',
  'bar_index', 'last_bar_index', 'syminfo', 'timeframe', 'chart', 'barstate',
  'strategy', 'input', 'color', 'display', 'shape', 'location', 'size',
  'format', 'math', 'str', 'array', 'matrix', 'map', 'request', 'alert',
  'label', 'line', 'box', 'table', 'polyline', 'linefill', 'runtime'
]

export const PINE_DECLARATIONS = ['indicator', 'strategy', 'library']

export const PINE_DRAWING = [
  'plot', 'plotshape', 'plotchar', 'plotcandle', 'plotbar', 'plotarrow',
  'fill', 'hline', 'bgcolor', 'barcolor', 'alertcondition', 'alert'
]

/**
 * Install the mode on a CodeMirror instance. Separated from the definition so
 * the tests can tokenise without a browser.
 */
export function definePineMode (CodeMirror) {
  if (!CodeMirror || CodeMirror.modes?.pine) return
  CodeMirror.defineMode('pine', () => ({
    token (stream, state) {
      if (stream.sol() && stream.match(/^\s*\/\/\s*@version\b/)) {
        stream.skipToEnd()
        return 'meta'
      }
      if (stream.eatSpace()) return null

      // Strings must be consumed before comments: `//` inside a string is not a
      // comment, and Pine titles are full of slashes.
      if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
      if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string'

      if (stream.match('//')) {
        stream.skipToEnd()
        return 'comment'
      }

      if (stream.match(/^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/)) return 'number'
      if (stream.match(/^(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?)/)) return 'number'

      // `ta.ema`, `str.tostring`, `timeframe.period`: the namespace is the part
      // worth highlighting, the member name is not a language keyword.
      const namespaced = stream.match(/^[A-Za-z_]\w*(?=\.[A-Za-z_])/)
      if (namespaced) {
        const word = namespaced[0]
        return PINE_BUILTINS.includes(word) ? 'variable-3' : 'variable-2'
      }
      const bare = stream.match(/^[A-Za-z_]\w*/)
      if (bare) {
        const word = bare[0]
        if (PINE_KEYWORDS.includes(word)) return 'keyword'
        if (PINE_DECLARATIONS.includes(word)) return 'def'
        if (PINE_DRAWING.includes(word)) return 'builtin'
        if (PINE_BUILTINS.includes(word)) return 'variable-3'
        // A call site is worth distinguishing from a variable read.
        if (stream.peek() === '(') return 'variable-2'
        return 'variable'
      }

      if (stream.match(/^[+\-*/%<>=!?:&|^~]+/)) return 'operator'
      if (stream.match(/^[()[\]{},.]/)) return 'bracket'
      stream.next()
      return null
    }
  }))
  CodeMirror.defineMIME('text/x-pine', 'pine')
}

export default definePineMode
