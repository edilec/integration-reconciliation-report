import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, projectDirectory, raisedRules } from './support.mjs'

/** The shipped examples, run as the README says to run them. */

const example = (name) => join(projectDirectory, 'examples', name)

async function run(name, extra = []) {
  const result = await cliRun(['--root', example(name), '--json', ...extra])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

test('examples/clean passes and exits 0, which is what npm run example checks', async () => {
  const result = await run('clean')
  assert.equal(result.code, 0)
  assert.equal(result.report.status, 'pass')
  assert.equal(result.report.summary.errors, 0)
  assert.equal(result.report.summary.matched, 3)
  assert.equal(result.report.summary.checked, 3)
  assert.deepEqual(raisedRules(result.report), ['field-match-after-normalization'])
})

test('examples/broken fails and exits 1, on four distinct kinds of break', async () => {
  const result = await run('broken')
  assert.equal(result.code, 1)
  assert.equal(result.report.status, 'fail')
  assert.deepEqual(raisedRules(result.report), [
    'amount-currency-conflict',
    'duplicate-key-in-source',
    'duplicate-values-identical',
    'field-value-conflict',
    'key-case-collision',
    'record-missing-in-destination',
    'record-missing-in-source',
  ])
  assert.equal(result.report.summary.matched, 1)
  assert.equal(result.report.summary.conflicting, 2)
  assert.equal(result.report.summary.duplicated, 1)
  assert.equal(result.report.summary.missingInDestination, 1)
  assert.equal(result.report.summary.missingInSource, 1)
})

test('examples/incomplete exits 2 and is never reported as a pass', async () => {
  const result = await run('incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.status, 'incomplete')
  assert.deepEqual(raisedRules(result.report), ['amount-not-exact', 'date-offset-missing', 'record-key-missing'])
  assert.equal(result.report.summary.unevaluated, 2)
  assert.equal(result.report.summary.checked, 1, 'one key was still decided, so the guard under test is the only one firing')
})

test('every example root holds exactly the three files the tool reads', async () => {
  for (const name of ['clean', 'broken', 'incomplete']) {
    const entries = (await readdir(example(name))).sort()
    assert.deepEqual(entries, ['destination.json', 'reconciliation.json', 'source.json'], name)
  }
})

test('no example carries anything that looks like a secret or a personal detail', async () => {
  const forbidden = /(password|secret|api[-_]?key|authorization|bearer |BEGIN [A-Z ]*PRIVATE KEY|@[a-z0-9-]+\.(com|net|org))/i
  for (const name of ['clean', 'broken', 'incomplete']) {
    for (const file of await readdir(example(name))) {
      const text = await readFile(join(example(name), file), 'utf8')
      assert.equal(forbidden.test(text), false, `${name}/${file}`)
    }
  }
})

test('running an example twice produces byte-identical stdout', async () => {
  for (const name of ['clean', 'broken', 'incomplete']) {
    const first = await run(name)
    const second = await run(name)
    assert.equal(first.stdout, second.stdout, name)
  }
})
