import assert from 'node:assert/strict'
import { link } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { reconcileExports } from '../src/index.mjs'
import { AMOUNT, apiReport, findingsFor, fixture, planOf, raisedRules, row, sideOf, withRoot } from './support.mjs'

/**
 * Ordering, pinned by what the tool emits -- one call site at a time.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running. Pinning the comparator itself is not enough either: the comparator
 * is one function and the tool orders things at eight separate places, each of
 * which can be swapped on its own.
 *
 * So there is a case here for **each** ordering site that reaches output. Each
 * one uses values whose collation order genuinely differs from their code-unit
 * order -- `Z` against `a`, `a-b` against `a_b`, `README` against `assets`,
 * `INV-a` against `inv-a`, `/records/10` against `/records/2` -- pushes them
 * through the real entry point, and asserts the exact emitted sequence. The
 * disagreement is asserted in the test itself, which is what makes each case a
 * case at all rather than a coincidence.
 *
 * The sites, and where each is pinned:
 *
 * 1. the unknown-limit walk in `validateLimits`
 * 2. the known-limit list in that same diagnostic (an equivalent site: see below)
 * 3. the unknown-option walk in `reconcileExports`
 * 4. the final findings sort in `buildReport`
 * 5. the key walk order in `reconcileSides`
 * 6. the duplicate record listing and its cut-off (an equivalent site under a
 *    plain collator, and pinned against a numeric one: see below)
 * 7. the missing-key-field list in `compileRecords`
 * 8. the colliding-key list in the case-collision rule
 *
 * Site 4 carries three further cases, because the comparator it uses is not
 * one comparison but five -- file, pointer, rule id, message, evidence -- and
 * `Array.prototype.sort` is stable, so a component that never decides anything
 * in the fixtures can be deleted with the suite still green. Each of those
 * cases builds findings that tie on every component before the one under test
 * and are emitted in the order that component has to overturn.
 */

const collator = new Intl.Collator('en')
const numeric = new Intl.Collator('en', { numeric: true })

test('site 1: which unknown limit is named first follows code units', async () => {
  assert.equal(collator.compare('Zebra', 'apple') > 0, true, 'the disagreement being pinned')

  await assert.rejects(
    () => reconcileExports({ root: '.', limits: { apple: 1, Zebra: 1 } }),
    (error) => {
      assert.match(error.message, /^Unknown limit "Zebra"/, 'a collator would name "apple" first')
      return true
    },
  )
})

test('site 2: the known-limit list is an equivalent site, proven over every ordered pair', () => {
  // Every documented limit name is lower camel case over [A-Za-z], and no two
  // of them are ordered differently by a collator than by code unit. There is
  // therefore no input that can tell the two comparators apart here, and this
  // site is reported as an equivalent mutant rather than pretended to be
  // pinned. The proof is exhaustive over the real values, not an assertion
  // about them.
  const names = [
    'maxFieldLength', 'maxFields', 'maxFileBytes', 'maxFindings',
    'maxKeyFields', 'maxKeys', 'maxRecords', 'maxRecordsPerKey',
  ]
  let compared = 0
  for (const left of names) {
    for (const right of names) {
      if (left === right) continue
      compared += 1
      const byUnit = left < right ? -1 : 1
      assert.equal(Math.sign(collator.compare(left, right)), byUnit, `${left} vs ${right}`)
      assert.equal(Math.sign(numeric.compare(left, right)), byUnit, `${left} vs ${right}, numeric`)
    }
  }
  assert.equal(compared, 56, 'every ordered pair of the eight real limit names')
})

test('site 3: which unknown option is named first follows code units', async () => {
  await assert.rejects(
    () => reconcileExports({ root: '.', apple: 1, Zebra: 1 }),
    (error) => {
      assert.match(error.message, /^Unknown option "Zebra"/, 'a collator would name "apple" first')
      return true
    },
  )
})

test('site 4: findings from one record sort by pointer, by code unit', async () => {
  assert.equal(collator.compare('a-b', 'a_b') > 0, true, 'the disagreement being pinned')

  const fields = [
    { name: 'a_b', type: 'string' },
    { name: 'a-b', type: 'string' },
  ]
  const report = await apiReport(fixture(
    [{ invoiceId: 'INV-1', 'a-b': 'left', a_b: 'left' }],
    [{ invoiceId: 'INV-1', 'a-b': 'right', a_b: 'right' }],
    fields,
  ))

  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    ['/records/0/a-b', '/records/0/a_b'],
    'a collator puts a_b first; the plan declares a_b first too, so neither the collator nor the input order can produce this',
  )
})

test('site 4: record pointers sort by code unit and not numerically', async () => {
  const records = []
  for (let index = 0; index <= 10; index += 1) records.push(row({ invoiceId: `INV-${index}` }))
  const report = await apiReport(fixture(records, []))

  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    [
      '/records/0', '/records/1', '/records/10', '/records/2', '/records/3',
      '/records/4', '/records/5', '/records/6', '/records/7', '/records/8', '/records/9',
    ],
  )
  assert.equal(numeric.compare('/records/10', '/records/2') > 0, true, 'a numeric collator would read "better" and order differently')
})

test('site 4: the three input files sort into one documented order', async () => {
  const report = await apiReport({
    'reconciliation.json': planOf([AMOUNT], ['Reference']),
    'source.json': sideOf([{ Reference: 'R-1', amount: '1.00' }, { amount: '2.00' }]),
    'destination.json': sideOf([{ Reference: 'R-2', amount: '1.00' }]),
  })

  assert.deepEqual(
    [...new Set(report.findings.map((finding) => finding.location.file))],
    ['destination.json', 'source.json'],
  )
})

/**
 * The last two components of the documented sort key -- message, then
 * evidence -- which the three before them can hide.
 *
 * `Array.prototype.sort` is stable, so a component decides nothing unless two
 * findings tie on every component before it *and* were emitted in the other
 * order. Three case-collision findings tie on file, pointer and rule id by
 * construction: all of them land at `reconciliation.json/key`. They are
 * emitted in key-walk order, which runs over the JSON-encoded key -- `["0",..`
 * then `["A!",..` then `["A",..`, because `!` sorts before the quote that ends
 * a shorter component -- and the emitted sequence below is none of that:
 *
 * - the three-key group is emitted **first** and sorts **last**, because "2
 *   join keys" precedes "3 join keys" in its message;
 * - the two two-key groups tie on message to the character, so evidence alone
 *   separates them, and it reads the *display* form, where ` | ` joins the
 *   components: `A | Z` sorts before `A! | Z` exactly where the walk put
 *   `A!` first.
 */
test('site 4: findings tied on file, pointer and rule id sort by message, then evidence', async () => {
  const keys = [['0', 'BB'], ['0', 'Bb'], ['0', 'bb'], ['A!', 'Z'], ['a!', 'z'], ['A', 'Z'], ['a', 'z']]
  const report = await apiReport({
    'reconciliation.json': planOf([AMOUNT], ['a', 'b']),
    'source.json': sideOf(keys.map(([a, b]) => ({ a, b, amount: '10.00' }))),
    'destination.json': sideOf([]),
  })
  const collisions = findingsFor(report, 'key-case-collision')

  assert.deepEqual(
    collisions.map((finding) => finding.evidence),
    ['keys: A | Z, a | z', 'keys: A! | Z, a! | z', 'keys: 0 | BB, 0 | Bb, 0 | bb'],
    'the groups were emitted in the order 0, A!, A',
  )
  assert.equal(
    new Set(collisions.map((finding) => `${finding.location.file}${finding.location.pointer} ${finding.ruleId}`)).size,
    1,
    'all three tie on file, pointer and rule id, so nothing earlier in the key can decide this',
  )
  assert.equal(
    new Set(collisions.slice(0, 2).map((finding) => finding.message)).size,
    1,
    'the two two-key groups tie on message as well, so the pair is separated by evidence alone',
  )
})

/**
 * The rule-id component, which the message after it can stand in for.
 *
 * Nearly every pair of findings that ties on file and pointer is ordered the
 * same way by its rule id and by its message, so dropping the rule-id
 * comparison changes nothing and no assertion can see it go. One pair is not:
 * two inputs that are one file on disk, where that file is also not JSON. Both
 * findings land at `destination.json` with an empty pointer and both messages
 * open with that same file name, after which `and` precedes `is` -- so the
 * message orders them `inputs-are-one-file` first while the rule id orders
 * them `input-not-json` first, and only the rule id is allowed to decide.
 */
test('site 4: findings tied on file and pointer sort by rule id, not by message', async () => {
  const report = await withRoot(
    { 'reconciliation.json': planOf([AMOUNT]), 'source.json': '{ not json' },
    async (root) => {
      // A hard link is two names for one inode, and the file is not JSON, so
      // both rules fire against the second name.
      await link(join(root, 'source.json'), join(root, 'destination.json'))
      return reconcileExports({ root })
    },
  )

  assert.deepEqual(
    report.findings.map((finding) => `${finding.location.file}${finding.location.pointer} ${finding.ruleId}`),
    [
      'destination.json input-not-json',
      'destination.json inputs-are-one-file',
      'source.json input-not-json',
    ],
  )
  const [first, second] = report.findings
  assert.equal(first.message > second.message, true, 'by message alone the other one would come first')
})

test('site 5: the key walk order decides which keys a cut-off reaches', async () => {
  for (const [first, second, third] of [['Zebra', 'apple', 'beta'], ['README', 'assets', 'build']]) {
    assert.equal(collator.compare(first, second) > 0, true, `a collator would reach ${second} before ${first}`)

    const report = await apiReport(
      fixture([row({ invoiceId: second }), row({ invoiceId: third }), row({ invoiceId: first })], []),
      { limits: { maxKeys: 2 } },
    )

    const stopped = findingsFor(report, 'too-many-keys')
    assert.equal(stopped.length, 1)
    assert.equal(
      stopped[0].message.includes(`the walk stopped at key "${third}"`),
      true,
      `the walk must stop at the third key in code-unit order, not at ${first}`,
    )
    const named = findingsFor(report, 'record-missing-in-destination')
      .map((finding) => /^Key "([^"]+)"/.exec(finding.message)[1])
      .sort()
    assert.deepEqual(named, [first, second].sort(), `${third} was never walked, so its absence is not reported`)
    assert.equal(report.summary.checked, 2)
    assert.equal(report.summary.unevaluated, 1)
  }
})

test('site 6: over record pointers a plain collator is equivalent, proven over every ordered pair', () => {
  // The duplicate listing only ever holds "/records/<index>", so its whole
  // alphabet after a fixed prefix is the ASCII digits, over which plain
  // collation and code-unit order cannot disagree. Rather than claim this site
  // is pinned against a plain collator, the equivalence is proven exhaustively
  // over the real values; the drift that *is* reachable here is a numeric
  // collator, and the next test pins the emitted sequence against one.
  const pointers = []
  for (let index = 0; index <= 40; index += 1) pointers.push(`/records/${index}`)
  let compared = 0
  for (const left of pointers) {
    for (const right of pointers) {
      if (left === right) continue
      compared += 1
      assert.equal(Math.sign(collator.compare(left, right)), left < right ? -1 : 1, `${left} vs ${right}`)
    }
  }
  assert.equal(compared, 1640, 'every ordered pair of the first forty-one record pointers')
})

test('site 6: the duplicate listing and its cut-off follow code units, not numbers', async () => {
  const rows = []
  for (let index = 0; index <= 10; index += 1) rows.push(row({ invoiceId: 'INV-1', amount: `${index}.00` }))
  const report = await apiReport(fixture(rows, [row({ invoiceId: 'INV-1' })]))

  assert.equal(
    findingsFor(report, 'duplicate-key-in-source')[0].evidence,
    'records: /records/0, /records/1, /records/10, /records/2, /records/3, /records/4, /records/5, /records/6, /records/7, /records/8, /records/9',
  )

  const bounded = await apiReport(fixture(rows, [row({ invoiceId: 'INV-1' })]), { limits: { maxRecordsPerKey: 3 } })
  assert.equal(findingsFor(bounded, 'duplicate-key-in-source')[0].evidence, 'records: /records/0, /records/1, /records/10')
  assert.equal(
    findingsFor(bounded, 'too-many-records-for-key')[0].message.includes('the listing stopped at /records/2'),
    true,
    'a numeric collator would have listed 0, 1, 2 and stopped at /records/3',
  )
})

test('site 7: the missing key fields are named in code-unit order', async () => {
  assert.equal(collator.compare('Reference', 'account') > 0, true, 'the disagreement being pinned')

  const report = await apiReport({
    'reconciliation.json': planOf([AMOUNT], ['account', 'Reference']),
    'source.json': sideOf([{ amount: '1.00' }]),
    'destination.json': sideOf([]),
  })

  assert.equal(findingsFor(report, 'record-key-missing')[0].evidence, 'missing key fields: Reference, account')
})

test('site 8: colliding keys are named in code-unit order', async () => {
  assert.equal(collator.compare('INV-a', 'inv-a') > 0, true, 'the disagreement being pinned')

  const report = await apiReport(fixture(
    [row({ invoiceId: 'inv-a' }), row({ invoiceId: 'INV-a' })],
    [row({ invoiceId: 'inv-a' }), row({ invoiceId: 'INV-a' })],
  ))

  const collision = findingsFor(report, 'key-case-collision')[0]
  assert.equal(collision.evidence, 'keys: INV-a, inv-a')
  assert.equal(collision.severity, 'warning')
})

test('two runs over one root produce byte-identical stdout', async () => {
  const files = fixture(
    [row({ invoiceId: 'Zebra' }), row({ invoiceId: 'apple', amount: '2.00' }), row({ invoiceId: 'README' })],
    [row({ invoiceId: 'apple' }), row({ invoiceId: 'assets' })],
  )
  const [first, second] = await withRoot(files, async (root) => [
    JSON.stringify(await reconcileExports({ root })),
    JSON.stringify(await reconcileExports({ root })),
  ])
  assert.equal(first, second)
  assert.equal(raisedRules(JSON.parse(first)).length > 0, true, 'the report being compared is not empty')
})
