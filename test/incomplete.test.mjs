import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AMOUNT, cliReport, cliRun, fixture, planOf, raisedRules, row, sideOf } from './support.mjs'

/**
 * Every place the tool marks a run `incomplete`, with a test that fails when
 * the flag is removed.
 *
 * Deleting one `incomplete = true` in a sibling tool let an entirely unread
 * input report `pass`, with the full suite still green. The flag is invisible
 * on its own, so each case here is built so that removing it changes the
 * observable outcome: every case raises an error-severity finding, so with the
 * flag the run is `incomplete` and exits 2, and without it the run is `fail`
 * and exits 1.
 *
 * Each case also isolates its own site. Where another guard would backstop it
 * -- the vacuous-pass rule fires whenever a run decides no key at all -- the
 * fixture carries one clean key alongside, so the site under test is the only
 * thing marking the run incomplete.
 */

const CONTROL = { invoiceId: 'INV-0', amount: '1.00' }
const pair = (extraSource = [], extraDestination = []) => fixture(
  [CONTROL, ...extraSource],
  [CONTROL, ...extraDestination],
)

async function expectIncomplete(result, rules) {
  assert.deepEqual(raisedRules(result.report), rules)
  assert.equal(result.report.status, 'incomplete', 'removing the flag would make this "fail"')
  assert.equal(result.code, 2, 'removing the flag would make this exit 1')
}

test('site: an input that resolves outside the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'integration-reconciliation-report-escape-'))
  try {
    await writeFile(join(root, 'reconciliation.json'), `${JSON.stringify(planOf([AMOUNT]))}\n`)
    await writeFile(join(root, 'destination.json'), `${JSON.stringify(sideOf([row({ invoiceId: 'INV-1' })]))}\n`)
    await symlink('/etc/hosts', join(root, 'source.json'))
    const run = await cliRun(['--root', root, '--json'])
    await expectIncomplete({ report: JSON.parse(run.stdout), code: run.code }, ['path-escapes-root'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('site: an input that could not be resolved at all', async () => {
  const result = await cliReport({
    'reconciliation.json': planOf([AMOUNT]),
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  await expectIncomplete(result, ['input-unreadable'])
})

test('site: an input that decoded but is not JSON', async () => {
  const result = await cliReport({
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': '{ not json',
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  await expectIncomplete(result, ['input-not-json'])
})

test('site: an input that is not UTF-8', async () => {
  const result = await cliReport({
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': new Uint8Array([0x7b, 0x80, 0x7d]),
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  await expectIncomplete(result, ['input-not-utf8'])
})

test('site: a plan that did not compile at all', async () => {
  const result = await cliReport({
    'reconciliation.json': { schemaVersion: '1', key: ['invoiceId'], fields: [{ name: 'amount', type: 'money' }] },
    'source.json': sideOf([row({ invoiceId: 'INV-1' })]),
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  await expectIncomplete(result, ['plan-type-unsupported'])
})

test('site: a plan that compiled with one field refused', async () => {
  const result = await cliReport({
    'reconciliation.json': planOf([AMOUNT, { name: 'amount', type: 'amount', precision: 2 }]),
    'source.json': sideOf([row({ invoiceId: 'INV-1' })]),
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  await expectIncomplete(result, ['plan-field-duplicate'])
  assert.equal(result.report.summary.matched, 1, 'the surviving field did compare; the refused one did not')
})

test('site: an export whose envelope was refused', async () => {
  const result = await cliReport({
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': { schemaVersion: '1', records: [row({ invoiceId: 'INV-1' })], rows: [] },
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  await expectIncomplete(result, ['records-invalid'])
})

test('site: a record that could not be indexed', async () => {
  const notAnObject = await cliReport(pair([7]))
  await expectIncomplete(notAnObject, ['record-invalid'])
  assert.equal(notAnObject.report.summary.checked, 1, 'the control key was still decided')

  const noKey = await cliReport(pair([{ amount: '10.00' }]))
  await expectIncomplete(noKey, ['record-key-missing'])

  const badKey = await cliReport(pair([{ invoiceId: `INV${String.fromCharCode(0x202e)}1`, amount: '10.00' }]))
  await expectIncomplete(badKey, ['identifier-invalid'])
})

test('site: a key the maxKeys cut-off never reached', async () => {
  const result = await cliReport(
    fixture(
      [row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-2', amount: '20.00' })],
      [row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-2', amount: '20.00' })],
    ),
    ['--max-keys', '1'],
  )
  await expectIncomplete(result, ['too-many-keys'])
  assert.equal(result.report.summary.unevaluated, 1)
})

test('site: a duplicated group larger than maxRecordsPerKey can name', async () => {
  const result = await cliReport(
    fixture(
      [row({ invoiceId: 'INV-1', amount: '10.00' }), row({ invoiceId: 'INV-1', amount: '11.00' })],
      [row({ invoiceId: 'INV-1', amount: '10.00' })],
    ),
    ['--max-records-per-key', '1'],
  )
  await expectIncomplete(result, ['duplicate-key-in-source', 'too-many-records-for-key'])
})

test('site: a declared field one side does not carry', async () => {
  const result = await cliReport(pair([row({ invoiceId: 'INV-1' })], [{ invoiceId: 'INV-1' }]))
  await expectIncomplete(result, ['field-evidence-missing'])
  assert.equal(result.report.summary.matched, 1, 'only the control key; the other is unevaluated')
})

test('site: a value that could not be normalised', async () => {
  const result = await cliReport(pair([row({ invoiceId: 'INV-1', amount: 10.1 })], [row({ invoiceId: 'INV-1', amount: '10.10' })]))
  await expectIncomplete(result, ['amount-not-exact'])
})

test('site: a declared currency one side does not carry', async () => {
  const fields = [{ name: 'amount', type: 'amount', precision: 2, currencyField: 'currency' }]
  const result = await cliReport(fixture(
    [{ invoiceId: 'INV-0', amount: '1.00', currency: 'INR' }, { invoiceId: 'INV-1', amount: '9.00', currency: 'INR' }],
    [{ invoiceId: 'INV-0', amount: '1.00', currency: 'INR' }, { invoiceId: 'INV-1', amount: '9.00' }],
    fields,
  ))
  await expectIncomplete(result, ['field-evidence-missing'])
})

test('site: a report truncated by maxFindings', async () => {
  const result = await cliReport(
    fixture([row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-2' }), row({ invoiceId: 'INV-3' })], []),
    ['--max-findings', '1'],
  )
  await expectIncomplete(result, ['too-many-findings'])
  assert.equal(result.report.findings.length, 1)
})

test('site: the vacuous pass, where the join decided nothing', async () => {
  const result = await cliReport(fixture([], []))
  await expectIncomplete(result, ['no-records-evaluated'])
  assert.equal(result.report.summary.checked, 0)
  assert.equal(result.report.summary.keys, 0)
  // Removing the whole guard would leave `pass` with `checked: 0` and exit 0;
  // removing only the flag would leave `fail` and exit 1. Both are refused.
  assert.notEqual(result.report.status, 'pass')
})

test('a run that obtained all its evidence is not incomplete, so the flag is not simply always set', async () => {
  const result = await cliReport(pair([row({ invoiceId: 'INV-1' })], [row({ invoiceId: 'INV-1' })]))
  assert.deepEqual(raisedRules(result.report), [])
  assert.equal(result.report.status, 'pass')
  assert.equal(result.code, 0)
})
