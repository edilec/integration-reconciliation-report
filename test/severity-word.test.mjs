import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, asserted literally, one rule at a time.
 *
 * This file deliberately shares nothing with the rest of the suite. It imports
 * no severity table, reads no catalog, imports no fixture builder from
 * `test/support.mjs`, and takes no expectation from a map, an array or a loop
 * variable. Every rule id, every count, every status, every exit code and every
 * printed severity word is written out inline, at the place it is asserted.
 *
 * That is the whole point. A frozen table, a documented catalog and a test's
 * expected-value map are three declarations, and a single edit that changes all
 * three leaves every assertion comparing them satisfied -- including an
 * assertion made inside a loop over that same map, and including a
 * "behavioural" test that drives the real binary but compares the result
 * against `CASES[i].severity`. Nothing below can be satisfied by editing a
 * declaration: `assert.equal(report.summary.errors, 1)` is a number in this
 * file and nowhere else.
 *
 * Most of these rules also mark the run incomplete, so their exit code is 2
 * whether their severity says `error` or `warning`. For those the error count
 * and the printed severity word are the assertion.
 *
 * The builders below are **inputs**, not expectations: they construct the
 * documents a case feeds in, and carry no severity, no rule id and no count.
 */

const execFileAsync = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../bin/integration-reconciliation-report.mjs')

/** Build a root, run the real binary over it with the human report on, tear the root down. */
async function audit(files, extraArgs = [], links = {}, hardLinks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'integration-reconciliation-report-word-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    for (const [name, target] of Object.entries(links)) await symlink(target, join(root, name))
    for (const [name, target] of Object.entries(hardLinks)) await link(join(root, target), join(root, name))
    return await spawn(['--root', root, ...extraArgs])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function spawn(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args])
    return { code: 0, report: JSON.parse(stdout), stderr }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr ?? '' }
  }
}

/** The printed line that mentions a rule. Carries no expectation of its own. */
function lineFor(stderr, ruleId) {
  const found = stderr.split('\n').filter((line) => line.includes(` ${ruleId} `))
  assert.equal(found.length >= 1, true, `${ruleId} was not printed at all`)
  return found[0]
}

// Inputs only. Nothing here decides what a case expects.
const side = (records) => ({ schemaVersion: '1', records })
const amountPlan = { schemaVersion: '1', key: ['invoiceId'], fields: [{ name: 'amount', type: 'amount', precision: 2 }] }
const datePlan = { schemaVersion: '1', key: ['invoiceId'], fields: [{ name: 'postedAt', type: 'date', timezone: 'Z', granularity: 'day' }] }
const stringPlan = { schemaVersion: '1', key: ['invoiceId'], fields: [{ name: 'status', type: 'string' }] }
const amountControl = { invoiceId: 'INV-0', amount: '1.00' }
const dateControl = { invoiceId: 'INV-0', postedAt: '2026-01-01T00:00:00Z' }
const stringControl = { invoiceId: 'INV-0', status: 'ok' }

test('amount-currency-conflict prints ERROR, counts one error and exits 1', async () => {
  const plan = { schemaVersion: '1', key: ['invoiceId'], fields: [{ name: 'amount', type: 'amount', precision: 2, currencyField: 'currency' }] }
  const result = await audit({
    'reconciliation.json': plan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '99.00', currency: 'INR' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '99.00', currency: 'USD' }]),
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result.stderr, 'amount-currency-conflict').startsWith('ERROR'), true)
})

test('amount-exceeds-declared-precision prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([amountControl, { invoiceId: 'INV-1', amount: '10.005' }]),
    'destination.json': side([amountControl, { invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.matched, 1)
  assert.equal(lineFor(result.stderr, 'amount-exceeds-declared-precision').startsWith('ERROR'), true)
})

test('amount-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([amountControl, { invoiceId: 'INV-1', amount: 'ten pounds' }]),
    'destination.json': side([amountControl, { invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'amount-invalid').startsWith('ERROR'), true)
})

test('amount-not-exact prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([amountControl, { invoiceId: 'INV-1', amount: 10.1 }]),
    'destination.json': side([amountControl, { invoiceId: 'INV-1', amount: '10.10' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'amount-not-exact').startsWith('ERROR'), true)
})

test('date-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': datePlan,
    'source.json': side([dateControl, { invoiceId: 'INV-1', postedAt: '2026-02-29T00:00:00Z' }]),
    'destination.json': side([dateControl, { invoiceId: 'INV-1', postedAt: '2026-03-01T00:00:00Z' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'date-invalid').startsWith('ERROR'), true)
})

test('date-offset-missing prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': datePlan,
    'source.json': side([dateControl, { invoiceId: 'INV-1', postedAt: '2026-03-01T20:30:00' }]),
    'destination.json': side([dateControl, { invoiceId: 'INV-1', postedAt: '2026-03-01T20:30:00Z' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'date-offset-missing').startsWith('ERROR'), true)
})

test('duplicate-key-in-destination prints ERROR, counts one error and exits 1', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }, { invoiceId: 'INV-1', amount: '11.00' }]),
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.duplicated, 1)
  assert.equal(lineFor(result.stderr, 'duplicate-key-in-destination').startsWith('ERROR'), true)
})

test('duplicate-key-in-source prints ERROR, counts one error and exits 1', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }, { invoiceId: 'INV-1', amount: '11.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.matched, 0)
  assert.equal(lineFor(result.stderr, 'duplicate-key-in-source').startsWith('ERROR'), true)
})

test('field-evidence-missing prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([amountControl, { invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([amountControl, { invoiceId: 'INV-1' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'field-evidence-missing').startsWith('ERROR'), true)
})

test('field-value-conflict prints ERROR, counts one error and exits 1', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '11.00' }]),
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.conflicting, 1)
  assert.equal(lineFor(result.stderr, 'field-value-conflict').startsWith('ERROR'), true)
})

test('field-value-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': stringPlan,
    'source.json': side([stringControl, { invoiceId: 'INV-1', status: 5 }]),
    'destination.json': side([stringControl, { invoiceId: 'INV-1', status: 'ok' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'field-value-invalid').startsWith('ERROR'), true)
})

test('field-value-too-long prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': stringPlan,
    'source.json': side([stringControl, { invoiceId: 'INV-1', status: 'abcdefghij' }]),
    'destination.json': side([stringControl, { invoiceId: 'INV-1', status: 'ok' }]),
  }, ['--max-field-length', '4'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'field-value-too-long').startsWith('ERROR'), true)
})

test('identifier-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([amountControl, { invoiceId: `INV${String.fromCharCode(0x0a)}1`, amount: '10.00' }]),
    'destination.json': side([amountControl]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'identifier-invalid').startsWith('ERROR'), true)
})

test('input-not-json prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': 'this is not JSON',
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'input-not-json').startsWith('ERROR'), true)
})

test('input-not-utf8 prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': new Uint8Array([0x7b, 0xff, 0x7d]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'input-not-utf8').startsWith('ERROR'), true)
})

test('input-too-large prints ERROR and counts one error', async () => {
  const many = []
  for (let index = 0; index < 60; index += 1) many.push({ invoiceId: `INV-${index}`, amount: '10.00' })
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side(many),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  }, ['--max-file-bytes', '2000'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'input-too-large').startsWith('ERROR'), true)
})

test('input-unreadable prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'input-unreadable').startsWith('ERROR'), true)
})

test('no-fields-declared prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': { schemaVersion: '1', key: ['invoiceId'], fields: [] },
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'no-fields-declared').startsWith('ERROR'), true)
})

test('no-records-evaluated prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([]),
    'destination.json': side([]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.checked, 0)
  assert.equal(lineFor(result.stderr, 'no-records-evaluated').startsWith('ERROR'), true)
})

test('path-escapes-root prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  }, [], { 'source.json': '/etc/hosts' })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'path-escapes-root').startsWith('ERROR'), true)
})

test('plan-field-duplicate prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': {
      schemaVersion: '1',
      key: ['invoiceId'],
      fields: [{ name: 'amount', type: 'amount', precision: 2 }, { name: 'amount', type: 'amount', precision: 2 }],
    },
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'plan-field-duplicate').startsWith('ERROR'), true)
})

test('plan-field-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': {
      schemaVersion: '1',
      key: ['invoiceId'],
      fields: [{ name: 'amount', type: 'amount', precision: 2, timezone: 'Z' }],
    },
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'plan-field-invalid').startsWith('ERROR'), true)
})

test('plan-granularity-unsupported prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': {
      schemaVersion: '1',
      key: ['invoiceId'],
      fields: [{ name: 'postedAt', type: 'date', timezone: 'Z', granularity: 'week' }],
    },
    'source.json': side([{ invoiceId: 'INV-1', postedAt: '2026-03-01T00:00:00Z' }]),
    'destination.json': side([{ invoiceId: 'INV-1', postedAt: '2026-03-01T00:00:00Z' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'plan-granularity-unsupported').startsWith('ERROR'), true)
})

test('plan-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': { schemaVersion: '2', key: ['invoiceId'], fields: [{ name: 'amount', type: 'amount', precision: 2 }] },
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'plan-invalid').startsWith('ERROR'), true)
})

test('plan-key-unknown prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': { schemaVersion: '1', key: ['invoiceId'], keys: ['invoiceId'], fields: [{ name: 'amount', type: 'amount', precision: 2 }] },
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'plan-key-unknown').startsWith('ERROR'), true)
})

test('plan-timezone-unsupported prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': {
      schemaVersion: '1',
      key: ['invoiceId'],
      fields: [{ name: 'postedAt', type: 'date', timezone: 'Asia/Kolkata', granularity: 'day' }],
    },
    'source.json': side([{ invoiceId: 'INV-1', postedAt: '2026-03-01T00:00:00Z' }]),
    'destination.json': side([{ invoiceId: 'INV-1', postedAt: '2026-03-01T00:00:00Z' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'plan-timezone-unsupported').startsWith('ERROR'), true)
})

test('plan-type-unsupported prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': { schemaVersion: '1', key: ['invoiceId'], fields: [{ name: 'amount', type: 'money' }] },
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'plan-type-unsupported').startsWith('ERROR'), true)
})

test('record-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([amountControl, 5]),
    'destination.json': side([amountControl]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'record-invalid').startsWith('ERROR'), true)
})

test('record-key-missing prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([amountControl, { amount: '10.00' }]),
    'destination.json': side([amountControl]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'record-key-missing').startsWith('ERROR'), true)
})

test('record-missing-in-destination prints ERROR, counts one error and exits 1', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
    'destination.json': side([]),
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.missingInDestination, 1)
  assert.equal(lineFor(result.stderr, 'record-missing-in-destination').startsWith('ERROR'), true)
})

test('record-missing-in-source prints ERROR, counts one error and exits 1', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.missingInSource, 1)
  assert.equal(lineFor(result.stderr, 'record-missing-in-source').startsWith('ERROR'), true)
})

test('records-invalid prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': { schemaVersion: '1', records: [{ invoiceId: 'INV-1', amount: '10.00' }], rows: [] },
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'records-invalid').startsWith('ERROR'), true)
})

test('too-many-fields prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': {
      schemaVersion: '1',
      key: ['invoiceId'],
      fields: [{ name: 'amount', type: 'amount', precision: 2 }, { name: 'status', type: 'string' }],
    },
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00', status: 'ok' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00', status: 'ok' }]),
  }, ['--max-fields', '1'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'too-many-fields').startsWith('ERROR'), true)
})

test('too-many-findings prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([
      { invoiceId: 'INV-1', amount: '10.00' },
      { invoiceId: 'INV-2', amount: '10.00' },
      { invoiceId: 'INV-3', amount: '10.00' },
    ]),
    'destination.json': side([]),
  }, ['--max-findings', '1'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.findings.length, 1)
  assert.equal(lineFor(result.stderr, 'too-many-findings').startsWith('ERROR'), true)
})

test('too-many-key-fields prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': { schemaVersion: '1', key: ['invoiceId', 'line'], fields: [{ name: 'amount', type: 'amount', precision: 2 }] },
    'source.json': side([{ invoiceId: 'INV-1', line: '1', amount: '10.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', line: '1', amount: '10.00' }]),
  }, ['--max-key-fields', '1'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'too-many-key-fields').startsWith('ERROR'), true)
})

test('too-many-keys prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }, { invoiceId: 'INV-2', amount: '20.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }, { invoiceId: 'INV-2', amount: '20.00' }]),
  }, ['--max-keys', '1'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.unevaluated, 1)
  assert.equal(lineFor(result.stderr, 'too-many-keys').startsWith('ERROR'), true)
})

test('too-many-records prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }, { invoiceId: 'INV-2', amount: '20.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  }, ['--max-records', '1'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result.stderr, 'too-many-records').startsWith('ERROR'), true)
})

test('too-many-records-for-key prints ERROR and counts two errors with the duplication', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }, { invoiceId: 'INV-1', amount: '11.00' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  }, ['--max-records-per-key', '1'])
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 2)
  assert.equal(lineFor(result.stderr, 'too-many-records-for-key').startsWith('ERROR'), true)
  assert.equal(lineFor(result.stderr, 'duplicate-key-in-source').startsWith('ERROR'), true)
})

test('inputs-are-one-file prints ERROR and counts one error', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  }, [], {}, { 'destination.json': 'source.json' })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.checked, 0)
  assert.equal(lineFor(result.stderr, 'inputs-are-one-file').startsWith('ERROR'), true)
})

test('key-case-collision prints WARNING, counts one warning, no errors, and exits 0', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-a', amount: '10.00' }, { invoiceId: 'inv-a', amount: '20.00' }]),
    'destination.json': side([{ invoiceId: 'INV-a', amount: '10.00' }, { invoiceId: 'inv-a', amount: '20.00' }]),
  })
  assert.equal(result.report.status, 'pass')
  assert.equal(result.code, 0)
  assert.equal(result.report.summary.errors, 0)
  assert.equal(result.report.summary.warnings, 1)
  assert.equal(lineFor(result.stderr, 'key-case-collision').startsWith('WARNING'), true)
})

test('duplicate-values-identical prints INFO and adds no error of its own', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.00' }, { invoiceId: 'INV-1', amount: '10.0' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result.stderr, 'duplicate-values-identical').startsWith('INFO'), true)
})

test('field-match-after-normalization prints INFO, counts nothing, and exits 0', async () => {
  const result = await audit({
    'reconciliation.json': amountPlan,
    'source.json': side([{ invoiceId: 'INV-1', amount: '10.0' }]),
    'destination.json': side([{ invoiceId: 'INV-1', amount: '10.00' }]),
  })
  assert.equal(result.report.status, 'pass')
  assert.equal(result.code, 0)
  assert.equal(result.report.summary.errors, 0)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(result.report.summary.matched, 1)
  assert.equal(lineFor(result.stderr, 'field-match-after-normalization').startsWith('INFO'), true)
})
