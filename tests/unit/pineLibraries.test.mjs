/**
 * The vendored Pine libraries.
 *
 * A script that imports `TradingView/ta/14` cannot run at all without a
 * resolver, so the chart would report a failure for a script that is otherwise
 * perfectly valid Pine. The vendored library exists to make those scripts run,
 * which means two things have to hold and are what this file pins:
 *
 * 1. the resolver answers for the paths our stored scripts actually import, at
 *    any version, and answers `null` -- not a guess -- for everything else;
 * 2. the source it returns is real Pine that the compiler accepts, because a
 *    library with a syntax error fails the importing script with a message
 *    pointing at the library, which is much harder to read.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { librarySource, libraryStub, pineImportResolver, vendoredLibraries } from '../../src/charting/pineLibraries.js'

describe('librarySource', () => {
  it('answers for the ta library at any version', () => {
    // The version selects a release, not a different library, and only one
    // implementation of it is vendored.
    assert.match(librarySource('TradingView/ta/14'), /library\("ta"\)/)
    assert.match(librarySource('TradingView/ta/12'), /library\("ta"\)/)
    assert.match(librarySource('TradingView/ta/7'), /library\("ta"\)/)
    assert.equal(librarySource('TradingView/ta/14'), librarySource('TradingView/ta/12'))
  })

  it('answers for a path with no version', () => {
    assert.match(librarySource('TradingView/ta'), /library\("ta"\)/)
  })

  it('declares requestVolumeDelta, the function scripts actually call', () => {
    assert.match(librarySource('TradingView/ta/12'), /export requestVolumeDelta\(/)
  })

  it('splits a bar into buy and sell volume that add up to its volume', () => {
    // Every caller destructures [up, down, volume, delta] and then compares
    // the parts against the bar's volume; a decomposition that does not add up
    // draws a wrong picture rather than a missing one.
    const source = librarySource('TradingView/ta/14')
    assert.match(source, /float bought = closed >= opened \? traded : 0\.0/)
    assert.match(source, /float sold = closed < opened \? traded : 0\.0/)
    assert.match(source, /float delta = bought - sold/)
    // The four-value tuple, in that order.
    assert.match(source, /\[bought, sold, traded, delta\]/)
  })

  it('is null for a library it cannot reproduce', () => {
    // Returning a stub would draw a wrong line; null lets the chart say the
    // import is unsupported.
    assert.equal(librarySource('Trendoscope/ZigzagLite/4'), null)
    assert.equal(librarySource('orenluxy/LuxyEnergyIndex/1'), null)
    assert.equal(librarySource(''), null)
    assert.equal(librarySource(null), null)
    assert.equal(librarySource('justaname'), null)
  })
})

describe('vendoredLibraries', () => {
  it('lists what this build can serve', () => {
    assert.deepEqual(vendoredLibraries(), ['TradingView/ta'])
  })
})

describe('pineImportResolver', () => {
  it('answers as a plain function resolver', () => {
    // PineTS accepts a function `(path, info) => source` and calls it with at
    // least the path; anything else is a resolver it will not use.
    const resolve = pineImportResolver()
    assert.equal(typeof resolve, 'function')
    assert.match(resolve('TradingView/ta/14', { path: 'TradingView/ta/14' }), /library\("ta"\)/)
    assert.equal(resolve('nobody/nothing/1', { path: 'nobody/nothing/1' }), null)
  })
})

describe('the vendored source', () => {
  it('is version 6 Pine with a library declaration and no indicator', () => {
    const source = librarySource('TradingView/ta/14')
    assert.match(source, /^\/\/@version=6/m)
    assert.match(source, /^library\("ta"\)/m)
    // `indicator()` in a library is a common copy-paste slip and the compiler
    // rejects the library for it.
    assert.doesNotMatch(source, /^\s*indicator\(/m)
  })

  it('reads the other timeframe through request.security', () => {
    const source = librarySource('TradingView/ta/14')
    for (const field of ['open', 'close', 'volume']) {
      assert.match(source, new RegExp(`request\\.security\\(syminfo\\.tickerid, timeframe, ${field}\\)`))
    }
  })
})

describe('libraryStub', () => {
  const script = [
    '//@version=6',
    'indicator("x")',
    'import orenluxy/LuxyEnergyIndex/1 as LEI',
    'import Trendoscope/ohlc/3 as o',
    'v = LEI.lei(close)',
    'z = LEI.getZone(v)',
    'arr = array.new<o.OHLC>()'
  ].join('\n')

  it('stubs a function the script calls', () => {
    const stub = libraryStub(script, 'orenluxy/LuxyEnergyIndex/1')
    assert.match(stub, /^\/\/@version=6/m)
    assert.match(stub, /export lei\(\) => na/)
    assert.match(stub, /export getZone\(\) => na/)
  })

  it('stubs a type the script declares a collection of', () => {
    // `array<o.OHLC>` is a parse error without the type, not an `na`.
    const stub = libraryStub(script, 'Trendoscope/ohlc/3')
    assert.match(stub, /export type OHLC/)
  })

  it('declares nothing for a library the script does not import', () => {
    const stub = libraryStub('//@version=6\nindicator("x")\nplot(close)', 'anything/at/all')
    // The library name in the declaration is the `user/library` stem: the
    // version is a release of that library, not a different library.
    assert.equal(stub.trim(), '//@version=6\nlibrary("anything/at")')
  })

  it('puts a nested receiver ahead of the field read from it', () => {
    // `zigzag.flags.newPivot` reads `newPivot` off `flags`. A field order that
    // puts the leaf first leaves the receiver `na`, and reading a property off
    // `na` is the throw.
    const stub = libraryStub(
      '//@version=6\nindicator("x")\nimport a/b/1 as zg\nvar zg.Zigzag z = zg.Zigzag.new()\nplot(z.flags.newPivot ? 1 : 0)',
      'a/b/1'
    )
    const fields = stub.split('\n').filter(line => line.startsWith('    '))
    assert.ok(fields.length >= 1, stub)
    assert.match(fields[0], /flags/)
  })
})
