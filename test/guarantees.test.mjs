import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, exitCodeFor, serializeReport } from '../src/index.mjs'
import { AMOUNT, apiReport, cliReport, fixture, planOf, projectDirectory, row, sideOf } from './support.mjs'

/**
 * Package-level guarantees.
 *
 * The source scans below are **supplementary**. A scan for `.localeCompare(`
 * is emphatically not a determinism test -- `Intl.Collator` collates
 * identically and spells differently -- and the real pin is
 * `test/ordering.test.mjs`, which asserts the emitted order at every site for
 * inputs the two comparators disagree about. What these scans are for is the
 * thing a behavioural test cannot see: a dependency creeping into the
 * manifest, a socket module being imported, or a write call appearing in a
 * read-only tool.
 */

/**
 * The sources with their comments removed, so a scan reads code and not prose.
 * Several of these modules explain in a comment exactly which construct they
 * refuse to use, and a scan that could not tell the explanation from the thing
 * would make those comments unwritable.
 */
async function sourceFiles() {
  const files = []
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      const text = await readFile(join(projectDirectory, directory, name), 'utf8')
      const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
      files.push([`${directory}/${name}`, code])
    }
  }
  assert.equal(files.length >= 7, true, 'the scan actually found the sources')
  return files
}

test('the package declares no dependency of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
    assert.equal(Object.hasOwn(manifest, field), false, `package.json declares ${field}`)
  }
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(manifest.author, 'Edilec Private Limited')
  assert.equal(manifest.scripts.check, 'npm run lint && npm test && npm run example && npm run pack:check')
})

test('every import is a node builtin or a relative file in this package', async () => {
  for (const [name, text] of await sourceFiles()) {
    for (const match of text.matchAll(/^import [^']*'([^']+)'/gm)) {
      const specifier = match[1]
      assert.equal(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        true,
        `${name} imports ${specifier}`,
      )
    }
  }
})

test('no socket, clock, random source or locale-aware comparison appears in the sources', async () => {
  const refused = [
    'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
    'fetch(', 'XMLHttpRequest', 'Math.random', 'Date.now', 'new Date(', 'process.env',
    'localeCompare', 'Intl.', 'toLocaleLowerCase', 'toLocaleUpperCase',
  ]
  for (const [name, text] of await sourceFiles()) {
    for (const needle of refused) {
      assert.equal(text.includes(needle), false, `${name} mentions ${needle}`)
    }
  }
})

test('nothing in the sources writes to the filesystem', async () => {
  const refused = ['writeFile(', 'appendFile(', 'unlink(', 'rename(', 'rmdir(', 'mkdir(', 'createWriteStream(', 'truncate(', 'chmod(', 'writeFileSync', 'openSync']
  for (const [name, text] of await sourceFiles()) {
    for (const needle of refused) {
      assert.equal(text.includes(needle), false, `${name} mentions ${needle}`)
    }
  }
})

test('the report matches the envelope the contract specifies', async () => {
  const report = await apiReport(fixture(
    [row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-2', amount: '2.00' })],
    [row({ invoiceId: 'INV-1', amount: '9.00' })],
  ))
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
  assert.equal(['pass', 'fail', 'incomplete'].includes(report.status), true)
  for (const value of Object.values(report.summary)) assert.equal(Number.isInteger(value), true)

  for (const finding of report.findings) {
    assert.equal(typeof finding.ruleId, 'string')
    assert.equal(['error', 'warning', 'info'].includes(finding.severity), true)
    assert.equal(finding.severity, RULE_SEVERITY[finding.ruleId])
    assert.equal(typeof finding.message, 'string')
    assert.equal(finding.message.length > 0, true)
    assert.equal(isAbsolute(finding.location.file), false, 'location.file is relative to the declared root')
    assert.equal(['destination.json', 'reconciliation.json', 'source.json'].includes(finding.location.file), true)
    assert.equal(finding.location.pointer === '' || finding.location.pointer.startsWith('/'), true)
    for (const key of Object.keys(finding)) {
      assert.equal(['ruleId', 'severity', 'message', 'location', 'evidence', 'suggestion'].includes(key), true, key)
    }
  }
  assert.equal(serializeReport(report), JSON.stringify(JSON.parse(serializeReport(report)), null, 2))
})

test('the exit code follows the status and nothing else', () => {
  assert.equal(exitCodeFor({ status: 'pass' }), 0)
  assert.equal(exitCodeFor({ status: 'fail' }), 1)
  assert.equal(exitCodeFor({ status: 'incomplete' }), 2)
})

test('a report is never a pass with nothing checked', async () => {
  const empty = await cliReport(fixture([], []))
  assert.notEqual(empty.report.status, 'pass')
  assert.equal(empty.report.summary.checked, 0)
  assert.equal(empty.code, 2)
})

test('no host path from the machine the tool ran on reaches the report', async () => {
  const result = await cliReport(fixture([row({ invoiceId: 'INV-1' })], []))
  assert.equal(result.stdout.includes(projectDirectory), false)
  assert.equal(/"file": "\//.test(result.stdout), false)
})

/**
 * The emitted order, written out.
 *
 * Asserting `compareFindings(findings[i - 1], findings[i]) <= 0` over findings
 * that `buildReport` sorted with `compareFindings` is self-referential: it
 * holds for any comparator at all, including a reversed one, so it can only
 * detect the removal of the `.sort()` call. The sequence below is a literal,
 * and the fixture is built so that none of the three sort components agrees
 * with the order the findings were produced in:
 *
 * - the walk visits INV-1, INV-2, INV-3, so the destination finding is created
 *   **last** and sorts **first** -- `destination.json` before `source.json`;
 * - within `source.json` the duplicate at `/records/1` is created before the
 *   missing record at `/records/0`, and sorts after it;
 * - the two findings that share a file *and* a pointer are separated by rule
 *   id alone.
 *
 * `test/ordering.test.mjs` pins the same comparator at its call site with
 * values a collator orders the other way round. This one pins the documented
 * key -- file, then pointer, then rule id -- as a sequence a reader can check.
 */
test('the emitted order is the documented sort key, as an exact sequence', async () => {
  const report = await apiReport({
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': sideOf([row({ invoiceId: 'INV-2' }), row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-1' })]),
    'destination.json': sideOf([row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-3' })]),
  })

  assert.deepEqual(
    report.findings.map((finding) => `${finding.location.file}${finding.location.pointer} ${finding.ruleId}`),
    [
      'destination.json/records/1 record-missing-in-source',
      'source.json/records/0 record-missing-in-destination',
      'source.json/records/1 duplicate-key-in-source',
      'source.json/records/1 duplicate-values-identical',
    ],
  )
})
