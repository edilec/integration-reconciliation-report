import assert from 'node:assert/strict'
import test from 'node:test'

import { AMOUNT, cliRun, fixture, planOf, row, sideOf, withRoot } from './support.mjs'

/** The command line: streams, exit codes, and every way a flag can be wrong. */

const CLEAN = fixture([row({ invoiceId: 'INV-1' })], [row({ invoiceId: 'INV-1' })])

test('--help and --version go to stdout and exit 0', async () => {
  for (const flag of ['--help', '-h']) {
    const run = await cliRun([flag])
    assert.equal(run.code, 0)
    assert.equal(run.stdout.startsWith('integration-reconciliation-report'), true)
    assert.equal(run.stdout.includes('--max-records-per-key'), true)
    assert.equal(run.stderr, '')
  }
  for (const flag of ['--version', '-v']) {
    const run = await cliRun([flag])
    assert.equal(run.code, 0)
    assert.equal(run.stdout.trim(), '0.1.0')
  }
})

test('the help text documents every flag the parser accepts', async () => {
  const { stdout } = await cliRun(['--help'])
  for (const flag of [
    '--root', '--plan', '--source', '--destination', '--json',
    '--max-file-bytes', '--max-records', '--max-keys', '--max-records-per-key',
    '--max-fields', '--max-key-fields', '--max-field-length', '--max-findings',
  ]) {
    assert.equal(stdout.includes(flag), true, `${flag} is not documented`)
  }
})

test('stdout carries the JSON report and nothing else', async () => {
  await withRoot(CLEAN, async (root) => {
    const run = await cliRun(['--root', root])
    assert.equal(run.code, 0)
    const report = JSON.parse(run.stdout)
    assert.equal(report.tool, 'integration-reconciliation-report')
    assert.equal(report.schemaVersion, '1')
    assert.equal(run.stdout.endsWith('}\n'), true)
    assert.equal(run.stderr.length > 0, true, 'a non-empty stderr is correct, not a failure')
    assert.equal(run.stderr.includes('{'), false, 'no part of the report leaks to stderr')
  })
})

test('--json suppresses the human summary and nothing else', async () => {
  await withRoot(CLEAN, async (root) => {
    const plain = await cliRun(['--root', root])
    const quiet = await cliRun(['--root', root, '--json'])
    assert.equal(plain.stdout, quiet.stdout)
    assert.equal(quiet.stderr, '')
    assert.equal(plain.stderr.includes('status pass'), true)
  })
})

test('--plan, --source and --destination are honoured', async () => {
  const files = {
    'plan.json': planOf([AMOUNT]),
    'left.json': sideOf([row({ invoiceId: 'INV-1' })]),
    'right.json': sideOf([row({ invoiceId: 'INV-1' })]),
  }
  await withRoot(files, async (root) => {
    const run = await cliRun(['--root', root, '--plan', 'plan.json', '--source', 'left.json', '--destination', 'right.json', '--json'])
    assert.equal(run.code, 0)
    assert.equal(JSON.parse(run.stdout).summary.matched, 1)

    const stderrRun = await cliRun(['--root', root, '--plan', 'plan.json', '--source', 'left.json', '--destination', 'right.json'])
    assert.equal(stderrRun.stderr.includes('plan plan.json'), true)
    assert.equal(stderrRun.stderr.includes('source left.json'), true)
    assert.equal(stderrRun.stderr.includes('destination right.json'), true)
  })
})

test('a configuration error leaves stdout empty and exits 2', async () => {
  for (const args of [[], ['--root'], ['--root', '.', '--nope'], ['--root', '.', '--source']]) {
    const run = await cliRun(args)
    assert.equal(run.code, 2, JSON.stringify(args))
    assert.equal(run.stdout, '', JSON.stringify(args))
    assert.equal(run.stderr.length > 0, true)
  }
})

test('a value-carrying flag given twice is refused rather than silently last-wins', async () => {
  await withRoot(CLEAN, async (root) => {
    const run = await cliRun(['--root', root, '--source', 'a.json', '--source', 'source.json'])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr.startsWith('--source was given more than once'), true)

    const limit = await cliRun(['--root', root, '--max-records', '5', '--max-records', '50000'])
    assert.equal(limit.code, 2)
    assert.equal(limit.stdout, '')
  })
})

test('--json may repeat, because it carries no value to lose', async () => {
  await withRoot(CLEAN, async (root) => {
    const run = await cliRun(['--root', root, '--json', '--json'])
    assert.equal(run.code, 0)
    assert.equal(run.stderr, '')
  })
})

test('an incomplete run says so on stderr as well as in the report', async () => {
  const files = fixture([row({ invoiceId: 'INV-0', amount: '1.00' }), { amount: '2.00' }], [row({ invoiceId: 'INV-0', amount: '1.00' })])
  await withRoot(files, async (root) => {
    const run = await cliRun(['--root', root])
    assert.equal(run.code, 2)
    assert.equal(JSON.parse(run.stdout).status, 'incomplete')
    assert.equal(run.stderr.includes('this run is not a pass.'), true)
  })
})

test('the three exit codes are reachable from the command line', async () => {
  await withRoot(CLEAN, async (root) => {
    assert.equal((await cliRun(['--root', root, '--json'])).code, 0)
  })
  await withRoot(fixture([row({ invoiceId: 'INV-1' })], []), async (root) => {
    assert.equal((await cliRun(['--root', root, '--json'])).code, 1)
  })
  await withRoot(fixture([], []), async (root) => {
    assert.equal((await cliRun(['--root', root, '--json'])).code, 2)
  })
})
