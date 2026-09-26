/**
 * The join: four outcomes, and no fifth one hiding behind a silent overwrite.
 *
 * For each key present on either side the walk produces exactly one of:
 *
 * - **matched** -- one record on each side, and every declared field equal
 *   once normalised;
 * - **conflicting** -- one record on each side, and at least one declared
 *   field that is not equal;
 * - **missing** -- present on one side and absent on the other;
 * - **duplicated** -- more than one record for the key on a side.
 *
 * A fifth state exists and is reported as itself rather than folded into one
 * of the four: a key whose comparison needed evidence the export does not
 * carry -- an absent field, an amount written as a float, a timestamp with no
 * offset -- is *unevaluated*. It is not a match, it is not a break, and it
 * makes the run incomplete. Unknown evidence is never a pass.
 */

import {
  normalizeAmount, normalizeCurrency, normalizeDate, normalizeInteger, normalizeString,
} from './normalize.mjs'
import { byCodeUnit, describeValue, excerpt } from './text.mjs'

/** Normalise one raw value under one compiled field spec. */
function normalizeValue(spec, raw, limits) {
  if (spec.type === 'amount') return normalizeAmount(raw, spec.precision)
  if (spec.type === 'date') return normalizeDate(raw, spec.offsetMinutes, spec.granularity)
  if (spec.type === 'integer') return normalizeInteger(raw)
  return normalizeString(raw, spec, limits.maxFieldLength)
}

/**
 * The rule that reports a value this tool could not normalise.
 *
 * Each reason gets its own rule id rather than one catch-all, because the
 * remedies differ: a float is quoted, an over-precise amount is a decision
 * about the declared precision, and a timestamp with no offset is an export
 * that has to be fixed at the source.
 */
function refusalRule(spec, reason) {
  if (spec.type === 'amount') {
    if (reason === 'not-exact') return 'amount-not-exact'
    if (reason === 'precision') return 'amount-exceeds-declared-precision'
    return 'amount-invalid'
  }
  if (spec.type === 'date') {
    if (reason === 'offset-missing') return 'date-offset-missing'
    return 'date-invalid'
  }
  if (reason === 'too-long') return 'field-value-too-long'
  return 'field-value-invalid'
}

function refusalMessage(spec, reason, limits) {
  if (reason === 'not-exact') {
    return (
      `Field "${spec.name}" is a JSON number with a fractional part. A fractional JSON number is the nearest binary double, not the amount that was written, ` +
      'so it was refused rather than compared: comparing two of them invents one-cent breaks and hides real ones.'
    )
  }
  if (reason === 'precision') {
    return (
      `Field "${spec.name}" carries more significant decimal places than the declared precision of ${spec.precision}, so it cannot be compared at that precision without rounding. ` +
      'Nothing was rounded and nothing was compared.'
    )
  }
  if (reason === 'offset-missing') {
    return (
      `Field "${spec.name}" is a timestamp with no UTC offset, so it names a different instant for every reader. ` +
      'It was refused rather than assumed to be in the declared timezone.'
    )
  }
  if (reason === 'needs-instant') {
    return `Field "${spec.name}" is a date with no time part, which is only comparable at "day" granularity; this field declares "${spec.granularity}". Midnight was not assumed.`
  }
  if (reason === 'too-long') {
    return `Field "${spec.name}" is longer than the maxFieldLength limit of ${limits.maxFieldLength} characters, so it was not compared.`
  }
  return `Field "${spec.name}" could not be normalised as a ${spec.type} value (${reason}), so it was not compared.`
}

/** List the records in a duplicated group, bounded, and say where the listing stopped. */
function listRows(sink, state, file, display, rows, limits) {
  // Ordering site: the listing, the finding's own pointer and the cut-off all
  // follow code-unit order. `test/ordering.test.mjs` pins each of the three.
  const pointers = rows.map((row) => row.pointer).sort(byCodeUnit)
  if (pointers.length <= limits.maxRecordsPerKey) return pointers
  const listed = pointers.slice(0, limits.maxRecordsPerKey)
  state.incomplete = true
  sink.add({
    file,
    pointer: '',
    ruleId: 'too-many-records-for-key',
    message:
      `Key "${display}" has ${pointers.length} record(s) in ${file}, above the maxRecordsPerKey limit of ${limits.maxRecordsPerKey}; ` +
      `the listing stopped at ${pointers[limits.maxRecordsPerKey]} and this report does not name every duplicate.`,
    suggestion: 'Raise --max-records-per-key to see the whole group.',
  })
  return listed
}

/** Every declared field of a row, normalised into one comparable string, or `null` if any refused. */
function fingerprintRow(plan, row, limits) {
  const parts = []
  for (const spec of plan.fields) {
    const raw = row.record[spec.name]
    if (raw === undefined) return null
    const normalised = normalizeValue(spec, raw, limits)
    if (!normalised.ok) return null
    parts.push(normalised.key)
    if (spec.type === 'amount' && spec.currencyField !== undefined) {
      const currency = normalizeCurrency(row.record[spec.currencyField])
      if (!currency.ok) return null
      parts.push(currency.key)
    }
  }
  return JSON.stringify(parts)
}

function reportDuplicate(sink, state, file, ruleId, otherLabel, otherCount, display, rows, plan, limits) {
  const listed = listRows(sink, state, file, display, rows, limits)
  sink.add({
    file,
    pointer: listed[0],
    ruleId,
    message:
      `Key "${display}" is carried by ${rows.length} records in ${file}, and the ${otherLabel} side holds ${otherCount} record(s) for it. ` +
      'Every one of them was kept; none of them was reconciled, because a duplicated key has no single value to compare against.',
    evidence: `records: ${listed.join(', ')}`,
    suggestion: 'Deduplicate the export, or extend the join key until it identifies one row per side.',
  })

  const fingerprints = new Set()
  for (const row of rows) {
    const fingerprint = fingerprintRow(plan, row, limits)
    if (fingerprint === null) return
    fingerprints.add(fingerprint)
  }
  if (fingerprints.size === 1) {
    sink.add({
      file,
      pointer: listed[0],
      ruleId: 'duplicate-values-identical',
      message: `The ${rows.length} records for key "${display}" in ${file} agree on every declared field once normalised, so the duplication looks like a repeated export rather than divergent data.`,
      suggestion: 'They are still reported as duplicated: which row is authoritative is not this tool\'s decision to make.',
    })
  }
}

/**
 * Compare one source record against one destination record.
 *
 * Returns `{ conflict, unknown }`. A key can be both: a conflict on one field
 * is a definite break, and an unevaluated field elsewhere is still missing
 * evidence, so the run is a failure *and* incomplete.
 */
function compareRecords(sink, state, files, plan, display, source, destination, limits) {
  let conflict = false
  let unknown = false

  for (const spec of plan.fields) {
    const sides = [
      { label: 'source', file: files.source, row: source, raw: source.record[spec.name] },
      { label: 'destination', file: files.destination, row: destination, raw: destination.record[spec.name] },
    ]

    let absent = false
    for (const side of sides) {
      if (side.raw !== undefined) continue
      absent = true
      sink.add({
        file: side.file,
        pointer: `${side.row.pointer}/${spec.name}`,
        ruleId: 'field-evidence-missing',
        message: `Key "${display}" declares field "${spec.name}" for comparison, but the ${side.label} record does not carry it, so the two sides were not compared on it.`,
        suggestion: 'Export the field on both sides, or remove it from the plan. An absent field is unknown evidence, never an agreement.',
      })
    }
    if (absent) {
      unknown = true
      state.incomplete = true
      continue
    }

    const normalised = []
    let refused = false
    for (const side of sides) {
      const result = normalizeValue(spec, side.raw, limits)
      if (result.ok) {
        normalised.push(result)
        continue
      }
      refused = true
      sink.add({
        file: side.file,
        pointer: `${side.row.pointer}/${spec.name}`,
        ruleId: refusalRule(spec, result.reason),
        message: `${refusalMessage(spec, result.reason, limits)} The ${side.label} side carries ${describeValue(side.raw)} for key "${display}".`,
        suggestion: spec.type === 'amount'
          ? 'Export amounts as quoted decimal strings at the declared precision.'
          : 'Export the value in the shape the plan declares for this field.',
      })
    }
    if (refused) {
      unknown = true
      state.incomplete = true
      continue
    }

    if (spec.type === 'amount' && spec.currencyField !== undefined) {
      const currencies = []
      let currencyRefused = false
      for (const side of sides) {
        const raw = side.row.record[spec.currencyField]
        if (raw === undefined) {
          currencyRefused = true
          sink.add({
            file: side.file,
            pointer: `${side.row.pointer}/${spec.currencyField}`,
            ruleId: 'field-evidence-missing',
            message: `Amount field "${spec.name}" declares currencyField "${spec.currencyField}", and the ${side.label} record for key "${display}" does not carry it. Two amounts were not declared equal without it.`,
          })
          continue
        }
        const currency = normalizeCurrency(raw)
        if (!currency.ok) {
          currencyRefused = true
          sink.add({
            file: side.file,
            pointer: `${side.row.pointer}/${spec.currencyField}`,
            ruleId: 'field-value-invalid',
            message: `Currency field "${spec.currencyField}" must be a three-letter uppercase code; the ${side.label} record for key "${display}" carries ${describeValue(raw)}.`,
          })
          continue
        }
        currencies.push(currency)
      }
      if (currencyRefused) {
        unknown = true
        state.incomplete = true
        continue
      }
      if (currencies[0].key !== currencies[1].key) {
        conflict = true
        sink.add({
          file: files.source,
          pointer: `${source.pointer}/${spec.currencyField}`,
          ruleId: 'amount-currency-conflict',
          message: `Key "${display}" carries amount "${spec.name}" in two different currencies, so the two amounts are not comparable and were not called equal.`,
          evidence: `source ${currencies[0].display} vs destination ${currencies[1].display} at ${files.destination}${destination.pointer}/${spec.currencyField}`,
        })
        continue
      }
    }

    if (normalised[0].key !== normalised[1].key) {
      conflict = true
      sink.add({
        file: files.source,
        pointer: `${source.pointer}/${spec.name}`,
        ruleId: 'field-value-conflict',
        message: `Key "${display}" does not agree on field "${spec.name}": the two sides normalise to different values.`,
        evidence: `source ${excerpt(normalised[0].display, 60)} vs destination ${excerpt(normalised[1].display, 60)} at ${files.destination}${destination.pointer}/${spec.name}`,
        suggestion: 'This is a real break: the two systems hold different data for one key.',
      })
      continue
    }

    if (JSON.stringify(source.record[spec.name]) !== JSON.stringify(destination.record[spec.name])) {
      sink.add({
        file: files.source,
        pointer: `${source.pointer}/${spec.name}`,
        ruleId: 'field-match-after-normalization',
        message: `Key "${display}" agrees on field "${spec.name}" only after the declared normalisation was applied; the two exports spell the value differently.`,
        evidence: `both normalise to ${excerpt(normalised[0].display, 80)}`,
      })
    }
  }

  return { conflict, unknown }
}

/** Keys that differ only by ASCII case, which one system upcasing its identifiers will produce. */
function reportCaseCollisions(sink, files, walked, displays) {
  const buckets = new Map()
  for (const keyString of walked) {
    const folded = keyString.toLowerCase()
    let bucket = buckets.get(folded)
    if (bucket === undefined) {
      bucket = []
      buckets.set(folded, bucket)
    }
    bucket.push(keyString)
  }
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    // Ordering site: the colliding keys are named in code-unit order.
    const named = bucket.slice().sort(byCodeUnit).map((keyString) => displays.get(keyString))
    sink.add({
      file: files.plan,
      pointer: '/key',
      ruleId: 'key-case-collision',
      message: `${bucket.length} join keys differ only by letter case, so a system that upper-cases its identifiers would reconcile them as one key while this tool keeps them apart.`,
      evidence: `keys: ${named.join(', ')}`,
      suggestion: 'Decide whether case is significant in this key, and make both exports agree.',
    })
  }
}

/**
 * Walk the union of keys and produce the outcome counts.
 *
 * @returns counts plus `incomplete`, which the caller folds into the status.
 */
export function reconcileSides(sink, files, plan, source, destination, limits) {
  const state = {
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

  const displays = new Map()
  for (const [keyString, group] of source.groups) displays.set(keyString, group.display)
  for (const [keyString, group] of destination.groups) if (!displays.has(keyString)) displays.set(keyString, group.display)

  // Ordering site: the whole walk order. It decides which keys a maxKeys
  // cut-off reaches, and therefore which keys are reconciled at all.
  const ordered = [...displays.keys()].sort(byCodeUnit)
  state.keys = ordered.length

  let walked = ordered
  if (ordered.length > limits.maxKeys) {
    walked = ordered.slice(0, limits.maxKeys)
    state.incomplete = true
    state.unevaluated += ordered.length - limits.maxKeys
    sink.add({
      file: files.plan,
      pointer: '/key',
      ruleId: 'too-many-keys',
      message:
        `The two exports hold ${ordered.length} distinct key(s), above the maxKeys limit of ${limits.maxKeys}; ` +
        `the walk stopped at key "${displays.get(ordered[limits.maxKeys])}" and everything from there on was not reconciled.`,
      suggestion: 'Raise --max-keys, or reconcile a narrower slice of the export.',
    })
  }

  for (const keyString of walked) {
    const display = displays.get(keyString)
    const sourceRows = source.groups.get(keyString)?.rows ?? []
    const destinationRows = destination.groups.get(keyString)?.rows ?? []

    if (sourceRows.length > 1 || destinationRows.length > 1) {
      if (sourceRows.length > 1) {
        reportDuplicate(sink, state, files.source, 'duplicate-key-in-source', 'destination', destinationRows.length, display, sourceRows, plan, limits)
      }
      if (destinationRows.length > 1) {
        reportDuplicate(sink, state, files.destination, 'duplicate-key-in-destination', 'source', sourceRows.length, display, destinationRows, plan, limits)
      }
      state.duplicated += 1
      state.checked += 1
      continue
    }

    if (destinationRows.length === 0) {
      sink.add({
        file: files.source,
        pointer: sourceRows[0].pointer,
        ruleId: 'record-missing-in-destination',
        message: `Key "${display}" is present in ${files.source} and absent from ${files.destination}.`,
      })
      state.missingInDestination += 1
      state.checked += 1
      continue
    }
    if (sourceRows.length === 0) {
      sink.add({
        file: files.destination,
        pointer: destinationRows[0].pointer,
        ruleId: 'record-missing-in-source',
        message: `Key "${display}" is present in ${files.destination} and absent from ${files.source}.`,
      })
      state.missingInSource += 1
      state.checked += 1
      continue
    }

    const outcome = compareRecords(sink, state, files, plan, display, sourceRows[0], destinationRows[0], limits)
    if (outcome.conflict) {
      state.conflicting += 1
      state.checked += 1
    } else if (outcome.unknown) {
      state.unevaluated += 1
    } else {
      state.matched += 1
      state.checked += 1
    }
  }

  reportCaseCollisions(sink, files, walked, displays)
  return state
}
