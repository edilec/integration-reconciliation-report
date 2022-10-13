/**
 * Normalisation: turning two spellings of the same value into one comparison
 * key, and refusing to pretend when it cannot.
 *
 * Reconciliation lives or dies here. Two systems export the same invoice as
 * `10.5` and `10.50`, and the same posting as `2026-03-01T20:30:00Z` and
 * `2026-03-02T02:00:00+05:30`; those are equal. Two systems export `10.50` and
 * `10.504`, and `2026-03-01T20:30:00Z` and `2026-03-02T04:00:00Z`; whether
 * those are equal depends entirely on a precision and a timezone somebody has
 * to declare. This module never guesses either one, never rounds to make a
 * comparison work, and never compares two binary doubles and calls the result
 * a match.
 *
 * Every function is pure. Nothing here reads the clock, the locale, the
 * environment or the filesystem: `Date.UTC` is a pure conversion from
 * validated components to an epoch offset, and the zero-argument `Date`
 * constructor -- which does read the clock -- appears nowhere in this package.
 */

/** The granularities a declared date field may be compared at. */
export const GRANULARITIES = Object.freeze(['day', 'hour', 'instant', 'minute'])

/** Decimal places a declared amount field may be compared at. */
export const MIN_PRECISION = 0
export const MAX_PRECISION = 8

/** Bounds on a value's own text, so a pathological export cannot cost unbounded work. */
export const MAX_INTEGER_DIGITS = 18
export const MAX_FRACTION_DIGITS = 18

const MIN_YEAR = 1970
const MAX_YEAR = 2100
const MAX_OFFSET_MINUTES = 14 * 60
const DAY_MS = 86400000

/**
 * Parse a declared timezone.
 *
 * Only a **fixed offset** is supported: `Z`, `+HH:MM` or `-HH:MM`. A named
 * IANA zone such as `Asia/Kolkata` is refused rather than approximated,
 * because resolving one correctly needs a tz database with historical and
 * daylight-saving transitions -- data this package does not carry and will not
 * invent. A refusal is reported as unsupported and makes the run incomplete;
 * it is never silently treated as UTC, which would shift every bucket
 * boundary by hours and turn real mismatches into matches.
 */
export function parseTimezone(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' }
  if (value === 'Z') return { ok: true, minutes: 0, label: 'Z' }
  const parts = /^([+-])(\d{2}):(\d{2})$/.exec(value)
  if (parts === null) return { ok: false, reason: 'not-a-fixed-offset' }
  const hours = Number(parts[2])
  const minutes = Number(parts[3])
  if (minutes > 59) return { ok: false, reason: 'not-a-fixed-offset' }
  const total = hours * 60 + minutes
  if (total > MAX_OFFSET_MINUTES) return { ok: false, reason: 'out-of-range' }
  const signed = parts[1] === '-' ? -total : total
  return { ok: true, minutes: signed, label: signed === 0 ? 'Z' : value }
}

const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

function daysInMonth(year, month) {
  if (month !== 2) return DAYS_IN_MONTH[month - 1]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return leap ? 29 : 28
}

const pad = (value, width) => String(value).padStart(width, '0')

/**
 * Civil date from a day number counted from 1970-01-01, by arithmetic.
 *
 * Howard Hinnant's `civil_from_days`. Written out rather than delegated to the
 * `Date` object so that no part of this package constructs a `Date` at all:
 * the rule "no `new Date` without an injected clock" is easiest to keep when
 * there is nothing to audit.
 */
export function civilFromDays(dayNumber) {
  const z = dayNumber + 719468
  const era = Math.floor(z / 146097)
  const dayOfEra = z - era * 146097
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  )
  const year = yearOfEra + era * 400
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9
  return { year: month <= 2 ? year + 1 : year, month, day }
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/

/**
 * Normalise a timestamp to the bucket it falls in, in the **declared** zone at
 * the **declared** granularity.
 *
 * Two rules do the work here, and both of them are the point of the tool:
 *
 * 1. A value that carries no offset is refused (`offset-missing`). A bare
 *    `2026-03-01T20:30:00` names a different instant for every reader, so
 *    accepting it would make the report depend on who exported the file.
 * 2. The bucket is computed from the **instant**, shifted into the declared
 *    zone. So the same instant written two ways -- `2026-03-01T20:30:00Z` and
 *    `2026-03-02T02:00:00+05:30` -- lands in one bucket at every granularity,
 *    and two genuinely different instants land in one bucket only when the
 *    declared granularity says they should.
 *
 * A date with no time part is accepted only at `day` granularity, where it
 * means that calendar day in the declared zone. At any finer granularity it is
 * refused (`needs-instant`) rather than assumed to be midnight, because
 * midnight is an assumption and this tool does not make them.
 */
export function normalizeDate(raw, offsetMinutes, granularity) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' }
  const parts = INSTANT.exec(raw)
  if (parts === null) return { ok: false, reason: 'malformed' }

  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  if (year < MIN_YEAR || year > MAX_YEAR) return { ok: false, reason: 'out-of-range' }
  if (month < 1 || month > 12) return { ok: false, reason: 'not-a-real-instant' }
  if (day < 1 || day > daysInMonth(year, month)) return { ok: false, reason: 'not-a-real-instant' }

  const dateOnly = parts[4] === undefined
  if (dateOnly) {
    if (granularity !== 'day') return { ok: false, reason: 'needs-instant' }
    const rendered = `${parts[1]}-${parts[2]}-${parts[3]}`
    return { ok: true, key: rendered, display: rendered }
  }
  if (parts[8] === undefined) return { ok: false, reason: 'offset-missing' }

  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = parts[6] === undefined ? 0 : Number(parts[6])
  const millisecond = parts[7] === undefined ? 0 : Number(parts[7].padEnd(3, '0'))
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'not-a-real-instant' }

  const written = parseTimezone(parts[8])
  if (!written.ok) return { ok: false, reason: 'offset-invalid' }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - written.minutes * 60000
  if (!Number.isFinite(utcMs)) return { ok: false, reason: 'not-a-real-instant' }
  return { ok: true, ...bucketOf(utcMs + offsetMinutes * 60000, granularity, labelOf(offsetMinutes)) }
}

function labelOf(offsetMinutes) {
  if (offsetMinutes === 0) return 'Z'
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`
}

/**
 * The bucket a shifted timestamp falls in. The rendered string *is* the
 * comparison key: two values are equal at this granularity exactly when they
 * render the same, which keeps the key a reader can check against the evidence
 * rather than an opaque number.
 */
function bucketOf(shiftedMs, granularity, label) {
  const dayNumber = Math.floor(shiftedMs / DAY_MS)
  const withinDay = shiftedMs - dayNumber * DAY_MS
  const { year, month, day } = civilFromDays(dayNumber)
  const date = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
  if (granularity === 'day') return { key: date, display: date }
  const hour = Math.floor(withinDay / 3600000)
  if (granularity === 'hour') {
    const rendered = `${date}T${pad(hour, 2)}${label}`
    return { key: rendered, display: rendered }
  }
  const minute = Math.floor((withinDay % 3600000) / 60000)
  if (granularity === 'minute') {
    const rendered = `${date}T${pad(hour, 2)}:${pad(minute, 2)}${label}`
    return { key: rendered, display: rendered }
  }
  const second = Math.floor((withinDay % 60000) / 1000)
  const millisecond = withinDay % 1000
  const rendered = `${date}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}${label}`
  return { key: rendered, display: rendered }
}

const DECIMAL = /^([+-]?)(\d{1,18})(?:\.(\d{1,18}))?$/

/**
 * Render integer minor units back as a decimal at the declared precision, so
 * the evidence shows what was actually compared rather than what was written.
 */
export function renderMinor(minor, precision) {
  const negative = minor < 0n
  const digits = (negative ? -minor : minor).toString().padStart(precision + 1, '0')
  const whole = digits.slice(0, digits.length - precision)
  const fraction = precision === 0 ? '' : `.${digits.slice(digits.length - precision)}`
  return `${negative ? '-' : ''}${whole}${fraction}`
}

/**
 * Normalise an amount to **integer minor units** at the declared precision.
 *
 * Three refusals, each of which a reconciliation tool is expected to get wrong:
 *
 * - A JSON number with a fractional part is refused (`not-exact`). `10.1` in a
 *   JSON file is the binary double nearest to 10.1, and comparing two of those
 *   -- or adding them -- is how a reconciliation quietly reports a one-cent
 *   break that does not exist, or misses one that does. Quote the value and it
 *   is compared exactly.
 * - More fractional digits than the declared precision, with a non-zero digit
 *   beyond it, is refused (`precision`). Rounding here would decide the answer
 *   silently: `10.005` and `10.004` are the same amount at two decimal places
 *   only if somebody decided they should be, and that decision belongs in the
 *   plan, not in this function.
 * - Trailing zeros beyond the precision are *not* a refusal: `10.500` at
 *   precision 2 is exactly `10.50`, with nothing discarded.
 *
 * Comparison is on `BigInt` minor units, so no float ever takes part.
 */
export function normalizeAmount(raw, precision) {
  const scale = 10n ** BigInt(precision)
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return { ok: false, reason: 'not-exact' }
    if (!Number.isSafeInteger(raw)) return { ok: false, reason: 'out-of-range' }
    const minor = BigInt(raw) * scale
    return { ok: true, key: minor.toString(), display: renderMinor(minor, precision), minor }
  }
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-value' }
  const parts = DECIMAL.exec(raw)
  if (parts === null) return { ok: false, reason: 'malformed' }
  let fraction = parts[3] ?? ''
  if (fraction.length > precision) {
    if (/[^0]/.test(fraction.slice(precision))) return { ok: false, reason: 'precision' }
    fraction = fraction.slice(0, precision)
  }
  const magnitude = BigInt(`${parts[2]}${fraction.padEnd(precision, '0')}`)
  const minor = parts[1] === '-' ? -magnitude : magnitude
  return { ok: true, key: minor.toString(), display: renderMinor(minor, precision), minor }
}

const INTEGER = /^[+-]?\d{1,18}$/

/** An exact integer, from a JSON integer or a quoted one. No float takes part. */
export function normalizeInteger(raw) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return { ok: false, reason: 'not-exact' }
    if (!Number.isSafeInteger(raw)) return { ok: false, reason: 'out-of-range' }
    const rendered = BigInt(raw).toString()
    return { ok: true, key: rendered, display: rendered }
  }
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-value' }
  if (!INTEGER.test(raw)) return { ok: false, reason: 'malformed' }
  const rendered = BigInt(raw).toString()
  return { ok: true, key: rendered, display: rendered }
}

/** A currency code, so two amounts are never declared equal across two currencies. */
const CURRENCY = /^[A-Z]{3}$/

export function normalizeCurrency(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-value' }
  if (!CURRENCY.test(raw)) return { ok: false, reason: 'malformed' }
  return { ok: true, key: raw, display: raw }
}

/**
 * Normalise a string field under the declared options.
 *
 * Every option is declared in the plan and defaults conservatively: trimming
 * is on because a trailing space is an export artefact rather than a
 * difference, case sensitivity is on because `Posted` and `posted` may well be
 * two different states, and whitespace collapsing is off because the space
 * inside a name is usually data.
 */
export function normalizeString(raw, spec, maxLength) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' }
  if (raw.length > maxLength) return { ok: false, reason: 'too-long' }
  let value = raw
  if (spec.trim) value = value.trim()
  if (spec.collapseWhitespace) value = value.replace(/\s+/g, ' ')
  if (!spec.caseSensitive) value = value.toLowerCase()
  return { ok: true, key: value, display: value }
}
