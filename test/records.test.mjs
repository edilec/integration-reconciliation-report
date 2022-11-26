import assert from 'node:assert/strict'
import test from 'node:test'

import { RECORDS_KEYS, RECORDS_SCHEMA_VERSION } from '../src/index.mjs'
import { AMOUNT, apiReport, findingsFor, fixture, planOf, raisedRules, row, sideOf } from './support.mjs'

/** Reading one exported side into key groups. */

const CONTROL = { invoiceId: 'INV-0', amount: '1.00' }
const beside = (extra) => fixture([CONTROL, ...extra], [CONTROL])

test('the envelope accepts exactly two keys', async () => {
  assert.deepEqual(RECORDS_KEYS, ['records', 'schemaVersion'])
  assert.equal(RECORDS_SCHEMA_VERSION, '1')

  const unknown = await apiReport({
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': { schemaVersion: '1', records: [], rows: [] },
    'destination.json': sideOf([]),
  })
  assert.deepEqual(raisedRules(unknown), ['records-invalid'])

  const version = await apiReport({
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': { schemaVersion: 1, records: [] },
    'destination.json': sideOf([]),
  })
  assert.deepEqual(raisedRules(version), ['records-invalid'])

  const notAnArray = await apiReport({
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': { schemaVersion: '1', records: {} },
    'destination.json': sideOf([]),
  })
  assert.deepEqual(raisedRules(notAnArray), ['records-invalid'])
})

test('properties the plan does not mention are data and are left alone', async () => {
  const report = await apiReport(fixture(
    [{ invoiceId: 'INV-1', amount: '10.00', ledgerLine: 41, memo: 'anything at all' }],
    [{ invoiceId: 'INV-1', amount: '10.00', batch: 'B-9' }],
  ))
  assert.deepEqual(raisedRules(report), [])
  assert.equal(report.summary.matched, 1)
})

test('a record that is not an object is reported and not indexed', async () => {
  for (const bad of [7, null, 'INV-1', ['INV-1']]) {
    const report = await apiReport(beside([bad]))
    assert.deepEqual(raisedRules(report), ['record-invalid'], JSON.stringify(bad))
    assert.equal(report.summary.unindexed, 1)
    assert.equal(report.summary.sourceRecords, 2, 'it was still counted as read')
  }
})

test('a key component may be a string or an exact integer, and nothing else', async () => {
  const asInteger = await apiReport(fixture([{ invoiceId: 4711, amount: '10.00' }], [{ invoiceId: '4711', amount: '10.00' }]))
  assert.deepEqual(raisedRules(asInteger), [])
  assert.equal(asInteger.summary.matched, 1)

  for (const bad of [undefined, null, true, 47.5, {}, []]) {
    const report = await apiReport(beside([{ invoiceId: bad, amount: '10.00' }]))
    assert.deepEqual(raisedRules(report), ['record-key-missing'], String(bad))
    assert.equal(report.summary.unindexed, 1)
  }
})

test('a key component that is not a usable identifier is refused', async () => {
  for (const bad of [' INV-1', 'INV-1 ', '', 'x'.repeat(201)]) {
    const report = await apiReport(beside([{ invoiceId: bad, amount: '10.00' }]))
    assert.deepEqual(raisedRules(report), ['identifier-invalid'], JSON.stringify(bad.slice(0, 12)))
  }
  assert.deepEqual(raisedRules(await apiReport(beside([{ invoiceId: 'x'.repeat(200), amount: '1.00' }]))), ['record-missing-in-destination'])
})

/**
 * A key is grouped by its value and reported by its rendering, and the two
 * have to be the same string.
 *
 * U+00A0, U+2007, U+3000 and U+FEFF all pass every control, separator and bidi
 * class, and every one of them collapses to a plain space on the way into the
 * report: four distinct keys, four groups, and `Key "INV- 1"` printed four
 * times. Each is refused now, and the one key that prints as itself is the
 * only one grouped.
 */
test('a key that would print as a different key is refused rather than grouped', async () => {
  const spaces = [0x00a0, 0x2007, 0x3000, 0xfeff].map((code) => String.fromCharCode(code))
  const report = await apiReport(fixture(
    [...spaces.map((space) => ({ invoiceId: `INV-${space}1`, amount: '1.00' })), { invoiceId: 'INV- 1', amount: '1.00' }],
    [],
  ))

  assert.deepEqual(raisedRules(report), ['identifier-invalid', 'record-missing-in-destination'])
  assert.equal(findingsFor(report, 'identifier-invalid').length, 4)
  assert.equal(report.summary.unindexed, 4)
  assert.equal(report.summary.keys, 1, 'only the key that prints as itself was grouped')
  assert.equal(report.status, 'incomplete')

  const named = findingsFor(report, 'record-missing-in-destination').map((finding) => /^Key "([^"]+)"/.exec(finding.message)[1])
  assert.deepEqual(named, ['INV- 1'])
})

test('a key at the length limit prints in full, so two long keys never print alike', async () => {
  const prefix = 'x'.repeat(190)
  const report = await apiReport(fixture(
    [{ invoiceId: `${prefix}-1`, amount: '1.00' }, { invoiceId: `${prefix}-2`, amount: '1.00' }],
    [],
  ))

  const named = findingsFor(report, 'record-missing-in-destination').map((finding) => /^Key "([^"]+)"/.exec(finding.message)[1])
  assert.deepEqual(named, [`${prefix}-1`, `${prefix}-2`])
  assert.equal(new Set(named).size, 2, 'two keys that share a 190-character prefix are still told apart in print')
})

test('a composite key names every component it is missing, once', async () => {
  const report = await apiReport({
    'reconciliation.json': planOf([AMOUNT], ['invoiceId', 'line', 'batch']),
    'source.json': sideOf([{ amount: '10.00' }]),
    'destination.json': sideOf([]),
  })
  const missing = findingsFor(report, 'record-key-missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].evidence, 'missing key fields: batch, invoiceId, line')
  assert.equal(missing[0].location.pointer, '/records/0')
})

test('every record is counted as read even when it could not be indexed', async () => {
  const report = await apiReport(fixture([CONTROL, 7, { amount: '1.00' }], [CONTROL]))
  assert.equal(report.summary.sourceRecords, 3)
  assert.equal(report.summary.unindexed, 2)
  assert.equal(report.summary.keys, 1)
  assert.equal(report.status, 'incomplete')
})

test('an empty export is read, and produces no key of its own', async () => {
  const report = await apiReport(fixture([row({ invoiceId: 'INV-1' })], []))
  assert.equal(report.summary.destinationRecords, 0)
  assert.equal(report.summary.keys, 1)
  assert.deepEqual(raisedRules(report), ['record-missing-in-destination'])
})
