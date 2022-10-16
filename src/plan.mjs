/**
 * The reconciliation plan: which fields form the join key, and how each
 * compared field is normalised before two spellings are called equal.
 *
 * The plan is configuration that happens to live in a file. Nothing in it is
 * inferred: a precision, a timezone and a granularity are declared or the
 * field is refused, because guessing any of the three decides matches and
 * breaks on the reader's behalf. Every unknown key is refused rather than
 * ignored -- a one-character typo that disables a comparison would turn a real
 * break into a green run, which is the defect this whole catalog is built
 * against.
 */

import { GRANULARITIES, MAX_PRECISION, MIN_PRECISION, parseTimezone } from './normalize.mjs'
import { describeValue, excerpt, isPlainObject } from './text.mjs'

export const PLAN_SCHEMA_VERSION = '1'

/** Top-level plan keys. Anything else is refused by name. */
export const PLAN_KEYS = Object.freeze(['fields', 'key', 'schemaVersion'])

/** The field types this tool knows how to normalise. */
export const FIELD_TYPES = Object.freeze(['amount', 'date', 'integer', 'string'])

/** Which keys each field type accepts. A key that belongs to another type is refused here. */
export const FIELD_KEYS = Object.freeze({
  amount: Object.freeze(['currencyField', 'name', 'precision', 'type']),
  date: Object.freeze(['granularity', 'name', 'timezone', 'type']),
  integer: Object.freeze(['name', 'type']),
  string: Object.freeze(['caseSensitive', 'collapseWhitespace', 'name', 'trim', 'type']),
})

const FIELD_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** A field name is a literal object key in a record. It is never a path: a dot means a dot. */
export function isFieldName(value) {
  return typeof value === 'string' && FIELD_NAME.test(value)
}

function optionalBoolean(sink, file, pointer, value, fallback, what) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    sink.add({
      file,
      pointer,
      ruleId: 'plan-field-invalid',
      message: `${what} must be true or false; the plan declares ${describeValue(value)}.`,
    })
    return null
  }
  return value
}

function compileField(sink, file, index, raw, keyFields) {
  const pointer = `/fields/${index}`
  if (!isPlainObject(raw)) {
    sink.add({
      file,
      pointer,
      ruleId: 'plan-field-invalid',
      message: `Field ${index} must be an object; the plan declares ${describeValue(raw)}.`,
    })
    return null
  }
  if (!isFieldName(raw.name)) {
    sink.add({
      file,
      pointer: `${pointer}/name`,
      ruleId: 'plan-field-invalid',
      message: 'A field name must be 1-64 characters of letters, digits, ".", "-" or "_", starting with a letter or digit.',
      suggestion: 'Name the record property exactly as it is spelled in the export; a field name is a literal key, never a path.',
    })
    return null
  }
  const name = raw.name
  if (typeof raw.type !== 'string' || !FIELD_TYPES.includes(raw.type)) {
    sink.add({
      file,
      pointer: `${pointer}/type`,
      ruleId: 'plan-type-unsupported',
      message: `Field "${excerpt(name, 64)}" declares a type this tool does not support; the supported types are ${FIELD_TYPES.join(', ')}.`,
      suggestion: 'An unsupported type is reported rather than compared, because comparing it would mean guessing how to normalise it.',
    })
    return null
  }
  const type = raw.type

  let refused = false
  for (const key of Object.keys(raw)) {
    if (FIELD_KEYS[type].includes(key)) continue
    refused = true
    sink.add({
      file,
      pointer: `${pointer}/${key}`,
      ruleId: 'plan-field-invalid',
      message: `Field "${excerpt(name, 64)}" of type ${type} does not accept the key "${excerpt(key, 64)}"; it accepts ${FIELD_KEYS[type].join(', ')}.`,
      suggestion: 'An unknown key is refused rather than ignored: a typo that silently disabled a comparison would turn a real break into a pass.',
    })
  }
  if (keyFields.includes(name)) {
    refused = true
    sink.add({
      file,
      pointer: `${pointer}/name`,
      ruleId: 'plan-field-invalid',
      message: `Field "${excerpt(name, 64)}" is also a join key field, so both sides hold the same value by construction and comparing it proves nothing.`,
      suggestion: 'Remove it from "fields", or join on a different key.',
    })
  }
  if (refused) return null

  const spec = { name, type, pointer }

  if (type === 'amount') {
    if (!Number.isInteger(raw.precision) || raw.precision < MIN_PRECISION || raw.precision > MAX_PRECISION) {
      sink.add({
        file,
        pointer: `${pointer}/precision`,
        ruleId: 'plan-field-invalid',
        message: `Amount field "${excerpt(name, 64)}" must declare an integer precision between ${MIN_PRECISION} and ${MAX_PRECISION}; the plan declares ${describeValue(raw.precision)}.`,
        suggestion: 'Precision is the number of decimal places the two systems agree to compare at. It is declared, never inferred.',
      })
      return null
    }
    spec.precision = raw.precision
    if (raw.currencyField !== undefined) {
      if (!isFieldName(raw.currencyField) || raw.currencyField === name) {
        sink.add({
          file,
          pointer: `${pointer}/currencyField`,
          ruleId: 'plan-field-invalid',
          message: `Amount field "${excerpt(name, 64)}" declares a currencyField that is not a distinct field name.`,
        })
        return null
      }
      spec.currencyField = raw.currencyField
    }
    return spec
  }

  if (type === 'date') {
    const zone = parseTimezone(raw.timezone)
    if (!zone.ok) {
      sink.add({
        file,
        pointer: `${pointer}/timezone`,
        ruleId: 'plan-timezone-unsupported',
        message:
          `Date field "${excerpt(name, 64)}" declares a timezone this tool does not support. ` +
          'Only a fixed offset -- "Z", "+HH:MM" or "-HH:MM" -- is supported; a named zone needs a tz database with daylight-saving history, which this package does not carry.',
        suggestion: 'Declare the fixed offset the two systems reconcile in, for example "+05:30".',
      })
      return null
    }
    if (typeof raw.granularity !== 'string' || !GRANULARITIES.includes(raw.granularity)) {
      sink.add({
        file,
        pointer: `${pointer}/granularity`,
        ruleId: 'plan-granularity-unsupported',
        message: `Date field "${excerpt(name, 64)}" must declare one of ${GRANULARITIES.join(', ')} as its granularity.`,
        suggestion: 'Granularity says how close two instants must be to count as the same posting. It is declared, never inferred.',
      })
      return null
    }
    spec.offsetMinutes = zone.minutes
    spec.timezone = zone.label
    spec.granularity = raw.granularity
    return spec
  }

  if (type === 'string') {
    const trim = optionalBoolean(sink, file, `${pointer}/trim`, raw.trim, true, `Field "${excerpt(name, 64)}" key "trim"`)
    const caseSensitive = optionalBoolean(sink, file, `${pointer}/caseSensitive`, raw.caseSensitive, true, `Field "${excerpt(name, 64)}" key "caseSensitive"`)
    const collapse = optionalBoolean(sink, file, `${pointer}/collapseWhitespace`, raw.collapseWhitespace, false, `Field "${excerpt(name, 64)}" key "collapseWhitespace"`)
    if (trim === null || caseSensitive === null || collapse === null) return null
    spec.trim = trim
    spec.caseSensitive = caseSensitive
    spec.collapseWhitespace = collapse
    return spec
  }

  return spec
}

/**
 * Compile the plan document.
 *
 * Returns `null` when nothing usable survived. A plan that compiled with one
 * field refused returns the rest together with `declaredFields`, so the caller
 * can see that fewer fields were compared than the plan declares and mark the
 * run incomplete rather than reporting a pass over a comparison that never ran.
 */
export function compilePlan(sink, file, document, limits) {
  if (!isPlainObject(document)) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'plan-invalid',
      message: `The plan must be a JSON object; ${file} holds ${describeValue(document)}.`,
    })
    return null
  }
  let fatal = false
  for (const key of Object.keys(document)) {
    if (PLAN_KEYS.includes(key)) continue
    fatal = true
    sink.add({
      file,
      pointer: `/${key}`,
      ruleId: 'plan-key-unknown',
      message: `The plan declares an unknown key "${excerpt(key, 64)}"; it accepts ${PLAN_KEYS.join(', ')}.`,
      suggestion: 'An unknown key is refused rather than ignored: a typo that silently disabled part of the plan would turn a real break into a pass.',
    })
  }
  if (document.schemaVersion !== PLAN_SCHEMA_VERSION) {
    fatal = true
    sink.add({
      file,
      pointer: '/schemaVersion',
      ruleId: 'plan-invalid',
      message: `The plan must declare schemaVersion "${PLAN_SCHEMA_VERSION}"; it declares ${describeValue(document.schemaVersion)}.`,
    })
  }

  if (!Array.isArray(document.key) || document.key.length === 0) {
    sink.add({
      file,
      pointer: '/key',
      ruleId: 'plan-invalid',
      message: `The plan must declare "key" as a non-empty array of field names; it declares ${describeValue(document.key)}.`,
      suggestion: 'The join key is the stable identifier both systems export. Without one there is nothing to join on.',
    })
    return null
  }
  if (document.key.length > limits.maxKeyFields) {
    sink.add({
      file,
      pointer: '/key',
      ruleId: 'too-many-key-fields',
      message: `The plan declares ${document.key.length} key field(s), above the maxKeyFields limit of ${limits.maxKeyFields}; nothing was joined.`,
      suggestion: 'Raise --max-key-fields, or join on fewer fields.',
    })
    return null
  }
  const keyFields = []
  for (let index = 0; index < document.key.length; index += 1) {
    const name = document.key[index]
    if (!isFieldName(name)) {
      sink.add({
        file,
        pointer: `/key/${index}`,
        ruleId: 'plan-invalid',
        message: `Key field ${index} must be 1-64 characters of letters, digits, ".", "-" or "_", starting with a letter or digit.`,
      })
      return null
    }
    if (keyFields.includes(name)) {
      sink.add({
        file,
        pointer: `/key/${index}`,
        ruleId: 'plan-field-duplicate',
        message: `Key field "${excerpt(name, 64)}" is declared more than once.`,
      })
      return null
    }
    keyFields.push(name)
  }

  if (!Array.isArray(document.fields)) {
    sink.add({
      file,
      pointer: '/fields',
      ruleId: 'plan-invalid',
      message: `The plan must declare "fields" as an array; it declares ${describeValue(document.fields)}.`,
    })
    return null
  }
  if (document.fields.length === 0) {
    sink.add({
      file,
      pointer: '/fields',
      ruleId: 'no-fields-declared',
      message: 'The plan declares no fields to compare, so a matched key would be green on no field evidence at all.',
      suggestion: 'Declare at least one field to compare, even if it is only the amount.',
    })
    return null
  }
  if (document.fields.length > limits.maxFields) {
    sink.add({
      file,
      pointer: '/fields',
      ruleId: 'too-many-fields',
      message: `The plan declares ${document.fields.length} field(s), above the maxFields limit of ${limits.maxFields}; nothing was compared.`,
      suggestion: 'Raise --max-fields, or compare fewer fields.',
    })
    return null
  }

  const fields = []
  const seen = new Set()
  for (let index = 0; index < document.fields.length; index += 1) {
    const spec = compileField(sink, file, index, document.fields[index], keyFields)
    if (spec === null) continue
    if (seen.has(spec.name)) {
      sink.add({
        file,
        pointer: `/fields/${index}/name`,
        ruleId: 'plan-field-duplicate',
        message: `Field "${excerpt(spec.name, 64)}" is declared more than once; the second declaration was refused rather than silently replacing the first.`,
      })
      continue
    }
    seen.add(spec.name)
    fields.push(spec)
  }

  if (fatal || fields.length === 0) return null
  return { key: keyFields, fields, declaredFields: document.fields.length }
}
