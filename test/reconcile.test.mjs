import assert from 'node:assert/strict'
import test from 'node:test'

import { AMOUNT, POSTED_AT, STATUS, apiReport, findingsFor, fixture, raisedRules, row } from './support.mjs'

/** The join itself: the four outcomes, the fifth state, and the counts. */

const THREE = [AMOUNT, POSTED_AT, STATUS]
const full = (overrides = {}) => ({
  invoiceId: 'INV-1',
  amount: '10.00',
  postedAt: '2026-03-01T20:30:00Z',
  status: 'Posted',
  ...overrides,
})

test('a clean one-to-one join matches and counts', async () => {
  const report = await apiReport(fixture(
    [full({ invoiceId: 'INV-1' }), full({ invoiceId: 'INV-2', amount: '20.00' })],
    [full({ invoiceId: 'INV-1' }), full({ invoiceId: 'INV-2', amount: '20.00' })],
    THREE,
  ))
  assert.deepEqual(raisedRules(report), [])
  assert.deepEqual(report.summary, {
    checked: 2, errors: 0, warnings: 0, fields: 3,
    sourceRecords: 2, destinationRecords: 2, unindexed: 0, keys: 2,
    matched: 2, conflicting: 0, duplicated: 0,
    missingInDestination: 0, missingInSource: 0, unevaluated: 0,
  })
  assert.equal(report.status, 'pass')
})

test('each of the four outcomes lands in exactly one counter', async () => {
  const report = await apiReport(fixture(
    [
      full({ invoiceId: 'INV-match' }),
      full({ invoiceId: 'INV-conflict' }),
      full({ invoiceId: 'INV-dup' }),
      full({ invoiceId: 'INV-dup', amount: '11.00' }),
      full({ invoiceId: 'INV-onlysource' }),
    ],
    [
      full({ invoiceId: 'INV-match' }),
      full({ invoiceId: 'INV-conflict', amount: '99.00' }),
      full({ invoiceId: 'INV-dup' }),
      full({ invoiceId: 'INV-onlydest' }),
    ],
    THREE,
  ))
  assert.equal(report.summary.keys, 5)
  assert.equal(report.summary.checked, 5)
  assert.equal(report.summary.matched, 1)
  assert.equal(report.summary.conflicting, 1)
  assert.equal(report.summary.duplicated, 1)
  assert.equal(report.summary.missingInDestination, 1)
  assert.equal(report.summary.missingInSource, 1)
  assert.equal(report.summary.unevaluated, 0)
  assert.deepEqual(raisedRules(report), [
    'duplicate-key-in-source', 'field-value-conflict',
    'record-missing-in-destination', 'record-missing-in-source',
  ])
})

test('one key can break on more than one field, and each break is its own finding', async () => {
  const report = await apiReport(fixture(
    [full()],
    [full({ amount: '99.00', status: 'Cancelled' })],
    THREE,
  ))
  const conflicts = findingsFor(report, 'field-value-conflict')
  assert.equal(conflicts.length, 2)
  assert.deepEqual(conflicts.map((finding) => finding.location.pointer), ['/records/0/amount', '/records/0/status'])
  assert.equal(report.summary.conflicting, 1, 'still one broken key')
})

test('a key that breaks on one field and cannot be evaluated on another is both', async () => {
  const report = await apiReport(fixture(
    [full({ invoiceId: 'INV-0' }), full({ invoiceId: 'INV-1' })],
    [full({ invoiceId: 'INV-0' }), full({ invoiceId: 'INV-1', amount: '99.00', status: undefined })],
    THREE,
  ))
  assert.deepEqual(raisedRules(report), ['field-evidence-missing', 'field-value-conflict'])
  assert.equal(report.summary.conflicting, 1, 'a definite break was found')
  assert.equal(report.status, 'incomplete', 'and a field was still never compared')
})

test('a conflict names both sides and where to find the other one', async () => {
  const report = await apiReport(fixture([full()], [full({ amount: '99.00' })], THREE))
  const finding = findingsFor(report, 'field-value-conflict')[0]
  assert.equal(finding.location.file, 'source.json')
  assert.equal(finding.location.pointer, '/records/0/amount')
  assert.equal(finding.evidence, 'source 10.00 vs destination 99.00 at destination.json/records/0/amount')
})

test('a missing key is reported on the side that has it', async () => {
  const report = await apiReport(fixture([full({ invoiceId: 'INV-1' })], [full({ invoiceId: 'INV-2' })], THREE))
  assert.equal(findingsFor(report, 'record-missing-in-destination')[0].location.file, 'source.json')
  assert.equal(findingsFor(report, 'record-missing-in-source')[0].location.file, 'destination.json')
})

test('keys that differ only by case are kept apart, and said so', async () => {
  const report = await apiReport(fixture(
    [row({ invoiceId: 'ACME-1' }), row({ invoiceId: 'acme-1', amount: '20.00' })],
    [row({ invoiceId: 'ACME-1' }), row({ invoiceId: 'acme-1', amount: '20.00' })],
  ))
  assert.deepEqual(raisedRules(report), ['key-case-collision'])
  assert.equal(report.summary.matched, 2, 'they are two keys, not one')
  const finding = findingsFor(report, 'key-case-collision')[0]
  assert.equal(finding.location.file, 'reconciliation.json')
  assert.equal(finding.location.pointer, '/key')
  assert.equal(finding.evidence, 'keys: ACME-1, acme-1')
})

test('a collision needs more than one key, so an ordinary run is quiet', async () => {
  const report = await apiReport(fixture([row({ invoiceId: 'ACME-1' })], [row({ invoiceId: 'ACME-1' })]))
  assert.deepEqual(raisedRules(report), [])
})

test('a composite key joins on every component', async () => {
  const files = fixture(
    [{ invoiceId: 'INV-1', line: '1', amount: '10.00' }, { invoiceId: 'INV-1', line: '2', amount: '20.00' }],
    [{ invoiceId: 'INV-1', line: '1', amount: '10.00' }, { invoiceId: 'INV-1', line: '3', amount: '20.00' }],
    [AMOUNT],
    ['invoiceId', 'line'],
  )
  const report = await apiReport(files)
  assert.equal(report.summary.keys, 3)
  assert.equal(report.summary.matched, 1)
  assert.equal(report.summary.missingInDestination, 1)
  assert.equal(report.summary.missingInSource, 1)
  assert.match(findingsFor(report, 'record-missing-in-destination')[0].message, /Key "INV-1 \| 2"/)
})

test('the same instant, spelled differently, is announced rather than passed over in silence', async () => {
  const report = await apiReport(fixture(
    [full({ postedAt: '2026-03-01T20:30:00Z' })],
    [full({ postedAt: '2026-03-02T02:00:00+05:30' })],
    THREE,
  ))
  assert.deepEqual(raisedRules(report), ['field-match-after-normalization'])
  assert.equal(report.status, 'pass')
  assert.equal(findingsFor(report, 'field-match-after-normalization')[0].evidence, 'both normalise to 2026-03-02')
})

test('an identical spelling raises nothing at all, so the notice is not simply always emitted', async () => {
  const report = await apiReport(fixture([full()], [full()], THREE))
  assert.deepEqual(raisedRules(report), [])
})
