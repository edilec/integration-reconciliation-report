import assert from 'node:assert/strict'
import test from 'node:test'

import { hasForbiddenCharacter } from '../src/index.mjs'
import { AMOUNT, FORBIDDEN, apiReport, cliReport, cliRun, findingsFor, fixture, planOf, raisedRules, row, sideOf, withRoot } from './support.mjs'

/**
 * Nothing untrusted reaches output carrying a control, separator or bidi
 * character -- not in an excerpt, and not in an identifier either.
 *
 * Four tools in this catalog stripped C0 and the line separators and let the
 * C1 range through, where U+0085 is a line break to a great many consumers and
 * U+009B is the 8-bit CSI. A fifth sanitised its evidence field carefully and
 * left its identifiers raw, so a page id holding a newline forged whole lines
 * in the human report. Both shapes are covered here: every class is tested,
 * and the cases that matter most arrive through an **identifier** -- an object
 * key in the plan or in an export envelope -- which becomes both a message and
 * a JSON pointer.
 */

/** Every string anywhere in a report, however deeply nested. */
function everyString(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) everyString(item, out)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      everyString(item, out)
    }
  }
  return out
}

function assertClean(report, label) {
  for (const text of everyString(report)) {
    assert.equal(hasForbiddenCharacter(text), false, `${label}: ${JSON.stringify(text)} carries a forbidden character`)
  }
}

test('a forbidden character arriving through a plan identifier reaches neither message nor pointer', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      'reconciliation.json': { schemaVersion: '1', key: ['invoiceId'], fields: [AMOUNT], [`ke${character}y`]: 1 },
      'source.json': sideOf([row({ invoiceId: 'INV-1' })]),
      'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
    })
    assert.equal(raisedRules(report).includes('plan-key-unknown'), true, name)
    assertClean(report, name)
    const finding = findingsFor(report, 'plan-key-unknown')[0]
    assert.equal(finding.location.pointer.includes('ke'), true, `${name}: the pointer still names the key`)
  }
})

test('a forbidden character arriving through an export envelope identifier is stripped too', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      'reconciliation.json': planOf([AMOUNT]),
      'source.json': { schemaVersion: '1', records: [row({ invoiceId: 'INV-1' })], [`ro${character}ws`]: 1 },
      'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
    })
    assert.equal(raisedRules(report).includes('records-invalid'), true, name)
    assertClean(report, name)
  }
})

test('a forbidden character inside a compared value never reaches the evidence raw', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(fixture(
      [{ invoiceId: 'INV-1', status: `ok${character}left` }],
      [{ invoiceId: 'INV-1', status: `ok${character}right` }],
      [{ name: 'status', type: 'string' }],
    ))
    assert.deepEqual(raisedRules(report), ['field-value-conflict'], name)
    assertClean(report, name)
  }
})

test('a join key carrying a forbidden character is refused, not cleaned up', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(fixture(
      [row({ invoiceId: 'INV-0', amount: '1.00' }), row({ invoiceId: `INV${character}1` })],
      [row({ invoiceId: 'INV-0', amount: '1.00' })],
    ))
    assert.deepEqual(raisedRules(report), ['identifier-invalid'], name)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.unindexed, 1, `${name}: the record was not joined under a cleaned-up key`)
    assertClean(report, name)
  }
})

test('a field name is restricted to a safe alphabet rather than sanitised afterwards', async () => {
  const report = await apiReport({
    'reconciliation.json': planOf([{ name: `amo${String.fromCharCode(0x0a)}unt`, type: 'amount', precision: 2 }]),
    'source.json': sideOf([row({ invoiceId: 'INV-1' })]),
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  })
  assert.deepEqual(raisedRules(report), ['plan-field-invalid'])
  assertClean(report, 'field name')
})

test('the human report gains no forged lines, however many newlines arrive', async () => {
  const newline = String.fromCharCode(0x0a)
  const nel = String.fromCharCode(0x85)
  const separator = String.fromCharCode(0x2028)
  const files = {
    'reconciliation.json': planOf([AMOUNT]),
    'source.json': { schemaVersion: '1', records: [row({ invoiceId: 'INV-1' })], [`a${newline}b${nel}c${separator}d`]: 1 },
    'destination.json': sideOf([row({ invoiceId: 'INV-1' })]),
  }

  const machine = await cliReport(files)
  assert.equal(machine.code, 2)
  assertClean(machine.report, 'cli')

  const human = await withRoot(files, (root) => cliRun(['--root', root]))
  assert.equal(human.code, 2)
  // Three summary lines, one finding line, the incomplete line, one trailing
  // empty. Three separate forged line breaks arrived in one identifier and
  // none of them reached the stream.
  assert.equal(human.stderr.split(newline).length, 6, human.stderr)
  assert.equal(hasForbiddenCharacter(human.stderr.replaceAll(newline, '')), false)
})

test('an unknown CLI option is flattened before it reaches stderr', async () => {
  const newline = String.fromCharCode(0x0a)
  const run = await cliRun(['--root', '.', `--no${newline}pe`])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(hasForbiddenCharacter(run.stderr.split(newline)[0]), false)
  assert.equal(run.stderr.startsWith('Unknown option "--no pe"'), true, run.stderr.slice(0, 60))
})

test('a long untrusted value is bounded rather than emitted whole', async () => {
  const report = await apiReport(fixture(
    [{ invoiceId: 'INV-1', status: 'x'.repeat(900) }],
    [{ invoiceId: 'INV-1', status: 'y'.repeat(900) }],
    [{ name: 'status', type: 'string' }],
  ))
  const finding = findingsFor(report, 'field-value-conflict')[0]
  assert.equal(finding.evidence.length <= 163, true, finding.evidence.length)
  assert.equal(finding.evidence.endsWith('...'), true)
  assert.equal(finding.message.length <= 400, true)
})
