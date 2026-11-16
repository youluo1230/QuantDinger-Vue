/**
 * Tests for the Pine editor mode.
 *
 * The mode is small and the interesting property is not "it colours things" but
 * "it does not lie": strings must survive `//` inside a title, and the
 * `//@version` directive must be distinguishable from an ordinary comment
 * because losing it is what makes a script unloadable.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { definePineMode, PINE_DRAWING, PINE_KEYWORDS } from '../../src/charting/pineMode.js'

/** A minimal CodeMirror stand-in: the mode only needs defineMode/defineMIME. */
function fakeCodeMirror () {
  const modes = {}
  return {
    modes,
    defineMode (name, factory) { modes[name] = factory },
    defineMIME () {}
  }
}

function tokenizer () {
  const CodeMirror = fakeCodeMirror()
  definePineMode(CodeMirror)
  const mode = CodeMirror.modes.pine()
  return (line) => {
    // The mode's token fn advances a stream; emulate the parts it uses.
    const stream = makeStream(line)
    const tokens = []
    let guard = 0
    while (!stream.eol() && guard++ < 500) {
      const start = stream.pos
      const type = mode.token(stream, {})
      if (stream.pos === start) stream.pos++
      tokens.push({ text: line.slice(start, stream.pos), type })
    }
    return tokens
  }
}

function makeStream (string) {
  return {
    string,
    pos: 0,
    start: 0,
    eol () { return this.pos >= this.string.length },
    sol () { return this.pos === 0 },
    eatSpace () {
      const m = /^\s*/.exec(this.string.slice(this.pos))
      if (m && m[0]) { this.pos += m[0].length; return true }
      return false
    },
    peek () { return this.string.charAt(this.pos) || undefined },
    next () { return this.string.charAt(this.pos++) },
    match (pattern) {
      const slice = this.string.slice(this.pos)
      const m = slice.match(pattern)
      if (m && m.index === 0) { this.pos += m[0].length; return m }
      return null
    },
    skipToEnd () { this.pos = this.string.length }
  }
}

const tokensFor = (line) => tokenizer()(line)

describe('pine mode', () => {
  it('colours the version directive as metadata, not as prose', () => {
    const tokens = tokensFor('//@version=6')
    assert.deepEqual(tokens.map(t => t.type), ['meta'])
  })

  it('keeps a comment comment-shaped', () => {
    assert.deepEqual(tokensFor('// just a note').map(t => t.type), ['comment'])
  })

  it('does not treat // inside a string as a comment', () => {
    // Pine titles are full of slashes; a naive `//` test would truncate them.
    const tokens = tokensFor('indicator("A/B // not a comment")')
    const stringToken = tokens.find(t => t.type === 'string')
    assert.equal(stringToken.text, '"A/B // not a comment"')
    assert.equal(tokens.some(t => t.type === 'comment'), false)
  })

  it('marks the declaration and the drawing calls distinctly', () => {
    const tokens = tokensFor('indicator("x")')
    assert.equal(tokens[0].type, 'def')
    const plot = tokensFor('plot(close)').find(t => t.text === 'plot')
    assert.equal(plot.type, 'builtin')
    assert.ok(PINE_DRAWING.length > 0)
  })

  it('marks language keywords', () => {
    const token = tokensFor('if close > open').find(t => t.type === 'keyword')
    assert.equal(token.text, 'if')
    assert.ok(PINE_KEYWORDS.includes('if'))
  })

  it('treats a namespaced call as a reference rather than a keyword', () => {
    const tokens = tokensFor('ta.ema(close, 20)')
    assert.equal(tokens[0].text, 'ta')
    assert.notEqual(tokens[0].type, 'keyword')
  })

  it('reads hex colours as numbers', () => {
    const tokens = tokensFor('plot(close, color=#FF9800)')
    assert.ok(tokens.some(t => t.text === '#FF9800' && t.type === 'number'))
  })

  it('is idempotent across installs', () => {
    // registerIndicators-style call paths can install twice; the second must
    // not overwrite the first with a different mode object.
    const CodeMirror = fakeCodeMirror()
    definePineMode(CodeMirror)
    const first = CodeMirror.modes.pine
    definePineMode(CodeMirror)
    assert.equal(CodeMirror.modes.pine, first)
  })
})
