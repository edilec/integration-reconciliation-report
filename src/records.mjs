/**
 * Turning one exported side into key groups.
 *
 * The single most important line in this file is the one that **pushes**.
 *
 * A reconciliation tool that indexes records into a `Map` with `set` loses a
 * record every time two of them share a key: the second silently replaces the
 * first, the group looks like a clean one-to-one match, and the duplicate --
 * the thing the operator most needed to see -- is never reported. It is the
 * defining bug of this kind of tool, and it passes every test that only counts
 * matches. Every record for a key is kept here, in the order the file wrote
 * them, and the caller decides what a group with more than one row means.
 */

import { byCodeUnit, describeValue, excerpt, isIdentifier, isPlainObject } from './text.mjs'

export const RECORDS_SCHEMA_VERSION = '1'

/** Top-level keys of an exported side. Anything else is refused by name. */
export const RECORDS_KEYS = Object.freeze(['records', 'schemaVersion'])

/**
 * The key component read out of one record.
 *
 * A JSON integer is accepted and rendered as its exact decimal string, because
 * an export that writes `"invoiceId": 4711` means the same key as one that
 * writes `"4711"`. A non-integer number is refused: the binary double nearest
 * to `4711.0000000001` is not a stable identifier, and neither is a value that
 * prints differently from the bytes it arrived as.
 */
function keyComponent(raw) {
  if (typeof raw === 'string') return { ok: true, value: raw }
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return { ok: true, value: BigInt(raw).toString() }
  return { ok: false }
}

/**
 * Compile one exported side into key groups.
 *
 * @returns `{ groups, declared, indexed, unindexed }`, or `null` when the
 *   document itself was refused. `unindexed` is the count of records that were
 *   read but could not be placed in a group; the caller treats it as missing
 *   evidence, never as a clean side.
 */
export function compileRecords(sink, file, document, plan, limits) {
  if (!isPlainObject(document)) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'records-invalid',
      message: `An exported side must be a JSON object; ${file} holds ${describeValue(document)}.`,
    })
    return null
  }
  let fatal = false
  for (const key of Object.keys(document)) {
    if (RECORDS_KEYS.includes(key)) continue
    fatal = true
    sink.add({
      file,
      pointer: `/${key}`,
      ruleId: 'records-invalid',
      message: `${file} declares an unknown key "${excerpt(key, 64)}"; an exported side accepts ${RECORDS_KEYS.join(', ')}.`,
      suggestion: 'Per-record properties beyond the declared key and fields are data and are left alone; this is the document envelope.',
    })
  }
  if (document.schemaVersion !== RECORDS_SCHEMA_VERSION) {
    fatal = true
    sink.add({
      file,
      pointer: '/schemaVersion',
      ruleId: 'records-invalid',
      message: `${file} must declare schemaVersion "${RECORDS_SCHEMA_VERSION}"; it declares ${describeValue(document.schemaVersion)}.`,
    })
  }
  if (!Array.isArray(document.records)) {
    sink.add({
      file,
      pointer: '/records',
      ruleId: 'records-invalid',
      message: `${file} must declare "records" as an array; it declares ${describeValue(document.records)}.`,
    })
    return null
  }
  if (document.records.length > limits.maxRecords) {
    sink.add({
      file,
      pointer: '/records',
      ruleId: 'too-many-records',
      message: `${file} holds ${document.records.length} record(s), above the maxRecords limit of ${limits.maxRecords}; none of them were indexed.`,
      suggestion: 'Raise --max-records, or split the export.',
    })
    return null
  }
  if (fatal) return null

  const groups = new Map()
  let indexed = 0
  let unindexed = 0

  for (let index = 0; index < document.records.length; index += 1) {
    const pointer = `/records/${index}`
    const record = document.records[index]
    if (!isPlainObject(record)) {
      unindexed += 1
      sink.add({
        file,
        pointer,
        ruleId: 'record-invalid',
        message: `Record ${index} must be an object; it is ${describeValue(record)}. It was not indexed, so nothing on the other side was reconciled against it.`,
      })
      continue
    }

    const parts = []
    const missing = []
    let refused = false
    for (const name of plan.key) {
      const component = keyComponent(record[name])
      if (!component.ok) {
        missing.push(name)
        refused = true
        continue
      }
      if (!isIdentifier(component.value)) {
        refused = true
        sink.add({
          file,
          pointer: `${pointer}/${name}`,
          ruleId: 'identifier-invalid',
          message:
            `Record ${index} carries a key field "${excerpt(name, 64)}" that is not usable as an identifier: it must be 1-200 characters, ` +
            'without leading or trailing whitespace and without a control, separator or bidi character. A key that prints differently from the value that was grouped cannot be reconciled by hand.',
          suggestion: 'Export the identifier as plain text; a right-to-left override inside an invoice number makes two different keys look like one.',
        })
        continue
      }
      parts.push(component.value)
    }

    if (missing.length > 0) {
      sink.add({
        file,
        pointer,
        ruleId: 'record-key-missing',
        message: `Record ${index} does not carry every declared key field, so it could not be joined and was not indexed.`,
        // Ordering site: which missing field is named first is decided by code
        // unit, and `test/ordering.test.mjs` pins the emitted string.
        evidence: `missing key fields: ${missing.slice().sort(byCodeUnit).map((name) => excerpt(name, 64)).join(', ')}`,
        suggestion: 'Export the join key on every row, or join on a key every row carries.',
      })
    }
    if (refused) {
      unindexed += 1
      continue
    }

    const keyString = JSON.stringify(parts)
    let group = groups.get(keyString)
    if (group === undefined) {
      group = { display: parts.map((part) => excerpt(part, 64)).join(' | '), rows: [] }
      groups.set(keyString, group)
    }
    // The push that makes this tool honest. `groups.set(keyString, row)` here
    // would discard the earlier record for this key and report a clean match.
    group.rows.push({ index, pointer, record })
    indexed += 1
  }

  return { groups, declared: document.records.length, indexed, unindexed }
}
