/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees in this package can only be pinned by the second -- an
 * exit code cannot be satisfied by editing a table.
 *
 * `test/severity-word.test.mjs` deliberately imports none of this: it builds
 * its own inputs and writes every expectation inline, so that no shared
 * builder can carry an expectation into it.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { reconcileExports } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/integration-reconciliation-report.mjs')

/** A compared amount field at two decimal places. */
export const AMOUNT = Object.freeze({ name: 'amount', type: 'amount', precision: 2 })

/** A compared date field, bucketed by calendar day in India Standard Time. */
export const POSTED_AT = Object.freeze({ name: 'postedAt', type: 'date', timezone: '+05:30', granularity: 'day' })

/** A compared status field, trimmed and case-folded. */
export const STATUS = Object.freeze({ name: 'status', type: 'string', trim: true, caseSensitive: false })

export const planOf = (fields, key = ['invoiceId']) => ({ schemaVersion: '1', key, fields })
export const sideOf = (records) => ({ schemaVersion: '1', records })

/** One exported row. Override anything; `undefined` removes a property. */
export function row(overrides = {}) {
  const result = { invoiceId: 'INV-1', amount: '10.00', ...overrides }
  for (const [key, value] of Object.entries(result)) if (value === undefined) delete result[key]
  return result
}

/** The three input files of a run, as objects. */
export const fixture = (source, destination, fields = [AMOUNT], key = ['invoiceId']) => ({
  'reconciliation.json': planOf(fields, key),
  'source.json': sideOf(source),
  'destination.json': sideOf(destination),
})

/**
 * Create a temporary root, write the named files into it, run `body(root)`,
 * and remove the tree afterwards whatever happened.
 *
 * A string is written verbatim and a `Uint8Array` byte for byte, so a test can
 * plant text that is not JSON, or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'integration-reconciliation-report-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => reconcileExports({ root, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams, never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and ordered by code unit. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLM': String.fromCharCode(0x200f),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})
