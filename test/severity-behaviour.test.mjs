import assert from 'node:assert/strict'
import test from 'node:test'

import { AMOUNT, cliReport, fixture, planOf, raisedRules, row, sideOf } from './support.mjs'

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog. That is worth having and it is not this: a table, a catalog and a
 * hand-written expected map are three declarations agreeing with each other,
 * and a coordinated edit of all three passes every one of those assertions. A
 * rule quietly demoted from `error` to `warning` would reach exit 0 with the
 * whole suite green.
 *
 * These tests assert the consequence instead. Each case builds a root that
 * isolates one rule, runs the real binary, and pins the rules raised, the
 * report status and the process exit code, written out literally. A demotion
 * changes the observable outcome -- `fail` becomes `pass`, exit 1 becomes exit
 * 0 -- and an exit code cannot be edited at all.
 *
 * Only the rules whose severity *alone* decides the verdict can be pinned this
 * way. The rest are backstopped by the `incomplete` flag and exit 2 whatever
 * their severity says; those are pinned in `test/severity-word.test.mjs` by
 * their error count and their printed severity word, and the tail of this file
 * asserts that they do exit 2.
 */

test('field-value-conflict alone turns a run red', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
    [row({ invoiceId: 'INV-1', amount: '11.00' })],
  ))
  assert.deepEqual(raisedRules(result.report), ['field-value-conflict'])
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
})

test('amount-currency-conflict alone turns a run red', async () => {
  const fields = [{ name: 'amount', type: 'amount', precision: 2, currencyField: 'currency' }]
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '99.00', currency: 'INR' })],
    [row({ invoiceId: 'INV-1', amount: '99.00', currency: 'USD' })],
    fields,
  ))
  assert.deepEqual(raisedRules(result.report), ['amount-currency-conflict'])
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
})

test('duplicate-key-in-source alone turns a run red', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '11.00' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))
  assert.deepEqual(raisedRules(result.report), ['duplicate-key-in-source'])
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
})

test('duplicate-key-in-destination alone turns a run red', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '11.00' })],
  ))
  assert.deepEqual(raisedRules(result.report), ['duplicate-key-in-destination'])
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
})

test('record-missing-in-destination alone turns a run red', async () => {
  const result = await cliReport(fixture([row({ invoiceId: 'INV-1' })], []))
  assert.deepEqual(raisedRules(result.report), ['record-missing-in-destination'])
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
})

test('record-missing-in-source alone turns a run red', async () => {
  const result = await cliReport(fixture([], [row({ invoiceId: 'INV-1' })]))
  assert.deepEqual(raisedRules(result.report), ['record-missing-in-source'])
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
})

test('key-case-collision alone leaves a run green, so promoting it would be visible too', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-a' }), row({ invoiceId: 'inv-a', amount: '20.00' })],
    [row({ invoiceId: 'INV-a' }), row({ invoiceId: 'inv-a', amount: '20.00' })],
  ))
  assert.deepEqual(raisedRules(result.report), ['key-case-collision'])
  assert.equal(result.report.status, 'pass')
  assert.equal(result.code, 0)
  assert.equal(result.report.summary.warnings, 1)
  assert.equal(result.report.summary.errors, 0)
})

test('field-match-after-normalization alone leaves a run green', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.0' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))
  assert.deepEqual(raisedRules(result.report), ['field-match-after-normalization'])
  assert.equal(result.report.status, 'pass')
  assert.equal(result.code, 0)
  assert.equal(result.report.summary.errors, 0)
  assert.equal(result.report.summary.warnings, 0)
})

test('duplicate-values-identical adds nothing to the verdict its duplication already set', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '10.0' })],
    [row({ invoiceId: 'INV-1', amount: '10.00' })],
  ))
  assert.deepEqual(raisedRules(result.report), ['duplicate-key-in-source', 'duplicate-values-identical'])
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1, 'the duplication is the error; the agreement is information')
})

test('a clean pair of exports reaches exit 0, so every failure above is a real difference', async () => {
  const result = await cliReport(fixture(
    [row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-2', amount: '20.00' })],
    [row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-2', amount: '20.00' })],
  ))
  assert.deepEqual(raisedRules(result.report), [])
  assert.equal(result.report.status, 'pass')
  assert.equal(result.code, 0)
  assert.equal(result.report.summary.matched, 2)
  assert.equal(result.report.summary.checked, 2)
})

test('a rule that also marks the run incomplete exits 2, which is why its severity is pinned elsewhere', async () => {
  const unreadable = await cliReport({
    'reconciliation.json': planOf([AMOUNT]),
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  assert.deepEqual(raisedRules(unreadable.report), ['input-unreadable'])
  assert.equal(unreadable.report.status, 'incomplete')
  assert.equal(unreadable.code, 2)

  const refused = await cliReport(fixture(
    [row({ invoiceId: 'INV-0', amount: '1.00' }), row({ invoiceId: 'INV-1', amount: 10.1 })],
    [row({ invoiceId: 'INV-0', amount: '1.00' }), row({ invoiceId: 'INV-1', amount: '10.10' })],
  ))
  assert.deepEqual(raisedRules(refused.report), ['amount-not-exact'])
  assert.equal(refused.report.status, 'incomplete')
  assert.equal(refused.code, 2)
})
