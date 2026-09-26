import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { reconcileExports } from '../src/index.mjs'
import { AMOUNT, cliRun, findingsFor, planOf, raisedRules, row, sideOf } from './support.mjs'

/**
 * Path confinement, and the two ways it is usually got wrong.
 *
 * Refusing `..` and absolute paths is not confinement: a symbolic link planted
 * inside the root points anywhere and contains no `..` at all. And comparing a
 * real root against an unresolved target is not confinement either -- it is a
 * false refusal, which refuses legitimate files whenever the root is reached
 * through a link, and a `/var` that is really `/private/var` is enough.
 *
 * A third failure has no path at all: a **hard link** is two names for one
 * inode, so two distinct real paths can be one file, and reconciling a file
 * against itself matches everything. That is caught by device and inode, not
 * by path.
 */

const PLAN = `${JSON.stringify(planOf([AMOUNT]))}\n`
const SIDE = `${JSON.stringify(sideOf([row({ invoiceId: 'INV-1' })]))}\n`

async function inRoot(body) {
  const outside = await mkdtemp(join(tmpdir(), 'integration-reconciliation-report-outside-'))
  const root = await mkdtemp(join(tmpdir(), 'integration-reconciliation-report-root-'))
  try {
    return await body(root, outside)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

test('a symbolic link out of the root is refused unread', async () => {
  await inRoot(async (root, outside) => {
    await writeFile(join(outside, 'elsewhere.json'), SIDE)
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'destination.json'), SIDE)
    await symlink(join(outside, 'elsewhere.json'), join(root, 'source.json'))

    const report = await reconcileExports({ root })
    assert.deepEqual(raisedRules(report), ['path-escapes-root'])
    assert.equal(report.status, 'incomplete')
    assert.equal(findingsFor(report, 'path-escapes-root')[0].location.file, 'source.json')
  })
})

test('a symbolic link that stays inside the root is followed', async () => {
  await inRoot(async (root) => {
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'destination.json'), SIDE)
    await writeFile(join(root, 'actual.json'), SIDE)
    await symlink(join(root, 'actual.json'), join(root, 'source.json'))

    const report = await reconcileExports({ root })
    assert.deepEqual(raisedRules(report), [])
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.matched, 1)
  })
})

test('a root reached through a symbolic link is not falsely refused', async () => {
  await inRoot(async (root, outside) => {
    const real = join(root, 'real')
    await mkdir(real)
    await writeFile(join(real, 'reconciliation.json'), PLAN)
    await writeFile(join(real, 'source.json'), SIDE)
    await writeFile(join(real, 'destination.json'), SIDE)
    const linked = join(outside, 'linked-root')
    await symlink(real, linked)

    const report = await reconcileExports({ root: linked })
    assert.deepEqual(raisedRules(report), [], 'comparing a real root against an unresolved target would refuse these')
    assert.equal(report.status, 'pass')
  })
})

test('a symlinked directory inside the root is followed, and one pointing out is not', async () => {
  await inRoot(async (root, outside) => {
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'destination.json'), SIDE)
    const inside = join(root, 'exports')
    await mkdir(inside)
    await writeFile(join(inside, 'source.json'), SIDE)
    await symlink(inside, join(root, 'near'))
    await symlink(outside, join(root, 'far'))

    const near = await reconcileExports({ root, source: 'near/source.json' })
    assert.deepEqual(raisedRules(near), [])
    assert.equal(near.status, 'pass')

    const far = await reconcileExports({ root, source: 'far/source.json' })
    assert.deepEqual(raisedRules(far), ['path-escapes-root'], 'the missing file would have been read from outside the root')
    assert.equal(far.status, 'incomplete')
  })
})

test('a link that resolves nowhere is unreadable rather than escaping', async () => {
  await inRoot(async (root) => {
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'destination.json'), SIDE)
    await symlink(join(root, 'missing.json'), join(root, 'source.json'))

    const report = await reconcileExports({ root })
    assert.deepEqual(raisedRules(report), ['input-unreadable'])
    assert.equal(report.status, 'incomplete')
  })
})

test('two hard links to one file are one file, which no path comparison can tell', async () => {
  await inRoot(async (root) => {
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'source.json'), SIDE)
    await link(join(root, 'source.json'), join(root, 'destination.json'))

    const report = await reconcileExports({ root })
    assert.deepEqual(raisedRules(report), ['inputs-are-one-file'])
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.matched, 0, 'a file joined against itself would have matched every key')
    assert.equal(report.summary.checked, 0)
  })
})

test('a symbolic link between the two exports is caught as well', async () => {
  await inRoot(async (root) => {
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'source.json'), SIDE)
    await symlink(join(root, 'source.json'), join(root, 'destination.json'))

    const report = await reconcileExports({ root })
    assert.deepEqual(raisedRules(report), ['inputs-are-one-file'])
    assert.equal(report.summary.matched, 0)
  })
})

test('a directory named as an input is not a regular file', async () => {
  await inRoot(async (root) => {
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'destination.json'), SIDE)
    await mkdir(join(root, 'source.json'))

    const report = await reconcileExports({ root })
    assert.deepEqual(raisedRules(report), ['input-unreadable'])
    assert.equal(report.status, 'incomplete')
  })
})

test('a name that steps outside the root is a configuration error with an empty stdout', async () => {
  await inRoot(async (root) => {
    await writeFile(join(root, 'reconciliation.json'), PLAN)
    await writeFile(join(root, 'source.json'), SIDE)
    await writeFile(join(root, 'destination.json'), SIDE)

    for (const bad of ['../source.json', '/etc/hosts', 'a/../../b.json']) {
      const run = await cliRun(['--root', root, '--source', bad])
      assert.equal(run.code, 2, bad)
      assert.equal(run.stdout, '', 'a configuration error never had a subject to report on')
    }
    const controlled = String.fromCharCode(0x0a)
    await assert.rejects(() => reconcileExports({ root, source: `source${controlled}.json` }), /control, separator or bidi/)
    await assert.rejects(() => reconcileExports({ root, source: '' }), /must be a relative file name/)
  })
})

test('naming one file twice is a configuration error, before anything is read', async () => {
  await inRoot(async (root) => {
    await assert.rejects(
      () => reconcileExports({ root, source: 'a.json', destination: 'a.json' }),
      /must name different files/,
    )
    await assert.rejects(
      () => reconcileExports({ root, plan: 'source.json' }),
      /must name a file that is not one of the two exports/,
    )
  })
})

test('a root that is not a directory, or does not exist, is a configuration error', async () => {
  await inRoot(async (root) => {
    await writeFile(join(root, 'a-file'), 'x')
    await assert.rejects(() => reconcileExports({ root: join(root, 'a-file') }), /must be a directory/)
    await assert.rejects(() => reconcileExports({ root: join(root, 'nope') }), /could not be resolved/)
    await assert.rejects(() => reconcileExports({ root: 42 }), /root must be a non-empty string/)
  })
})

test('a run leaves its root byte-identical', async () => {
  await inRoot(async (root) => {
    const before = { 'reconciliation.json': PLAN, 'source.json': SIDE, 'destination.json': SIDE }
    for (const [name, content] of Object.entries(before)) await writeFile(join(root, name), content)
    await reconcileExports({ root })

    const { readdir, readFile } = await import('node:fs/promises')
    assert.deepEqual((await readdir(root)).sort(), ['destination.json', 'reconciliation.json', 'source.json'])
    for (const [name, content] of Object.entries(before)) {
      assert.equal(await readFile(join(root, name), 'utf8'), content, `${name} changed`)
    }
  })
})
