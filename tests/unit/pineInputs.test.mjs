/**
 * Tests for the Pine settings parser.
 *
 * This parser feeds the parameter panel, so its failure mode matters: a wrong
 * default changes what the study computes, and a missing input hides a knob the
 * author declared. The cases below are the shapes real scripts in the corpus
 * actually use.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyPineInputValues, parsePineInputDefaults, parsePineInputSpecs } from '../../src/charting/pineInputs.js'

describe('pine input specs', () => {
  it('reads a positional declaration the way the Pine reference documents it', () => {
    const specs = parsePineInputSpecs(
      'len = input.int(14, "Lookback", minval = 1, maxval = 200, group = "Params")'
    )
    assert.equal(specs.length, 1)
    assert.equal(specs[0].name, 'Lookback')
    assert.equal(specs[0].type, 'int')
    assert.equal(specs[0].defaultValue, 14)
    assert.equal(specs[0].group, 'Params')
    assert.equal(specs[0].min, 1)
    assert.equal(specs[0].max, 200)
  })

  it('reads the named defval/title form', () => {
    const specs = parsePineInputSpecs('x = input.float(defval = 2.5, title = "Factor")')
    assert.equal(specs[0].name, 'Factor')
    assert.equal(specs[0].defaultValue, 2.5)
    assert.equal(specs[0].type, 'float')
  })

  it('keeps a bool a bool instead of the string "false"', () => {
    // A string "false" is truthy, so this mistake would turn every toggle on.
    const specs = parsePineInputSpecs('show = input.bool(false, "Show markers")')
    assert.equal(specs[0].defaultValue, false)
    assert.equal(specs[0].type, 'bool')
  })

  it('offers the options of a string input as selectable values', () => {
    const specs = parsePineInputSpecs('mode = input.string("fast", "Mode", options = ["fast", "slow"])')
    assert.deepEqual(specs[0].values, ['fast', 'slow'])
    assert.equal(specs[0].defaultValue, 'fast')
  })

  it('normalises a hex colour to six digits', () => {
    const specs = parsePineInputSpecs('c = input.color(#ff9800ff, "Line colour")')
    assert.equal(specs[0].defaultValue, '#FF9800')
  })

  it('shows no default when the default is an expression', () => {
    // `input.int(timeframe.period)` has no value the form can know before the
    // script runs; inventing one would show a number that is not in effect.
    const specs = parsePineInputSpecs('tf = input.timeframe(timeframe.period, "Higher timeframe")')
    assert.equal(specs[0].name, 'Higher timeframe')
    assert.equal(specs[0].defaultValue, undefined)
  })

  it('does not mistake a call inside the default for the end of the arguments', () => {
    // A regex would stop at the first `)`; the parenthesis counter must not.
    const specs = parsePineInputSpecs('v = input.float(math.round(close * 2), "Scaled")')
    assert.equal(specs[0].name, 'Scaled')
    assert.equal(specs[0].defaultValue, undefined)
  })

  it('ignores parentheses inside strings and comments', () => {
    const specs = parsePineInputSpecs(
      [
        'a = input.int(5, "Ratio (x)") // not (real) parens',
        'plot(close)'
      ].join('\n')
    )
    assert.equal(specs.length, 1)
    assert.equal(specs[0].name, 'Ratio (x)')
  })

  it('skips an unterminated declaration instead of throwing', () => {
    const specs = parsePineInputSpecs('len = input.int(')
    assert.deepEqual(specs, [])
  })

  it('numbers declarations in order so an override can address them', () => {
    const specs = parsePineInputSpecs([
      'a = input.int(1, "First")',
      'b = input.int(2, "Second")'
    ].join('\n'))
    assert.deepEqual(specs.map(spec => spec.pineInputId), ['in_0', 'in_1'])
  })

  it('builds a defaults map from the declarations', () => {
    const defaults = parsePineInputDefaults([
      'a = input.int(7, "Period")',
      'b = input.bool(true, "Toggle")',
      'c = input.string("x", "Label")'
    ].join('\n'))
    assert.deepEqual(defaults, { Period: 7, Toggle: true, Label: 'x' })
  })

  it('returns nothing for an empty script', () => {
    assert.deepEqual(parsePineInputSpecs(''), [])
    assert.deepEqual(parsePineInputDefaults(undefined), {})
  })
})

describe('pine input constants', () => {
  it('resolves a default named by a constant', () => {
    // Real scripts write `input.int(FAST_DEFAULT, ...)` and define the number
    // further up; without resolution the panel shows no default at all.
    const specs = parsePineInputSpecs([
      'const int FAST_DEFAULT = 12',
      'fastLen = input.int(FAST_DEFAULT, "Fast length", minval=1, maxval=500)'
    ].join('\n'))
    assert.equal(specs[0].defaultValue, 12)
    assert.equal(specs[0].pineVarId, 'fastLen')
  })

  it('resolves a group title named by a constant', () => {
    const specs = parsePineInputSpecs([
      'const string G_PARAMS = "01 — Parameters"',
      'len = input.int(14, "Lookback", group=G_PARAMS)'
    ].join('\n'))
    assert.equal(specs[0].group, '01 — Parameters')
  })

  it('reports a padded title trimmed, matching the runtime key', () => {
    // A title padded with em spaces is trimmed by the runtime, so a form that
    // keeps the padding would fail to address the input when it saves.
    const specs = parsePineInputSpecs('x = input.int(1, "\u2003\u2003↳ Width")')
    assert.equal(specs[0].name, '↳ Width')
  })

  it('leaves a derived default unknown rather than guessing', () => {
    const specs = parsePineInputSpecs([
      'base = 10 + 5',
      'x = input.int(base, "Length")'
    ].join('\n'))
    assert.equal(specs[0].defaultValue, undefined)
  })
})

describe('writing panel values back into the script', () => {
  it('replaces the default of the input the panel named', () => {
    const source = 'len = input.int(14, "Lookback", minval=1, maxval=500)'
    const out = applyPineInputValues(source, { Lookback: 50 })
    assert.equal(out, 'len = input.int(50, "Lookback", minval=1, maxval=500)')
  })

  it('rewrites a named defval where the script used one', () => {
    const source = 'x = input.float(defval=2.0, title="Multiplier", step=0.1)'
    const out = applyPineInputValues(source, { Multiplier: 3.5 })
    assert.equal(out, 'x = input.float(defval=3.5, title="Multiplier", step=0.1)')
  })

  it('keeps the title, group and bounds the script declares', () => {
    const source = 'x = input.int(10, "Length", minval=1, maxval=100, group="Setup", tooltip="Bars")'
    const out = applyPineInputValues(source, { Length: 20 })
    assert.match(out, /input\.int\(20, "Length", minval=1, maxval=100, group="Setup", tooltip="Bars"\)/)
  })

  it('writes a boolean and a colour as Pine literals, not strings', () => {
    const source = [
      'a = input.bool(false, "Show markers")',
      'b = input.color(#2962ff, "Line colour")'
    ].join('\n')
    const out = applyPineInputValues(source, { 'Show markers': true, 'Line colour': '#FF0000' })
    assert.match(out, /input\.bool\(true, "Show markers"\)/)
    // A quoted colour is a string and input.color rejects it in v5 and later.
    assert.match(out, /input\.color\(#FF0000, "Line colour"\)/)
  })

  it('inlines the literal when the default was a constant', () => {
    const source = [
      'const int FAST = 12',
      'a = input.int(FAST, "Fast")',
      'b = input.int(FAST, "Slow")'
    ].join('\n')
    const out = applyPineInputValues(source, { Fast: 8 })
    assert.match(out, /input\.int\(8, "Fast"\)/)
    // The constant still backs the other input, so only the named one changes.
    assert.match(out, /input\.int\(FAST, "Slow"\)/)
    assert.match(out, /const int FAST = 12/)
  })

  it('rewrites several inputs at once without shifting the later ones', () => {
    const source = [
      'a = input.int(1, "First")',
      'b = input.int(2, "Second")',
      'c = input.int(3, "Third")'
    ].join('\n')
    const out = applyPineInputValues(source, { First: 111, Second: 222, Third: 333 })
    assert.equal(out, [
      'a = input.int(111, "First")',
      'b = input.int(222, "Second")',
      'c = input.int(333, "Third")'
    ].join('\n'))
  })

  it('leaves an untitled input alone and still hits the titled ones after it', () => {
    // The untitled call has no key the panel could show; pairing by position
    // instead of by declaration would rewrite the wrong argument here.
    const source = [
      'a = input.int(1)',
      'b = input.int(2, "Titled")'
    ].join('\n')
    const out = applyPineInputValues(source, { Titled: 99 })
    assert.equal(out, ['a = input.int(1)', 'b = input.int(99, "Titled")'].join('\n'))
  })

  it('returns the source unchanged when nothing was supplied', () => {
    const source = 'x = input.int(14, "Lookback")'
    assert.equal(applyPineInputValues(source, {}), source)
    assert.equal(applyPineInputValues(source, { Missing: 3 }), source)
    assert.equal(applyPineInputValues('', { Lookback: 3 }), '')
    assert.equal(applyPineInputValues(source, null), source)
  })

  it('returns the source unchanged when the value already matches', () => {
    const source = 'x = input.int(14, "Lookback")'
    assert.equal(applyPineInputValues(source, { Lookback: 14 }), source)
  })

  it('round-trips through the parser so the panel reads back what it wrote', () => {
    const source = 'x = input.int(14, "Lookback", minval=1)'
    const out = applyPineInputValues(source, { Lookback: 42 })
    assert.equal(parsePineInputSpecs(out)[0].defaultValue, 42)
  })

  it('omits an option list default it cannot render as a literal', () => {
    const source = 'm = input.string("fast", "Mode", options=["fast", "slow"])'
    const out = applyPineInputValues(source, { Mode: 'slow' })
    assert.match(out, /input\.string\("slow", "Mode", options=\["fast", "slow"\]\)/)
  })
})

describe('duplicate titles', () => {
  it('writes only into the declaration the panel shows, not a same-titled other type', () => {
    // A real corpus script declares `London` as a session and as a bool. The
    // panel keys by title and shows the first, so a bool must not land in the
    // session argument.
    const source = [
      'sess = input.session("0700-1600", "London")',
      'flag = input.bool(false, "London")'
    ].join('\n')
    const specs = parsePineInputSpecs(source)
    assert.equal(specs[0].type, 'session')
    const out = applyPineInputValues(source, { London: true })
    assert.match(out, /input\.session\("0700-1600", "London"\)/)
    assert.match(out, /input\.bool\(true, "London"\)/)
  })

  it('keeps every same-titled input of the shown type in step', () => {
    const source = [
      'a = input.int(1, "Width")',
      'b = input.int(2, "Width")'
    ].join('\n')
    const out = applyPineInputValues(source, { Width: 9 })
    assert.equal(out, ['a = input.int(9, "Width")', 'b = input.int(9, "Width")'].join('\n'))
  })
})
