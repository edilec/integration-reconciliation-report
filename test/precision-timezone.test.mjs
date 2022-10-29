import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, cliReport, findingsFor, fixture, raisedRules, row } from './support.mjs'

/**
 * Acceptance: amount and date normalisation respects the declared precision
 * and the declared timezone.
 *
 * Every case drives the real entry point and asserts the observable outcome --
 * `matched`, `conflicting`, `unevaluated`, the status and, where it is the
 * point, the process exit code. Nothing here compares a normaliser's return
 * value against a table.
 *
 * The two halves of the requirement are opposite failures, and both are
 * tested: a normalisation that is too eager reports a match where the data
 * differs, and one that is too timid reports a break where two systems wrote
 * the same value two ways.
 */

const amountAt = (precision) => [{ name: 'amount', type: 'amount', precision }]
const dateAt = (timezone, granularity) => [{ name: 'postedAt', type: 'date', timezone, granularity }]

const dated = (postedAt) => row({ amount: undefined, postedAt })

/**
 * A second key that both sides carry cleanly.
 *
 * Refusal cases need it. Without it the single key under test is the only key
 * there is, so a run that refuses it decides nothing at all and the vacuous
 * pass guard fires as well -- which would leave the refusal's own `incomplete`
 * flag backstopped by another guard, and a mutation there uncatchable. With a
 * control key the run decides one key, and the refusal is the only thing
 * making the run incomplete.
 */
function control(fields) {
  const record = { invoiceId: 'INV-0' }
  for (const spec of fields) {
    if (spec.type === 'amount') {
      record[spec.name] = '1.00'
      if (spec.currencyField !== undefined) record[spec.currencyField] = 'INR'
    } else if (spec.type === 'date') record[spec.name] = '2026-01-01T00:00:00Z'
    else record[spec.name] = 'ok'
  }
  return record
}

async function compare(fields, sourceValue, destinationValue) {
  return apiReport(fixture(
    [row({ amount: undefined, [fields[0].name]: sourceValue })],
    [row({ amount: undefined, [fields[0].name]: destinationValue })],
    fields,
  ))
}

/** The same comparison, with one clean key alongside so the run decides something. */
async function compareBeside(fields, sourceRecord, destinationRecord) {
  return apiReport(fixture(
    [control(fields), sourceRecord],
    [control(fields), destinationRecord],
    fields,
  ))
}

test('two spellings of the same amount match at the declared precision', async () => {
  for (const [left, right] of [['10.5', '10.50'], ['10.500', '10.50'], ['010.50', '10.5'], ['-0.00', '0.00']]) {
    const report = await compare(amountAt(2), left, right)
    assert.equal(report.summary.matched, 1, `${left} and ${right} are the same amount at 2 decimal places`)
    assert.equal(report.status, 'pass')
  }
})

test('an integer JSON number and a quoted decimal are the same amount', async () => {
  const report = await compare(amountAt(2), 4200, '4200.00')
  assert.equal(report.summary.matched, 1)
  assert.equal(report.status, 'pass')
})

test('a one-minor-unit difference at the declared precision is a conflict, not a rounding', async () => {
  const report = await compare(amountAt(2), '10.00', '10.01')
  assert.equal(report.summary.conflicting, 1)
  assert.equal(report.summary.matched, 0)
  assert.equal(report.status, 'fail')
  assert.equal(findingsFor(report, 'field-value-conflict')[0].evidence, 'source 10.00 vs destination 10.01 at destination.json/records/0/amount')
})

test('the declared precision decides: the same pair matches at 2 and conflicts at 3', async () => {
  const coarse = await compare(amountAt(2), '10.000', '10.00')
  assert.equal(coarse.summary.matched, 1)

  const fine = await compare(amountAt(3), '10.000', '10.001')
  assert.equal(fine.summary.conflicting, 1)
  assert.equal(fine.status, 'fail')

  const zero = await compare(amountAt(0), '10', '10.0')
  assert.equal(zero.summary.matched, 1)
  const zeroBreak = await compare(amountAt(0), '10', '11')
  assert.equal(zeroBreak.summary.conflicting, 1)
})

test('an amount with more significant digits than the declared precision is refused, never rounded', async () => {
  const fields = amountAt(2)
  const report = await compareBeside(fields, row({ amount: '10.005' }), row({ amount: '10.00' }))

  assert.deepEqual(raisedRules(report), ['amount-exceeds-declared-precision'])
  assert.equal(report.summary.matched, 1, 'only the control key matched; rounding down would have matched this one too')
  assert.equal(report.summary.conflicting, 0, 'rounding up would have conflicted')
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'amount-exceeds-declared-precision')[0].message, /Nothing was rounded and nothing was compared\./)
})

test('the same over-precise amount is compared happily once the precision is declared to cover it', async () => {
  const report = await compare(amountAt(3), '10.005', '10.005')
  assert.equal(report.summary.matched, 1)
  assert.equal(report.status, 'pass')
})

test('a fractional JSON number is refused rather than compared as a binary double', async () => {
  const fields = amountAt(2)
  const report = await compareBeside(fields, row({ amount: 10.1 }), row({ amount: '10.10' }))

  assert.deepEqual(raisedRules(report), ['amount-not-exact'])
  assert.equal(report.summary.matched, 1, 'the control key only')
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.status, 'incomplete')
})

test('amounts beyond the exact range of a double are still compared exactly', async () => {
  // 2^53 and 2^53+1 are the same binary double. Any implementation that
  // reaches for a Number here reports a match.
  const report = await compare(amountAt(0), '9007199254740992', '9007199254740993')
  assert.equal(report.summary.conflicting, 1)
  assert.equal(report.summary.matched, 0)
  assert.equal(report.status, 'fail')
})

test('a sum that a float would get wrong is compared exactly', async () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point; as minor units 10 + 20 === 30.
  const report = await compare(amountAt(2), '0.30', '0.3')
  assert.equal(report.summary.matched, 1)
})

test('the same instant written in two zones matches at every granularity', async () => {
  for (const granularity of ['day', 'hour', 'instant', 'minute']) {
    for (const timezone of ['Z', '+05:30', '-08:00']) {
      const report = await apiReport(fixture(
        [dated('2026-03-01T20:30:00Z')],
        [dated('2026-03-02T02:00:00+05:30')],
        dateAt(timezone, granularity),
      ))
      assert.equal(report.summary.matched, 1, `${granularity} in ${timezone}`)
      assert.equal(report.status, 'pass')
    }
  }
})

test('the declared timezone decides which calendar day two instants fall on', async () => {
  // 20:30Z is 02:00 the next day in +05:30; 04:00Z is 09:30 the same next day.
  // In India Standard Time they are one day; in UTC they are two.
  const together = await apiReport(fixture(
    [dated('2026-03-01T20:30:00Z')],
    [dated('2026-03-02T04:00:00Z')],
    dateAt('+05:30', 'day'),
  ))
  assert.equal(together.summary.matched, 1)
  assert.equal(together.status, 'pass')

  const apart = await apiReport(fixture(
    [dated('2026-03-01T20:30:00Z')],
    [dated('2026-03-02T04:00:00Z')],
    dateAt('Z', 'day'),
  ))
  assert.equal(apart.summary.conflicting, 1)
  assert.equal(apart.summary.matched, 0)
  assert.equal(apart.status, 'fail')
  assert.equal(
    findingsFor(apart, 'field-value-conflict')[0].evidence,
    'source 2026-03-01 vs destination 2026-03-02 at destination.json/records/0/postedAt',
  )
})

test('a negative declared offset moves the boundary the other way', async () => {
  const report = await apiReport(fixture(
    [dated('2026-03-01T20:30:00Z')],
    [dated('2026-03-02T04:00:00Z')],
    dateAt('-08:00', 'day'),
  ))
  // 12:30 and 20:00 on 2026-03-01 in -08:00: one day.
  assert.equal(report.summary.matched, 1)
})

test('two different instants do not match at a granularity that can tell them apart', async () => {
  const sameMinute = await apiReport(fixture(
    [dated('2026-03-01T20:30:10Z')],
    [dated('2026-03-01T20:30:50Z')],
    dateAt('Z', 'minute'),
  ))
  assert.equal(sameMinute.summary.matched, 1)

  const exact = await apiReport(fixture(
    [dated('2026-03-01T20:30:10Z')],
    [dated('2026-03-01T20:30:50Z')],
    dateAt('Z', 'instant'),
  ))
  assert.equal(exact.summary.conflicting, 1)
  assert.equal(exact.status, 'fail')

  const milli = await apiReport(fixture(
    [dated('2026-03-01T20:30:10.001Z')],
    [dated('2026-03-01T20:30:10.002Z')],
    dateAt('Z', 'instant'),
  ))
  assert.equal(milli.summary.conflicting, 1)
})

test('an hour granularity in a half-hour zone buckets on the half hour', async () => {
  const inside = await apiReport(fixture(
    [dated('2026-03-01T20:30:00Z')],
    [dated('2026-03-01T21:29:00Z')],
    dateAt('+05:30', 'hour'),
  ))
  assert.equal(inside.summary.matched, 1, '02:00 and 02:59 in +05:30')

  const outside = await apiReport(fixture(
    [dated('2026-03-01T20:29:00Z')],
    [dated('2026-03-01T20:30:00Z')],
    dateAt('+05:30', 'hour'),
  ))
  assert.equal(outside.summary.conflicting, 1, '01:59 and 02:00 in +05:30')
})

test('a timestamp with no offset is refused rather than assumed to be in the declared zone', async () => {
  const fields = dateAt('Z', 'instant')
  const report = await compareBeside(fields, dated('2026-03-01T20:30:00'), dated('2026-03-01T20:30:00Z'))

  assert.deepEqual(raisedRules(report), ['date-offset-missing'])
  assert.equal(report.summary.matched, 1, 'the control key only; assuming the declared zone would have matched this one too')
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.status, 'incomplete')
})

test('a date with no time part is a day, and only at day granularity', async () => {
  const asDay = await apiReport(fixture(
    [dated('2026-03-02')],
    [dated('2026-03-02T18:45:00+05:30')],
    dateAt('+05:30', 'day'),
  ))
  assert.equal(asDay.summary.matched, 1)

  const instantFields = dateAt('+05:30', 'instant')
  const asInstant = await compareBeside(instantFields, dated('2026-03-02'), dated('2026-03-02T00:00:00+05:30'))
  assert.deepEqual(raisedRules(asInstant), ['date-invalid'])
  assert.equal(asInstant.summary.matched, 1, 'the control key only: midnight was not assumed for the other')
  assert.equal(asInstant.status, 'incomplete')
})

test('the calendar is checked, so a day that does not exist is refused', async () => {
  const leap = await apiReport(fixture([dated('2028-02-29T00:00:00Z')], [dated('2028-02-29T00:00:00Z')], dateAt('Z', 'day')))
  assert.equal(leap.summary.matched, 1)

  const dayFields = dateAt('Z', 'day')
  const notLeap = await compareBeside(dayFields, dated('2026-02-29T00:00:00Z'), dated('2026-03-01T00:00:00Z'))
  assert.deepEqual(raisedRules(notLeap), ['date-invalid'])
  assert.equal(notLeap.status, 'incomplete', 'a rolled-forward 2026-02-29 would have matched 2026-03-01')
})

test('a named timezone is reported as unsupported, never treated as UTC', async () => {
  const result = await cliReport(fixture(
    [dated('2026-03-01T20:30:00Z')],
    [dated('2026-03-02T02:00:00+05:30')],
    dateAt('Asia/Kolkata', 'day'),
  ))

  assert.equal(result.code, 2)
  assert.equal(result.report.status, 'incomplete')
  assert.deepEqual(raisedRules(result.report), ['plan-timezone-unsupported'])
  assert.equal(result.report.summary.matched, 0)
  assert.equal(result.report.summary.checked, 0)
})

test('an amount in two currencies is never called equal', async () => {
  const fields = [{ name: 'amount', type: 'amount', precision: 2, currencyField: 'currency' }]
  const conflict = await apiReport(fixture(
    [row({ amount: '99.00', currency: 'INR' })],
    [row({ amount: '99.00', currency: 'USD' })],
    fields,
  ))
  assert.deepEqual(raisedRules(conflict), ['amount-currency-conflict'])
  assert.equal(conflict.summary.conflicting, 1)
  assert.equal(conflict.status, 'fail')

  const agreed = await apiReport(fixture(
    [row({ amount: '99.00', currency: 'INR' })],
    [row({ amount: '99.0', currency: 'INR' })],
    fields,
  ))
  assert.equal(agreed.summary.matched, 1)
})

test('a declared currency the export does not carry is unknown evidence, not an agreement', async () => {
  const fields = [{ name: 'amount', type: 'amount', precision: 2, currencyField: 'currency' }]
  const report = await compareBeside(fields, row({ amount: '99.00', currency: 'INR' }), row({ amount: '99.00' }))
  assert.deepEqual(raisedRules(report), ['field-evidence-missing'])
  assert.equal(report.summary.matched, 1, 'the control key only')
  assert.equal(report.status, 'incomplete')
})
