/**
 * The output destination this tool does not have.
 *
 * Ten tools in this catalog accepted an output destination that destroyed a
 * file they were never asked to touch, and four of them exited 0 saying the
 * write succeeded. The hole is in the destination, so a tool with no
 * destination cannot have it -- but "cannot" is a property of today's code,
 * and an unwritten property is one that stops being true without anyone
 * noticing. There is no `--out` here, nothing under `--root` is opened for
 * writing, and both halves are asserted below through the real binary.
 *
 * `--plan`, `--source` and `--destination` name *inputs*. `--destination` in
 * particular reads like an output and is not one: it is the second export, the
 * side the source is reconciled against. A test that confused the two would
 * be asserting nothing, so each is driven here as what it is.
 *
 * `test/guarantees.test.mjs` scans the sources for every write API. This file
 * is the behavioural half: it measures what a run does to the filesystem.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import { AMOUNT, CLI, cliRun, fixture, planOf, row, sideOf, withRoot } from './support.mjs'

/** Every file below `directory`, as a sorted list of `relative path -> bytes`. */
async function snapshot(directory) {
  const entries = []
  const walk = async (current) => {
    for (const name of (await readdir(current)).sort()) {
      const full = join(current, name)
      const info = await stat(full)
      if (info.isDirectory()) await walk(full)
      else entries.push([relative(directory, full), (await readFile(full)).toString('base64')])
    }
  }
  await walk(directory)
  return entries
}

const SAMPLE = () => fixture(
  [row({ invoiceId: 'INV-1' }), row({ invoiceId: 'INV-2', amount: '2.00' })],
  [row({ invoiceId: 'INV-1', amount: '9.00' })],
)

test('a run through the real binary leaves the root byte-identical and creates nothing', async () => {
  // The API-level version of this lives in test/confinement.test.mjs. The
  // binary is where an output destination would be added, so it is the binary
  // that has to be measured.
  await withRoot(SAMPLE(), async (root) => {
    const before = await snapshot(root)

    const { code } = await cliRun(['--root', root, '--json'])

    assert.equal(code, 1, 'the sample reconciles to a conflict, so the run really did do its work')
    assert.deepEqual(await snapshot(root), before)
  })
})

test('a run creates nothing beside the root either', async () => {
  // A destination composed from the root -- `${root}.json`, or a sibling
  // "reports" directory -- would leave the root itself byte-identical.
  const parent = await mkdtemp(join(tmpdir(), 'integration-reconciliation-report-parent-'))
  try {
    const root = join(parent, 'root')
    await mkdir(root)
    for (const [name, content] of Object.entries(SAMPLE())) {
      await writeFile(join(root, name), `${JSON.stringify(content, null, 2)}\n`)
    }
    const before = await snapshot(parent)

    const { code } = await cliRun(['--root', root, '--json'])

    assert.equal(code, 1)
    assert.deepEqual(await snapshot(parent), before)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('a passing run writes nothing either, and neither does an incomplete one', async () => {
  // The write could be on any exit path, so every exit path is measured.
  const clean = fixture([row({ invoiceId: 'INV-1' })], [row({ invoiceId: 'INV-1' })])
  await withRoot(clean, async (root) => {
    const before = await snapshot(root)
    const { code } = await cliRun(['--root', root, '--json'])
    assert.equal(code, 0)
    assert.deepEqual(await snapshot(root), before)
  })

  await withRoot({ 'reconciliation.json': planOf([AMOUNT]), 'source.json': sideOf([row()]) }, async (root) => {
    const before = await snapshot(root)
    const { code } = await cliRun(['--root', root, '--json'])
    assert.equal(code, 2, 'the missing destination export makes this incomplete')
    assert.deepEqual(await snapshot(root), before)
  })
})

test('the CLI offers no output destination, under any of the names one would have', async () => {
  await withRoot(SAMPLE(), async (root) => {
    for (const flag of ['--out', '--output', '--report', '--write', '--bundle', '--out-root', '--overwrite']) {
      const result = await cliRun(['--root', root, flag, join(root, 'report.json')])
      assert.equal(result.code, 2, `${flag} was accepted`)
      assert.equal(result.stdout, '', `${flag} put something on stdout`)
      assert.match(result.stderr.split('\n')[0], /Unknown option/, `${flag} was not refused as unknown`)
    }
    assert.deepEqual((await readdir(root)).sort(), ['destination.json', 'reconciliation.json', 'source.json'])
  })
})

test('--destination names the second export to read, not a place to write', async () => {
  // The one flag whose name could be mistaken for an output. Pointing it at a
  // file that does not exist must report that input as unreadable -- never
  // create it.
  await withRoot(SAMPLE(), async (root) => {
    const absent = join(root, 'not-here.json')

    const result = await cliRun(['--root', root, '--json', '--destination', 'not-here.json'])

    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((finding) => finding.location.file === 'not-here.json'), true)
    await assert.rejects(() => stat(absent), 'the named file was created rather than reported missing')
  })
})

test('the binary imports nothing from node:fs at all', async () => {
  // src/index.mjs imports readFile, realpath and stat. The binary imports
  // nothing: it has no reason to touch the filesystem, and the shortest way to
  // keep it that way is to notice when it starts.
  const source = await readFile(CLI, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  assert.equal(/from 'node:fs(?:\/promises)?'/.test(code), false, 'the binary now imports from node:fs')
  assert.equal(code.includes('writeFile'), false)
})
