import assert from 'node:assert/strict'
import test from 'node:test'

import { FIELD_KEYS, FIELD_TYPES, PLAN_KEYS, isFieldName } from '../src/index.mjs'
import { AMOUNT, apiReport, findingsFor, planOf, raisedRules, row, sideOf } from './support.mjs'

/** The plan, compiled through the real entry point. */

const withPlan = (plan) => apiReport({
  'reconciliation.json': plan,
  'source.json': sideOf([row({ invoiceId: 'INV-1', status: 'ok', postedAt: '2026-03-01T00:00:00Z', line: 1 })]),
  'destination.json': sideOf([row({ invoiceId: 'INV-1', status: 'ok', postedAt: '2026-03-01T00:00:00Z', line: 1 })]),
})

test('a complete plan compiles and the join runs', async () => {
  const report = await withPlan(planOf([
    AMOUNT,
    { name: 'postedAt', type: 'date', timezone: '+05:30', granularity: 'day' },
    { name: 'status', type: 'string', trim: true, caseSensitive: false, collapseWhitespace: true },
    { name: 'line', type: 'integer' },
  ]))
  assert.deepEqual(raisedRules(report), [])
  assert.equal(report.summary.fields, 4)
  assert.equal(report.summary.matched, 1)
})

test('an unknown top-level key is refused by name', async () => {
  const report = await withPlan({ schemaVersion: '1', key: ['invoiceId'], fields: [AMOUNT], keys: ['x'] })
  assert.deepEqual(raisedRules(report), ['plan-key-unknown'])
  const finding = findingsFor(report, 'plan-key-unknown')[0]
  assert.equal(finding.location.pointer, '/keys')
  assert.match(finding.message, /it accepts fields, key, schemaVersion/)
})

test('an unknown key inside a field is refused, including one that belongs to another type', async () => {
  const foreign = await withPlan(planOf([{ name: 'amount', type: 'amount', precision: 2, granularity: 'day' }]))
  assert.deepEqual(raisedRules(foreign), ['plan-field-invalid'])
  assert.match(findingsFor(foreign, 'plan-field-invalid')[0].message, /does not accept the key "granularity"/)

  const typo = await withPlan(planOf([{ name: 'amount', type: 'amount', precision: 2, currencyfield: 'currency' }]))
  assert.deepEqual(raisedRules(typo), ['plan-field-invalid'])
})

test('a field type this tool cannot normalise is reported as unsupported', async () => {
  const report = await withPlan(planOf([{ name: 'amount', type: 'decimal' }]))
  assert.deepEqual(raisedRules(report), ['plan-type-unsupported'])
  assert.match(findingsFor(report, 'plan-type-unsupported')[0].message, /the supported types are amount, date, integer, string/)
  assert.equal(report.status, 'incomplete', 'an unsupported construct is never silently satisfied')
})

test('an amount field must declare a precision in range', async () => {
  for (const precision of [undefined, -1, 9, 2.5, '2']) {
    const report = await withPlan(planOf([{ name: 'amount', type: 'amount', precision }]))
    assert.deepEqual(raisedRules(report), ['plan-field-invalid'], String(precision))
  }
  assert.deepEqual(raisedRules(await withPlan(planOf([{ name: 'amount', type: 'amount', precision: 0 }]))), [])
  assert.deepEqual(raisedRules(await withPlan(planOf([{ name: 'amount', type: 'amount', precision: 8 }]))), [])
})

test('a date field must declare a fixed offset and a known granularity', async () => {
  for (const timezone of [undefined, 'Asia/Kolkata', 'IST', '+15:00', 5]) {
    const report = await withPlan(planOf([{ name: 'postedAt', type: 'date', timezone, granularity: 'day' }]))
    assert.deepEqual(raisedRules(report), ['plan-timezone-unsupported'], String(timezone))
  }
  for (const granularity of [undefined, 'week', 'second', 3]) {
    const report = await withPlan(planOf([{ name: 'postedAt', type: 'date', timezone: 'Z', granularity }]))
    assert.deepEqual(raisedRules(report), ['plan-granularity-unsupported'], String(granularity))
  }
})

test('a string field takes booleans and nothing else for its options', async () => {
  for (const key of ['trim', 'caseSensitive', 'collapseWhitespace']) {
    const report = await withPlan(planOf([{ name: 'status', type: 'string', [key]: 'yes' }]))
    assert.deepEqual(raisedRules(report), ['plan-field-invalid'], key)
  }
})

test('a currencyField must be a distinct field name', async () => {
  const sameName = await withPlan(planOf([{ name: 'amount', type: 'amount', precision: 2, currencyField: 'amount' }]))
  assert.deepEqual(raisedRules(sameName), ['plan-field-invalid'])
  const notAName = await withPlan(planOf([{ name: 'amount', type: 'amount', precision: 2, currencyField: '' }]))
  assert.deepEqual(raisedRules(notAName), ['plan-field-invalid'])
})

test('a field declared twice is refused rather than silently replacing the first', async () => {
  const report = await withPlan(planOf([AMOUNT, { name: 'amount', type: 'amount', precision: 4 }]))
  assert.deepEqual(raisedRules(report), ['plan-field-duplicate'])
  assert.equal(report.summary.fields, 1)
  assert.equal(report.status, 'incomplete', 'one declared field was never compared')
})

test('a key component declared twice is refused', async () => {
  const report = await withPlan(planOf([AMOUNT], ['invoiceId', 'invoiceId']))
  assert.deepEqual(raisedRules(report), ['plan-field-duplicate'])
})

test('a key component may not also be a compared field', async () => {
  const report = await withPlan(planOf([{ name: 'invoiceId', type: 'string' }]))
  assert.deepEqual(raisedRules(report), ['plan-field-invalid'])
  assert.match(findingsFor(report, 'plan-field-invalid')[0].message, /both sides hold the same value by construction/)
})

test('the plan shape itself is checked', async () => {
  assert.deepEqual(raisedRules(await withPlan({ schemaVersion: '2', key: ['invoiceId'], fields: [AMOUNT] })), ['plan-invalid'])
  assert.deepEqual(raisedRules(await withPlan({ key: ['invoiceId'], fields: [AMOUNT] })), ['plan-invalid'])
  assert.deepEqual(raisedRules(await withPlan({ schemaVersion: '1', key: [], fields: [AMOUNT] })), ['plan-invalid'])
  assert.deepEqual(raisedRules(await withPlan({ schemaVersion: '1', key: 'invoiceId', fields: [AMOUNT] })), ['plan-invalid'])
  assert.deepEqual(raisedRules(await withPlan({ schemaVersion: '1', key: ['invoiceId'], fields: {} })), ['plan-invalid'])
  assert.deepEqual(raisedRules(await withPlan({ schemaVersion: '1', key: ['invoiceId'], fields: [] })), ['no-fields-declared'])
  assert.deepEqual(raisedRules(await withPlan([])), ['plan-invalid'])
  assert.deepEqual(raisedRules(await withPlan(planOf([7]))), ['plan-field-invalid'])
  assert.deepEqual(raisedRules(await withPlan(planOf([AMOUNT], [7]))), ['plan-invalid'])
})

test('a field name is a literal key with a bounded alphabet', () => {
  assert.equal(isFieldName('amount'), true)
  assert.equal(isFieldName('a-b'), true)
  assert.equal(isFieldName('a_b'), true)
  assert.equal(isFieldName('a.b'), true, 'a dot is a dot, never a path step')
  assert.equal(isFieldName('0amount'), true)
  assert.equal(isFieldName('-amount'), false)
  assert.equal(isFieldName(''), false)
  assert.equal(isFieldName('x'.repeat(65)), false)
  assert.equal(isFieldName('a b'), false)
  assert.equal(isFieldName(7), false)
})

test('the declared key and type vocabularies are frozen and consistent', () => {
  assert.equal(Object.isFrozen(PLAN_KEYS), true)
  assert.equal(Object.isFrozen(FIELD_TYPES), true)
  assert.equal(Object.isFrozen(FIELD_KEYS), true)
  assert.deepEqual([...FIELD_TYPES].sort(), Object.keys(FIELD_KEYS).sort())
  for (const type of FIELD_TYPES) {
    assert.equal(FIELD_KEYS[type].includes('name'), true, type)
    assert.equal(FIELD_KEYS[type].includes('type'), true, type)
  }
})

test('a nested value is not reached into, because a field name is not a path', async () => {
  const report = await apiReport({
    'reconciliation.json': planOf([{ name: 'total.gross', type: 'amount', precision: 2 }]),
    'source.json': sideOf([{ invoiceId: 'INV-1', total: { gross: '10.00' } }]),
    'destination.json': sideOf([{ invoiceId: 'INV-1', total: { gross: '10.00' } }]),
  })
  assert.deepEqual(raisedRules(report), ['field-evidence-missing', 'no-records-evaluated'])
  assert.equal(report.summary.matched, 0)
})
