/**
 * integration-reconciliation-report -- join two exported sides by a declared
 * stable key, compare declared fields under declared normalisation, and report
 * matched, missing, duplicated and conflicting records.
 *
 * The tool opens no socket and calls no provider. Two exported files and a
 * plan are the whole of the evidence, and the report says exactly which keys
 * it could not decide and why.
 *
 * Two promises are worth stating here because both are usually broken:
 *
 * 1. **A duplicated key never overwrites itself.** Records are grouped, not
 *    indexed into a last-write-wins map, so two rows sharing a key produce a
 *    reported duplication rather than a clean-looking match over whichever row
 *    happened to be read last.
 * 2. **Nothing is rounded and no float is compared.** Amounts are compared as
 *    integer minor units at a declared precision, timestamps at a declared
 *    fixed offset and granularity. A value that does not fit the declaration
 *    is reported as unevaluated, never quietly made to fit.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'

import { compilePlan } from './plan.mjs'
import { compileRecords } from './records.mjs'
import { reconcileSides } from './reconcile.mjs'
import { byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject } from './text.mjs'

export const TOOL_ID = 'integration-reconciliation-report'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_PLAN_NAME = 'reconciliation.json'
export const DEFAULT_SOURCE_NAME = 'source.json'
export const DEFAULT_DESTINATION_NAME = 'destination.json'

/**
 * Limits, each enforced and each reported by name when it is hit.
 *
 * Exceeding one is never a silent truncation: it produces a finding naming the
 * limit and marks the run `incomplete`, because a partial join is not evidence
 * that the part nobody joined was fine.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFieldLength: 1024,
  maxFields: 50,
  maxFileBytes: 5242880,
  maxFindings: 1000,
  maxKeyFields: 8,
  maxKeys: 20000,
  maxRecords: 20000,
  maxRecordsPerKey: 100,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxFieldLength: 65536,
  maxFields: 500,
  maxFileBytes: 67108864,
  maxFindings: 20000,
  maxKeyFields: 32,
  maxKeys: 500000,
  maxRecords: 500000,
  maxRecordsPerKey: 10000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at eighty construction sites it drifts
 * silently, and demoting `field-value-conflict` or `duplicate-key-in-source`
 * to a warning turns a ledger that does not balance into a green build with
 * every test still passing. Every finding takes its severity from here, and an
 * unknown rule id throws.
 *
 * `test/severity-table.test.mjs` asserts this table against the documented
 * catalog in both directions. That is worth having and it is **not** the test:
 * a table, a catalog and a hand-written expected map are three declarations,
 * and one edit that changes all three satisfies every assertion comparing
 * them. `test/severity-behaviour.test.mjs` and `test/severity-word.test.mjs`
 * pin the observable consequence instead -- the process exit code, the error
 * count and the printed severity word -- and share no map with anything.
 */
export const RULE_SEVERITY = Object.freeze({
  'amount-currency-conflict': 'error',
  'amount-exceeds-declared-precision': 'error',
  'amount-invalid': 'error',
  'amount-not-exact': 'error',
  'date-invalid': 'error',
  'date-offset-missing': 'error',
  'duplicate-key-in-destination': 'error',
  'duplicate-key-in-source': 'error',
  'duplicate-values-identical': 'info',
  'field-evidence-missing': 'error',
  'field-match-after-normalization': 'info',
  'field-value-conflict': 'error',
  'field-value-invalid': 'error',
  'field-value-too-long': 'error',
  'identifier-invalid': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'key-case-collision': 'warning',
  'no-fields-declared': 'error',
  'no-records-evaluated': 'error',
  'path-escapes-root': 'error',
  'plan-field-duplicate': 'error',
  'plan-field-invalid': 'error',
  'plan-granularity-unsupported': 'error',
  'plan-invalid': 'error',
  'plan-key-unknown': 'error',
  'plan-timezone-unsupported': 'error',
  'plan-type-unsupported': 'error',
  'record-invalid': 'error',
  'record-key-missing': 'error',
  'record-missing-in-destination': 'error',
  'record-missing-in-source': 'error',
  'records-invalid': 'error',
  'too-many-fields': 'error',
  'too-many-findings': 'error',
  'too-many-key-fields': 'error',
  'too-many-keys': 'error',
  'too-many-records': 'error',
  'too-many-records-for-key': 'error',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['destination', 'limits', 'plan', 'root', 'source'])

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A documented limit that a
 * typo silently disables is a limit that is not enforced, and the CLI turns
 * this throw into a configuration error with an empty stdout. Which unknown
 * key is named first is decided by code unit, so the diagnostic is the same on
 * every host.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(
        `Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against a path
 * that has not been resolved refuses legitimate files whenever the root is
 * reached through a symbolic link -- a `/var` that is really `/private/var` is
 * enough -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered, because naming a file outside the declared root is a usage error
 * rather than a fact about the subject. This is emphatically *not* the
 * confinement: a symbolic link planted inside the root passes every check in
 * this function, and `resolveInput` is what catches it by resolving the real
 * path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  const parts = normalize(name).split(/[\\/]/)
  if (parts.includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * sanitised evidence carefully and left identifiers raw, so a record id
 * holding a newline forged an extra line in the human report; here the join
 * key reaches the message, the pointer and the evidence, so all three go
 * through the same filter.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/reconciliation-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/** Documented sort key: location.file, location.pointer, ruleId, message, evidence. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file) ||
    byCodeUnit(a.location.pointer, b.location.pointer) ||
    byCodeUnit(a.ruleId, b.ruleId) ||
    byCodeUnit(a.message, b.message) ||
    byCodeUnit(a.evidence ?? '', b.evidence ?? '')
  )
}

function emptyState() {
  return {
    keys: 0,
    checked: 0,
    matched: 0,
    conflicting: 0,
    duplicated: 0,
    missingInDestination: 0,
    missingInSource: 0,
    unevaluated: 0,
    incomplete: false,
  }
}

function buildReport(sink, state, counts, limits) {
  // Ordering site: the documented order of the whole report.
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: counts.planName,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or reconcile a narrower slice of the export.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      fields: counts.fields,
      sourceRecords: counts.sourceRecords,
      destinationRecords: counts.destinationRecords,
      unindexed: counts.unindexed,
      keys: state.keys,
      matched: state.matched,
      conflicting: state.conflicting,
      duplicated: state.duplicated,
      missingInDestination: state.missingInDestination,
      missingInSource: state.missingInSource,
      unevaluated: state.unevaluated,
    },
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. Equally, comparing a real root against an
 * unresolved target refuses legitimate files, so the root is realpath'd too.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    // The entry may still exist as a link that resolves nowhere. Confine the
    // nearest existing ancestor first, so a symlinked parent directory cannot
    // decide where a "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code === 'ELOOP' ? 'ELOOP' : 'ENOENT' }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the export.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${error.message}`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

/**
 * Reconcile two exported sides against a declared plan.
 *
 * @param {object} options
 * @param {string} options.root Directory holding the plan and both exports.
 * @param {string} [options.plan] Plan file, relative to the root.
 * @param {string} [options.source] Source export, relative to the root.
 * @param {string} [options.destination] Destination export, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @returns {Promise<object>} the report.
 */
export async function reconcileExports(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  const planName = validateName(options.plan ?? DEFAULT_PLAN_NAME, '--plan')
  const sourceName = validateName(options.source ?? DEFAULT_SOURCE_NAME, '--source')
  const destinationName = validateName(options.destination ?? DEFAULT_DESTINATION_NAME, '--destination')
  if (sourceName === destinationName) {
    throw new TypeError('--source and --destination must name different files; reconciling a file against itself proves nothing')
  }
  if (planName === sourceName || planName === destinationName) {
    throw new TypeError('--plan must name a file that is not one of the two exports')
  }

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const sink = new FindingSink()
  const files = { plan: planName, source: sourceName, destination: destinationName }
  const state = emptyState()
  const counts = { planName, sourceRecords: 0, destinationRecords: 0, unindexed: 0, fields: 0, key: [] }

  const documents = {}
  for (const [kind, name] of [['plan', planName], ['source', sourceName], ['destination', destinationName]]) {
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep the plan and both exports inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      documents[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    if (loaded === null) state.incomplete = true
    documents[kind] = loaded
  }

  let plan = null
  if (documents.plan !== null) {
    plan = compilePlan(sink, planName, documents.plan.value, limits)
    if (plan === null) state.incomplete = true
    else {
      counts.fields = plan.fields.length
      counts.key = plan.key
      // A field that did not compile was not compared. Reporting `fail` here
      // would claim the whole plan ran when part of it was refused.
      if (plan.fields.length !== plan.declaredFields) state.incomplete = true
    }
  }

  const sides = { source: null, destination: null }
  if (plan !== null) {
    for (const [kind, name] of [['source', sourceName], ['destination', destinationName]]) {
      if (documents[kind] === null) {
        sides[kind] = null
        continue
      }
      const compiled = compileRecords(sink, name, documents[kind].value, plan, limits)
      if (compiled === null) {
        state.incomplete = true
        sides[kind] = null
        continue
      }
      counts[kind === 'source' ? 'sourceRecords' : 'destinationRecords'] = compiled.declared
      counts.unindexed += compiled.unindexed
      // A record that could not be indexed was never joined against anything.
      if (compiled.unindexed > 0) state.incomplete = true
      sides[kind] = compiled
    }
  }

  let joined = false
  if (plan !== null && sides.source !== null && sides.destination !== null) {
    joined = true
    const outcome = reconcileSides(sink, files, plan, sides.source, sides.destination, limits)
    state.keys = outcome.keys
    state.checked = outcome.checked
    state.matched = outcome.matched
    state.conflicting = outcome.conflicting
    state.duplicated = outcome.duplicated
    state.missingInDestination = outcome.missingInDestination
    state.missingInSource = outcome.missingInSource
    state.unevaluated += outcome.unevaluated
    if (outcome.incomplete) state.incomplete = true
  }

  /**
   * The vacuous pass, refused explicitly.
   *
   * Two exports whose `records` arrays are both empty compile, the plan
   * compiles, the join runs and decides nothing, no other flag is set, and the
   * run would report `pass` with `checked: 0` -- green on no evidence at all.
   * This is the only thing standing between that pair of files and a green
   * build, so it is an error, it marks the run incomplete, and
   * `test/incomplete.test.mjs` fails if either half is removed.
   *
   * It is deliberately confined to runs that reached the join. A run whose
   * plan or either export could not be read, decoded, parsed or compiled has
   * already said so under its own rule id, and adding "0 keys were reconciled"
   * there would be noise -- worse, it would backstop those flags, so removing
   * one of them would change nothing observable and no test could fail when it
   * went. Each guard is now the only thing holding its own case, which is the
   * only arrangement a mutation can be caught in.
   */
  if (joined && state.checked === 0) {
    state.incomplete = true
    sink.add({
      file: sourceName,
      ruleId: 'no-records-evaluated',
      pointer: '/records',
      message: `The join decided 0 of ${state.keys} key(s), so this run has no evidence to be green on.`,
      suggestion: 'Export records that carry the declared join key on both sides, and fix whatever stopped the keys that are there from being decided.',
    })
  }

  return buildReport(sink, state, counts, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `plan ${excerpt(extra.plan ?? DEFAULT_PLAN_NAME, 80)}: ${summary.fields} field(s) compared under the declared normalisation.`,
    `source ${excerpt(extra.source ?? DEFAULT_SOURCE_NAME, 80)}: ${summary.sourceRecords} record(s). destination ${excerpt(extra.destination ?? DEFAULT_DESTINATION_NAME, 80)}: ${summary.destinationRecords} record(s). ${summary.unindexed} not indexed.`,
    `join: ${summary.keys} key(s), ${summary.matched} matched, ${summary.conflicting} conflicting, ${summary.duplicated} duplicated, ${summary.missingInDestination} missing in destination, ${summary.missingInSource} missing in source, ${summary.unevaluated} unevaluated. status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { FIELD_KEYS, FIELD_TYPES, PLAN_KEYS, PLAN_SCHEMA_VERSION, compilePlan, isFieldName } from './plan.mjs'
export { RECORDS_KEYS, RECORDS_SCHEMA_VERSION, compileRecords } from './records.mjs'
export { reconcileSides } from './reconcile.mjs'
export {
  GRANULARITIES, MAX_PRECISION, MIN_PRECISION, civilFromDays, normalizeAmount,
  normalizeCurrency, normalizeDate, normalizeInteger, normalizeString,
  parseTimezone, renderMinor,
} from './normalize.mjs'
export {
  EXCERPT_LIMIT, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue,
  excerpt, hasForbiddenCharacter, isIdentifier, isPlainObject,
} from './text.mjs'
