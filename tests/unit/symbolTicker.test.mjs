/**
 * The ticker carries the venue.
 *
 * The library identifies a symbol by one opaque string it echoes back on every
 * `resolveSymbol` and `getBars` call. BTC/USDT exists on more than one venue, so
 * a bare pair cannot survive that round trip without losing which venue the
 * user picked -- and a saved layout that restored the pair onto the spot venue
 * would silently change what the chart is showing. These tests pin the format
 * the datafeed and the search results agree on.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalMarketName, decodeSymbolTicker, encodeSymbolTicker, isEncodedSymbolTicker } from '../../src/charting/symbolTicker.js'

test('an instrument is encoded with its venue', () => {
  assert.equal(
    encodeSymbolTicker({ market: 'Crypto', marketType: 'swap', exchangeId: 'binance', instrumentId: 'BTC/USDT' }),
    'QD:BTC/USDT:Crypto:swap:binance'
  )
})

test('the encoding round-trips every field it carries', () => {
  const encoded = encodeSymbolTicker({ market: 'USStock', exchangeId: 'nasdaq', instrumentId: 'AAPL' })
  assert.deepEqual(decodeSymbolTicker(encoded), {
    market: 'USStock',
    marketType: '',
    exchangeId: 'nasdaq',
    instrumentId: 'AAPL'
  })
})

test('an instrument id containing the separator is kept whole', () => {
  // Some venues name an instrument with a colon; splitting on every separator
  // would truncate it and resolve the wrong symbol.
  const encoded = encodeSymbolTicker({ market: 'Crypto', marketType: 'swap', exchangeId: 'okx', instrumentId: 'BTC:USDT:SWAP' })
  assert.equal(decodeSymbolTicker(encoded).instrumentId, 'BTC:USDT:SWAP')
})

test('a bare symbol is not an encoded ticker', () => {
  // The IDE mounts with the human symbol before any search has happened; that
  // must keep meaning "the venue this pane already holds", not a decode failure.
  assert.equal(decodeSymbolTicker('BTC/USDT'), null)
  assert.equal(isEncodedSymbolTicker('BTC/USDT'), false)
  assert.equal(isEncodedSymbolTicker('QD:BTC/USDT:Crypto:swap:binance'), true)
})

test('an empty instrument produces no ticker instead of a half-formed one', () => {
  assert.equal(encodeSymbolTicker({ market: 'Crypto', marketType: 'spot', exchangeId: 'binance' }), '')
  assert.equal(decodeSymbolTicker(''), null)
  assert.equal(decodeSymbolTicker('QD::Crypto:swap:binance'), null)
})

test('the pre-swap order is still decoded', () => {
  // Archives written before the instrument moved to the second slot must keep
  // loading: the market label in that slot is what tells the orders apart.
  const legacy = decodeSymbolTicker('QD:Crypto:swap:binance:BTC/USDT')
  assert.deepEqual(legacy, { market: 'Crypto', marketType: 'swap', exchangeId: 'binance', instrumentId: 'BTC/USDT' })
  assert.equal(decodeSymbolTicker('QD:Crypto:spot:okx:SOL/USDT').instrumentId, 'SOL/USDT')
})

test('a ticker without a market is not decodable', () => {
  assert.equal(decodeSymbolTicker('QD:BTC/USDT::swap:binance'), null)
})

test('market labels are canonicalised without inventing new ones', () => {
  assert.equal(canonicalMarketName('crypto'), 'Crypto')
  assert.equal(canonicalMarketName(' usstock '), 'USStock')
  assert.equal(canonicalMarketName(''), 'Crypto')
  // Not in the known list: leave it alone so the backend can report it.
  assert.equal(canonicalMarketName('MOEX'), 'MOEX')
})
