import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, reconcileExports, validateLimits } from '../src/index.mjs'
import { AMOUNT, apiReport, cliReport, findingsFor, fixture, planOf, raisedRules, row, sideOf, withRoot } from './support.mjs'

/**
 * Every documented limit, from both sides of the bound.
 *
 * A limit is only enforced if something changes when it is crossed, and only
 * documented honestly if nothing changes when it is not. One tool in this
 * catalog accepted a limit key and silently ignored it because the CLI never
 * wired it through, so every case here crosses the bound *and* sits on it, and
 * the last test drives each flag through the real binary.
 */

const rows = (count, prefix = 'INV') => {
  const made = []
  for (let index = 0; index < count; index += 1) made.push(row({ invoiceId: `${prefix}-${index}`, amount: '1.00' }))
  return made
}

test('maxRecords: at the bound nothing is said, above it nothing is indexed', async () => {
  const at = await apiReport(fixture(rows(3), rows(3)), { limits: { maxRecords: 3 } })
  assert.deepEqual(raisedRules(at), [])
  assert.equal(at.summary.matched, 3)

  const above = await apiReport(fixture(rows(4), rows(4)), { limits: { maxRecords: 3 } })
  assert.deepEqual(raisedRules(above), ['too-many-records'])
  assert.equal(above.status, 'incomplete')
  assert.match(findingsFor(above, 'too-many-records')[0].message, /above the maxRecords limit of 3; none of them were indexed/)
})

test('maxKeys: at the bound the whole join runs, above it the walk stops and says where', async () => {
  const at = await apiReport(fixture(rows(3), rows(3)), { limits: { maxKeys: 3 } })
  assert.deepEqual(raisedRules(at), [])

  const above = await apiReport(fixture(rows(4), rows(4)), { limits: { maxKeys: 3 } })
  assert.deepEqual(raisedRules(above), ['too-many-keys'])
  assert.equal(above.summary.checked, 3)
  assert.equal(above.summary.unevaluated, 1)
  assert.equal(above.status, 'incomplete')
})

test('maxRecordsPerKey: at the bound the whole group is named, above it the listing stops', async () => {
  const duplicated = [row({ invoiceId: 'INV-1', amount: '1.00' }), row({ invoiceId: 'INV-1', amount: '2.00' })]
  const at = await apiReport(fixture(duplicated, []), { limits: { maxRecordsPerKey: 2 } })
  assert.deepEqual(raisedRules(at), ['duplicate-key-in-source'])
  assert.equal(findingsFor(at, 'duplicate-key-in-source')[0].evidence, 'records: /records/0, /records/1')

  const above = await apiReport(fixture(duplicated, []), { limits: { maxRecordsPerKey: 1 } })
  assert.deepEqual(raisedRules(above), ['duplicate-key-in-source', 'too-many-records-for-key'])
  assert.equal(findingsFor(above, 'duplicate-key-in-source')[0].evidence, 'records: /records/0')
  assert.equal(above.status, 'incomplete')
})

test('maxFields and maxKeyFields: at the bound the plan compiles, above it nothing is compared', async () => {
  const twoFields = [AMOUNT, { name: 'status', type: 'string' }]
  const files = (fields, key) => ({
    'reconciliation.json': planOf(fields, key),
    'source.json': sideOf([{ invoiceId: 'INV-1', line: '1', amount: '1.00', status: 'ok' }]),
    'destination.json': sideOf([{ invoiceId: 'INV-1', line: '1', amount: '1.00', status: 'ok' }]),
  })

  assert.deepEqual(raisedRules(await apiReport(files(twoFields), { limits: { maxFields: 2 } })), [])
  const tooMany = await apiReport(files(twoFields), { limits: { maxFields: 1 } })
  assert.deepEqual(raisedRules(tooMany), ['too-many-fields'])
  assert.equal(tooMany.status, 'incomplete')

  assert.deepEqual(raisedRules(await apiReport(files([AMOUNT], ['invoiceId', 'line']), { limits: { maxKeyFields: 2 } })), [])
  const tooManyKeys = await apiReport(files([AMOUNT], ['invoiceId', 'line']), { limits: { maxKeyFields: 1 } })
  assert.deepEqual(raisedRules(tooManyKeys), ['too-many-key-fields'])
  assert.equal(tooManyKeys.status, 'incomplete')
})

test('maxFieldLength: at the bound the string compares, above it nothing is compared', async () => {
  const fields = [{ name: 'status', type: 'string' }]
  const files = (value) => fixture([{ invoiceId: 'INV-1', status: value }], [{ invoiceId: 'INV-1', status: value }], fields)

  assert.deepEqual(raisedRules(await apiReport(files('abcd'), { limits: { maxFieldLength: 4 } })), [])
  const above = await apiReport(files('abcde'), { limits: { maxFieldLength: 4 } })
  assert.deepEqual(raisedRules(above), ['field-value-too-long', 'no-records-evaluated'])
  assert.equal(above.status, 'incomplete')
})

test('maxFindings: at the bound the report is whole, above it it says it is partial', async () => {
  const at = await apiReport(fixture(rows(3), []), { limits: { maxFindings: 3 } })
  assert.equal(at.findings.length, 3)
  assert.equal(at.status, 'fail')

  const above = await apiReport(fixture(rows(4), []), { limits: { maxFindings: 3 } })
  assert.equal(above.findings.length, 3)
  assert.deepEqual(raisedRules(above), ['record-missing-in-destination', 'too-many-findings'])
  assert.equal(above.status, 'incomplete')
  assert.match(findingsFor(above, 'too-many-findings')[0].message, /2 were not reported and this report is partial/)
})

test('maxFileBytes: at the bound the file is read, one byte above it is not', async () => {
  const plan = `${JSON.stringify(planOf([AMOUNT]))}\n`
  const side = `${JSON.stringify(sideOf([row({ invoiceId: 'INV-1' })]))}\n`
  const size = Math.max(Buffer.byteLength(plan), Buffer.byteLength(side))
  const files = { 'reconciliation.json': plan, 'source.json': side, 'destination.json': side }

  const at = await withRoot(files, (root) => reconcileExports({ root, limits: { maxFileBytes: size } }))
  assert.deepEqual(raisedRules(at), [])
  assert.equal(at.summary.matched, 1)

  const above = await withRoot(files, (root) => reconcileExports({ root, limits: { maxFileBytes: size - 1 } }))
  assert.equal(raisedRules(above).includes('input-too-large'), true)
  assert.equal(above.status, 'incomplete')
})

test('an unknown limit key is a configuration error, not a silently ignored typo', async () => {
  assert.throws(() => validateLimits({ maxRecordsPerkey: 5 }), /Unknown limit "maxRecordsPerkey"/)
  assert.throws(() => validateLimits({ maxrecords: 5 }), /Unknown limit "maxrecords"/)
  assert.throws(() => validateLimits(null), /limits must be an object/)
  await assert.rejects(() => reconcileExports({ root: '.', limits: { maxKey: 1 } }), /Unknown limit/)
})

test('a limit may be lowered but not raised past its hard cap, and never to zero', () => {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    assert.equal(validateLimits({ [key]: 1 })[key], 1)
    assert.equal(validateLimits({ [key]: HARD_LIMITS[key] })[key], HARD_LIMITS[key])
    assert.throws(() => validateLimits({ [key]: HARD_LIMITS[key] + 1 }), new RegExp(`limits.${key} must be an integer`))
    assert.throws(() => validateLimits({ [key]: 0 }), new RegExp(`limits.${key} must be an integer`))
    assert.throws(() => validateLimits({ [key]: 1.5 }), new RegExp(`limits.${key} must be an integer`))
    assert.throws(() => validateLimits({ [key]: '5' }), new RegExp(`limits.${key} must be an integer`))
    assert.equal(DEFAULT_LIMITS[key] <= HARD_LIMITS[key], true, `${key} default is above its own cap`)
  }
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true)
  assert.equal(Object.isFrozen(HARD_LIMITS), true)
  assert.equal(Object.isFrozen(validateLimits({})), true)
})

test('every limit flag is wired through the real binary, so none is documented and ignored', async () => {
  const duplicated = [row({ invoiceId: 'INV-1', amount: '1.00' }), row({ invoiceId: 'INV-1', amount: '2.00' })]
  const cases = [
    ['--max-file-bytes', '10', 'input-too-large', fixture(rows(2), rows(2))],
    ['--max-records', '1', 'too-many-records', fixture(rows(2), rows(2))],
    ['--max-keys', '1', 'too-many-keys', fixture(rows(2), rows(2))],
    ['--max-records-per-key', '1', 'too-many-records-for-key', fixture(duplicated, [])],
    ['--max-fields', '1', 'too-many-fields', fixture(rows(1), rows(1), [AMOUNT, { name: 'status', type: 'string' }])],
    ['--max-key-fields', '1', 'too-many-key-fields', fixture(rows(1), rows(1), [AMOUNT], ['invoiceId', 'line'])],
    ['--max-field-length', '1', 'field-value-too-long', fixture([{ invoiceId: 'INV-1', status: 'long' }], [{ invoiceId: 'INV-1', status: 'long' }], [{ name: 'status', type: 'string' }])],
    ['--max-findings', '1', 'too-many-findings', fixture(rows(3), [])],
  ]
  for (const [flag, value, ruleId, files] of cases) {
    const result = await cliReport(files, [flag, value])
    assert.equal(raisedRules(result.report).includes(ruleId), true, `${flag} did not reach ${ruleId}`)
    assert.equal(result.code, 2, `${flag} should leave the run incomplete`)
  }
})

test('a limit flag with a bad value is refused rather than defaulted', async () => {
  for (const bad of ['0', 'ten', '-1', '1.5']) {
    const run = await cliReport(fixture(rows(1), rows(1)), ['--max-records', bad])
    assert.equal(run.code, 2, bad)
    assert.equal(run.stdout, '', 'a configuration error carries no report')
  }
  const huge = await cliReport(fixture(rows(1), rows(1)), ['--max-records', String(HARD_LIMITS.maxRecords + 1)])
  assert.equal(huge.code, 2)
  assert.equal(huge.stdout, '')
})
