import assert from 'node:assert/strict'
import test from 'node:test'

import {
  civilFromDays, normalizeAmount, normalizeCurrency, normalizeDate,
  normalizeInteger, normalizeString, parseTimezone, renderMinor,
} from '../src/index.mjs'

/**
 * The normalisers on their own. `test/precision-timezone.test.mjs` pins the
 * same behaviour through the real entry point; this file covers the shapes
 * that would take a whole fixture to reach from outside.
 */

test('a fixed offset parses and a named zone does not', () => {
  assert.deepEqual(parseTimezone('Z'), { ok: true, minutes: 0, label: 'Z' })
  assert.deepEqual(parseTimezone('+05:30'), { ok: true, minutes: 330, label: '+05:30' })
  assert.deepEqual(parseTimezone('-08:00'), { ok: true, minutes: -480, label: '-08:00' })
  assert.deepEqual(parseTimezone('+00:00'), { ok: true, minutes: 0, label: 'Z' })
  assert.equal(parseTimezone('+14:00').ok, true)
  assert.equal(parseTimezone('+14:01').ok, false)
  assert.equal(parseTimezone('+05:60').ok, false)
  assert.equal(parseTimezone('Asia/Kolkata').ok, false)
  assert.equal(parseTimezone('IST').ok, false)
  assert.equal(parseTimezone('UTC').ok, false)
  assert.equal(parseTimezone(330).ok, false)
})

test('minor units render back to a decimal at the declared precision', () => {
  assert.equal(renderMinor(1050n, 2), '10.50')
  assert.equal(renderMinor(-1050n, 2), '-10.50')
  assert.equal(renderMinor(5n, 2), '0.05')
  assert.equal(renderMinor(0n, 2), '0.00')
  assert.equal(renderMinor(7n, 0), '7')
})

test('amounts become exact integer minor units', () => {
  assert.equal(normalizeAmount('10.50', 2).key, '1050')
  assert.equal(normalizeAmount('10.5', 2).key, '1050')
  assert.equal(normalizeAmount('10.500', 2).key, '1050')
  assert.equal(normalizeAmount('-10.50', 2).key, '-1050')
  assert.equal(normalizeAmount('-0.000', 2).key, '0')
  assert.equal(normalizeAmount('+10.50', 2).key, '1050')
  assert.equal(normalizeAmount(10, 2).key, '1000')
  assert.equal(normalizeAmount('999999999999999999.99', 2).key, '99999999999999999999')
})

test('amounts this tool cannot compare exactly say why, one reason at a time', () => {
  assert.equal(normalizeAmount(10.5, 2).reason, 'not-exact')
  assert.equal(normalizeAmount('10.005', 2).reason, 'precision')
  assert.equal(normalizeAmount('ten', 2).reason, 'malformed')
  assert.equal(normalizeAmount('1e5', 2).reason, 'malformed')
  assert.equal(normalizeAmount('', 2).reason, 'malformed')
  assert.equal(normalizeAmount(null, 2).reason, 'not-a-value')
  assert.equal(normalizeAmount(true, 2).reason, 'not-a-value')
  assert.equal(normalizeAmount(Number.MAX_SAFE_INTEGER + 2, 2).reason, 'out-of-range')
  assert.equal(normalizeAmount('1'.repeat(19), 2).reason, 'malformed', '18 integer digits is the bound')
})

test('civil dates come from arithmetic, with no Date object involved', () => {
  assert.deepEqual(civilFromDays(0), { year: 1970, month: 1, day: 1 })
  assert.deepEqual(civilFromDays(-1), { year: 1969, month: 12, day: 31 })
  assert.deepEqual(civilFromDays(59), { year: 1970, month: 3, day: 1 })
  assert.deepEqual(civilFromDays(21243), { year: 2028, month: 2, day: 29 })
})

test('a timestamp becomes the bucket it falls in, in the declared zone', () => {
  assert.equal(normalizeDate('2026-03-01T20:30:00Z', 330, 'day').key, '2026-03-02')
  assert.equal(normalizeDate('2026-03-01T20:30:00Z', 0, 'day').key, '2026-03-01')
  assert.equal(normalizeDate('2026-03-02T02:00:00+05:30', 330, 'instant').key, normalizeDate('2026-03-01T20:30:00Z', 330, 'instant').key)
  assert.equal(normalizeDate('2026-03-01T20:30:00Z', 330, 'hour').key, '2026-03-02T02+05:30')
  assert.equal(normalizeDate('2026-03-01T20:30:00Z', 330, 'minute').key, '2026-03-02T02:00+05:30')
  assert.equal(normalizeDate('2026-03-01T20:30:00.250Z', 0, 'instant').key, '2026-03-01T20:30:00.250Z')
  assert.equal(normalizeDate('2026-03-01T20:30Z', 0, 'minute').key, '2026-03-01T20:30Z', 'seconds are optional')
})

test('a timestamp this tool cannot place says why, one reason at a time', () => {
  assert.equal(normalizeDate('2026-03-01T20:30:00', 0, 'day').reason, 'offset-missing')
  assert.equal(normalizeDate('2026-03-01', 0, 'instant').reason, 'needs-instant')
  assert.equal(normalizeDate('2026-02-29T00:00:00Z', 0, 'day').reason, 'not-a-real-instant')
  assert.equal(normalizeDate('2026-13-01T00:00:00Z', 0, 'day').reason, 'not-a-real-instant')
  assert.equal(normalizeDate('2026-03-01T24:00:00Z', 0, 'day').reason, 'not-a-real-instant')
  assert.equal(normalizeDate('1969-12-31T00:00:00Z', 0, 'day').reason, 'out-of-range')
  assert.equal(normalizeDate('2101-01-01T00:00:00Z', 0, 'day').reason, 'out-of-range')
  assert.equal(normalizeDate('01/03/2026', 0, 'day').reason, 'malformed')
  assert.equal(normalizeDate(20260301, 0, 'day').reason, 'not-a-string')
  assert.equal(normalizeDate('2026-03-01T00:00:00+15:00', 0, 'day').reason, 'offset-invalid')
})

test('strings normalise only as the plan declares', () => {
  const strict = { trim: false, caseSensitive: true, collapseWhitespace: false }
  assert.equal(normalizeString(' A ', strict, 100).key, ' A ')
  assert.equal(normalizeString(' A ', { ...strict, trim: true }, 100).key, 'A')
  assert.equal(normalizeString('A', { ...strict, caseSensitive: false }, 100).key, 'a')
  assert.equal(normalizeString('a  b', { ...strict, collapseWhitespace: true }, 100).key, 'a b')
  assert.equal(normalizeString('abcdef', strict, 3).reason, 'too-long')
  assert.equal(normalizeString(5, strict, 100).reason, 'not-a-string')
})

test('integers and currency codes are exact or refused', () => {
  assert.equal(normalizeInteger(7).key, '7')
  assert.equal(normalizeInteger('-007').key, '-7')
  assert.equal(normalizeInteger('7.0').reason, 'malformed')
  assert.equal(normalizeInteger(7.5).reason, 'not-exact')
  assert.equal(normalizeInteger(null).reason, 'not-a-value')
  assert.equal(normalizeCurrency('INR').key, 'INR')
  assert.equal(normalizeCurrency('inr').reason, 'malformed')
  assert.equal(normalizeCurrency('RUPEE').reason, 'malformed')
  assert.equal(normalizeCurrency(840).reason, 'not-a-value')
})
