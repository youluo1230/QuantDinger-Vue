/**
 * Running the scripts an author already has.
 *
 * The chart refuses a script the runtime cannot parse, and that refusal is
 * visible: "Unsupported Pine Script version 4" is a dead end for a script whose
 * logic is otherwise perfectly runnable. Two compatibility passes are pinned
 * here.
 *
 * 1. A pre-v5 script is translated to v6 before it runs. The pass renames
 *    things the newer dialect moved into namespaces and re-spells the input
 *    constructors; it never rewrites an expression, because a wrong guess
 *    would silently draw a different line.
 * 2. Scripts that trip the runtime's tuple-destructuring limitation are
 *    rewritten by `repairTupleDestructuring`, and only after a plain run has
 *    actually failed.
 *
 * The editor keeps showing the author's own text in both cases: these are
 * runtime concerns, not edits to their file.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyLegacyInputValues,
  legacyInputCalls,
  needsUpgrade,
  pineVersionOf,
  repairTupleDestructuring,
  upgradeLegacyPine
} from '../../src/charting/pineUpgrade.js'

const V4_STUDY = `//@version=4
study("Bands", overlay=true)
period = input(20, minval=1, title="Period")
sigma = input(1.8, step=0.1, title="Sigma")
basis = sma(close, period)
dev = sigma * stdev(close, period)
plot(basis + dev, "Upper", color=color.red)
plot(basis - dev, "Lower", color=color.green)
fill(plot(basis + dev), plot(basis - dev), color=color.blue)
`

describe('pine version', () => {
  it('reads the declared version', () => {
    assert.equal(pineVersionOf('//@version=4\nstudy("x")'), 4)
    assert.equal(pineVersionOf('// @version=6'), 6)
  })

  it('treats a script with no marker as needing an upgrade', () => {
    // v1-v3 scripts often carry no marker at all, which is the oldest dialect.
    assert.equal(needsUpgrade('study("x")\nplot(close)'), true)
    assert.equal(needsUpgrade('//@version=6\nindicator("x")'), false)
  })
})

describe('pre-v5 upgrade', () => {
  it('moves the version marker and the study declaration', () => {
    const { code, upgraded, from } = upgradeLegacyPine(V4_STUDY)
    assert.equal(upgraded, true)
    assert.equal(from, 4)
    assert.match(code, /^\/\/@version=6\n/)
    assert.match(code, /\bindicator\("Bands", overlay=true\)/)
    assert.doesNotMatch(code, /\bstudy\s*\(/)
  })

  it('namespaces the builtins the newer dialect moved', () => {
    const { code } = upgradeLegacyPine(V4_STUDY)
    assert.match(code, /ta\.sma\(close, period\)/)
    assert.match(code, /ta\.stdev\(close, period\)/)
  })

  it('turns a typed-less input into the constructor that carries the type', () => {
    const { code } = upgradeLegacyPine(V4_STUDY)
    assert.match(code, /input\.int\(title="Period", defval=20, minval=1\)/)
    assert.match(code, /input\.float\(title="Sigma", defval=1\.8, step=0\.1\)/)
    assert.doesNotMatch(code, /=\s*input\(/)
  })

  it('reads a bare tr as the value the newer dialect exposes', () => {
    // v4 spells the true range as a bare name; a call-only rewrite left the
    // scripts that do this failing on `Undeclared identifier "tr"`.
    const { code } = upgradeLegacyPine('//@version=4\nstudy("x")\nplot(high + 3 * tr)')
    assert.match(code, /ta\.tr\b/)
  })

  it('never renames a name the script declares itself', () => {
    // A local `sma` shadows the builtin, so qualifying it would be wrong.
    const { code } = upgradeLegacyPine('//@version=4\nstudy("x")\nsma(x, n) => x + n\nplot(sma(close, 3))')
    assert.match(code, /^\s*sma\(x, n\) =>/m)
    assert.match(code, /plot\(sma\(close, 3\)\)/)
  })

  it('leaves a string literal alone', () => {
    // A title naming a builtin must not become `ta.sma` inside the quotes.
    const { code } = upgradeLegacyPine('//@version=4\nstudy("x")\nplot(close, title="sma(20)")')
    assert.match(code, /"sma\(20\)"/)
  })

  it('leaves a commented-out line alone', () => {
    const { code } = upgradeLegacyPine('//@version=4\nstudy("x")\n// plot(sma(close, 20))\nplot(close)')
    assert.match(code, /\/\/ plot\(sma\(close, 20\)\)/)
  })

  it('returns a v5+ script byte-identically', () => {
    const source = '//@version=6\nindicator("x")\nplot(ta.sma(close, 20))'
    const { code, upgraded } = upgradeLegacyPine(source)
    assert.equal(upgraded, false)
    assert.equal(code, source)
  })
})

describe('legacy settings', () => {
  it('reads the title out of a bare input call', () => {
    const calls = legacyInputCalls(V4_STUDY)
    assert.deepEqual(calls.map(call => call.title), ['Period', 'Sigma'])
    assert.deepEqual(calls.map(call => call.kind), ['int', 'float'])
  })

  it('writes a value without upgrading the file', () => {
    // An author who turns a knob should still be looking at Pine v4.
    const out = applyLegacyInputValues(V4_STUDY, { Period: 50, Sigma: 2.5 })
    assert.match(out, /input\(50, minval=1, title="Period"\)/)
    assert.match(out, /input\(2\.5, step=0\.1, title="Sigma"\)/)
    assert.match(out, /^\/\/@version=4/)
  })

  it('keeps the bounds and the rest of the declaration', () => {
    const out = applyLegacyInputValues(V4_STUDY, { Period: 50 })
    assert.match(out, /minval=1/)
    assert.match(out, /title="Period"/)
    assert.match(out, /title="Sigma"\)/)
  })

  it('will not write a number into a string input', () => {
    const source = '//@version=4\nstudy("x")\nsess = input("0700-1600", title="Session")'
    assert.equal(applyLegacyInputValues(source, { Session: 5 }), source)
  })

  it('ignores a title the script does not declare', () => {
    assert.equal(applyLegacyInputValues(V4_STUDY, { Nope: 5 }), V4_STUDY)
  })
})

describe('tuple destructuring repair', () => {
  const BROKEN = `//@version=6
indicator("t", overlay=true)
f(int d) =>
    float s = ta.sma(close, 3)
    float k = s[d - 1]
    [s, k]
[s, k] = f(3)
plot(s)
`

  it('renames every destination and restores the author names', () => {
    const { code, repaired } = repairTupleDestructuring(BROKEN)
    assert.equal(repaired, true)
    assert.match(code, /\[__qd_t0_0, __qd_t0_1\] = f\(3\)/)
    assert.match(code, /^s = __qd_t0_0$/m)
    assert.match(code, /^k = __qd_t0_1$/m)
    // Everything after the statement is untouched.
    assert.match(code, /^plot\(s\)$/m)
  })

  it('keeps the indentation of a nested statement', () => {
    const nested = `//@version=6
indicator("t", overlay=true)
g() =>
    [a, b] = h()
    plot(a)
`
    const { code } = repairTupleDestructuring(nested)
    assert.match(code, /^ {4}\[__qd_t0_0, __qd_t0_1\] = h\(\)$/m)
    assert.match(code, /^ {4}a = __qd_t0_0$/m)
  })

  it('hands back a script with no destructuring unchanged', () => {
    const plain = '//@version=6\nindicator("t")\nplot(close)'
    const { code, repaired } = repairTupleDestructuring(plain)
    assert.equal(repaired, false)
    assert.equal(code, plain)
  })

  it('does not mistake a series index for a destination list', () => {
    // `close[1]` has a bracket too; it must not be rewritten.
    const source = '//@version=6\nindicator("t")\nplot(close[1])'
    assert.equal(repairTupleDestructuring(source).repaired, false)
  })

  it('gives each statement its own names', () => {
    const two = `//@version=6
indicator("t", overlay=true)
[a, b] = f()
[c, d] = g()
plot(a)
`
    const { code } = repairTupleDestructuring(two)
    assert.match(code, /\[__qd_t0_0, __qd_t0_1\] = f\(\)/)
    assert.match(code, /\[__qd_t1_0, __qd_t1_1\] = g\(\)/)
  })
})
