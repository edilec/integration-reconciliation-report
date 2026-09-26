import assert from 'node:assert/strict'
import test from 'node:test'

import { AMOUNT, apiReport, cliReport, findingsFor, fixture, raisedRules, row, sideOf } from './support.mjs'

/**
 * Acceptance: a duplicated key never overwrites itself.
 *
 * The defining bug of a reconciliation tool is `index.set(key, record)`. Two
 * rows share a key, the second silently replaces the first, and the report
 * shows a clean one-to-one outcome over whichever row happened to be read
 * last -- while the duplicate, the thing the operator most needed to see, is
 * never mentioned.
 *
 * Every case here is built so that **both** overwrite variants are caught:
 *
 * - keep-the-last would compare the second row and report a match or a
 *   conflict over it;
 * - keep-the-first would compare the first row and report the other one;
 *
 * and both would report `duplicated: 0`. So each case asserts `duplicated`,
 * `matched` and `conflicting` together, and asserts that every pointer in the
 * group is named in the report. A group of `n` rows must produce `n` pointers,
 * which no map keyed by the join key can produce at all.
 */

test('two source rows for one key are both kept, and neither is compared', async () => {
  // The destination row matches the FIRST source row exactly. Keep-the-first
  // would report a clean match; keep-the-last would report a conflict.
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '99.00' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))

  assert.equal(report.summary.duplicated, 1)
  assert.equal(report.summary.matched, 0, 'a duplicated key is never a match')
  assert.equal(report.summary.conflicting, 0, 'and it is never compared, so it is never a conflict')
  assert.equal(report.summary.sourceRecords, 2, 'both rows were read')
  assert.deepEqual(raisedRules(report), ['duplicate-key-in-source'])

  const duplicate = findingsFor(report, 'duplicate-key-in-source')[0]
  assert.equal(duplicate.evidence, 'records: /records/0, /records/1', 'every row in the group is named')
  assert.match(duplicate.message, /is carried by 2 records in source\.json/)
  assert.match(duplicate.message, /the destination side holds 1 record\(s\)/)
})

test('the same pair with the destination matching the SECOND row reports the same duplication', async () => {
  // The mirror image of the case above. One of the two overwrite variants
  // survives each of these on its own; neither survives both.
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '99.00' })],
    [row({ invoiceId: 'INV-1', amount: '99.00' })],
  ))

  assert.equal(report.summary.duplicated, 1)
  assert.equal(report.summary.matched, 0)
  assert.equal(report.summary.conflicting, 0)
  assert.deepEqual(raisedRules(report), ['duplicate-key-in-source'])
  assert.equal(findingsFor(report, 'duplicate-key-in-source')[0].evidence, 'records: /records/0, /records/1')
})

test('a group of five rows names five pointers, which no key-indexed map can do', async () => {
  const rows = []
  for (let index = 0; index < 5; index += 1) rows.push(row({ invoiceId: 'INV-1', amount: `${10 + index}.00` }))
  const report = await apiReport(fixture(rows, [row({ invoiceId: 'INV-1', amount: '10.00' })]))

  const duplicate = findingsFor(report, 'duplicate-key-in-source')[0]
  assert.equal(duplicate.evidence, 'records: /records/0, /records/1, /records/2, /records/3, /records/4')
  assert.equal(report.summary.sourceRecords, 5)
  assert.equal(report.summary.duplicated, 1)
  assert.equal(report.summary.matched, 0)
})

test('a duplicated destination key is reported on its own side', async () => {
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))

  assert.deepEqual(raisedRules(report), ['duplicate-key-in-destination', 'duplicate-values-identical'])
  const duplicate = findingsFor(report, 'duplicate-key-in-destination')[0]
  assert.equal(duplicate.location.file, 'destination.json')
  assert.equal(duplicate.evidence, 'records: /records/0, /records/1')
  assert.equal(report.summary.duplicated, 1)
  assert.equal(report.summary.matched, 0)
})

test('duplicates on both sides produce one finding per side and one duplicated key', async () => {
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '11.00' })],
    [row({ invoiceId: 'INV-1', amount: '12.00' }), row({ invoiceId: 'INV-1', amount: '13.00' })],
  ))

  assert.equal(findingsFor(report, 'duplicate-key-in-source').length, 1)
  assert.equal(findingsFor(report, 'duplicate-key-in-destination').length, 1)
  assert.equal(report.summary.duplicated, 1, 'one key, two duplicated sides')
  assert.equal(report.summary.keys, 1)
  assert.equal(report.summary.checked, 1)
})

test('rows that agree once normalised are still duplicated, and say so separately', async () => {
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '10.0' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))

  assert.deepEqual(raisedRules(report), ['duplicate-key-in-source', 'duplicate-values-identical'])
  assert.equal(report.summary.duplicated, 1)
  assert.equal(report.summary.matched, 0, 'agreeing with each other does not make a duplicate group a match')
  const identical = findingsFor(report, 'duplicate-values-identical')[0]
  assert.equal(identical.severity, 'info')
  assert.match(identical.message, /agree on every declared field once normalised/)
})

test('rows that disagree with each other do not claim to agree', async () => {
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '10.01' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))
  assert.deepEqual(raisedRules(report), ['duplicate-key-in-source'])
})

test('a duplicated key with nothing on the other side says so in the same finding', async () => {
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '11.00' })],
    [],
  ))

  assert.equal(report.summary.duplicated, 1)
  assert.equal(report.summary.missingInDestination, 0, 'the duplication is the outcome; the empty side is named in its message')
  assert.match(findingsFor(report, 'duplicate-key-in-source')[0].message, /the destination side holds 0 record\(s\)/)
})

test('a duplicated key fails the real binary with exit 1', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '10.00' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))

  assert.equal(result.code, 1)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.report.summary.duplicated, 1)
  assert.equal(result.report.summary.matched, 0)
})

test('a composite key duplicates only when every component repeats', async () => {
  const files = {
    'reconciliation.json': { schemaVersion: '1', key: ['invoiceId', 'line'], fields: [AMOUNT] },
    'source.json': sideOf([
      { invoiceId: 'INV-1', line: '1', amount: '10.00' },
      { invoiceId: 'INV-1', line: '2', amount: '20.00' },
      { invoiceId: 'INV-1', line: '2', amount: '30.00' },
    ]),
    'destination.json': sideOf([
      { invoiceId: 'INV-1', line: '1', amount: '10.00' },
      { invoiceId: 'INV-1', line: '2', amount: '20.00' },
    ]),
  }
  const report = await apiReport(files)

  assert.equal(report.summary.matched, 1, 'INV-1|1 is a clean one-to-one match')
  assert.equal(report.summary.duplicated, 1, 'INV-1|2 repeats on the source side')
  assert.equal(findingsFor(report, 'duplicate-key-in-source')[0].evidence, 'records: /records/1, /records/2')
})

test('two key components cannot be confused by where the separator falls', async () => {
  // A composite key joined with a plain delimiter would make ("a|b", "c") and
  // ("a", "b|c") the same key. They are not the same key.
  const files = {
    'reconciliation.json': { schemaVersion: '1', key: ['a', 'b'], fields: [AMOUNT] },
    'source.json': sideOf([
      { a: 'x|y', b: 'z', amount: '10.00' },
      { a: 'x', b: 'y|z', amount: '20.00' },
    ]),
    'destination.json': sideOf([
      { a: 'x|y', b: 'z', amount: '10.00' },
      { a: 'x', b: 'y|z', amount: '20.00' },
    ]),
  }
  const report = await apiReport(files)

  assert.equal(report.summary.keys, 2)
  assert.equal(report.summary.matched, 2)
  assert.equal(report.summary.duplicated, 0)
})
