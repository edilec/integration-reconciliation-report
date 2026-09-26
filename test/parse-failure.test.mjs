/**
 * What a `JSON.parse` failure may not reproduce.
 *
 * `describeValue` keeps a refused field value out of the report on purpose --
 * an export this tool did not write goes to stdout, a stream that is piped,
 * logged and pasted somewhere more public than the export ever was. The error
 * path had no such guard. V8 reports a parse failure two ways and one of them
 * quotes the input: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid
 * JSON`. So an export or a plan short enough to be only a credential was
 * reproduced in full by `input-not-json`, on stdout, in both output modes.
 *
 * `excerpt` does not catch it: it strips control characters and cuts from the
 * end, while the quoted span sits at the *front* of the message.
 *
 * `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder, not a key.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { AMOUNT, cliRun, fixture, findingsFor, row, withRoot } from './support.mjs'

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

// Longer than V8's ten-character window, so a leak is a prefix rather than the
// whole string. Truncating the message would not have caught this one.
const LONG_SECRET = 'password=hunter2-correct-horse-battery-staple'

const MIN_RUN = 8

/**
 * Assert that no run of `secret` eight characters or longer survives.
 *
 * Every run, not only every prefix: V8 quotes a window around the offending
 * character, so a secret in the middle of a document leaks from its middle.
 * Asserting only on the whole string would pass against a report that printed
 * `AKIAIOSF` and called that truncation.
 */
function assertNoLeak(secret, ...streams) {
  const haystack = streams.join('\n')
  for (let length = secret.length; length >= MIN_RUN; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const window = secret.slice(start, start + length)
      assert.equal(haystack.includes(window), false, `output echoed ${JSON.stringify(window)}`)
    }
  }
}

/** Run the real binary over a root whose named file has been replaced with raw text. */
async function runWith(name, text) {
  const files = { ...fixture([row()], [row()], [AMOUNT]), [name]: text }
  return withRoot(files, async (root) => cliRun(['--root', root, '--json']))
}

test('an export that is only a credential is not quoted back into the report', async () => {
  const { stdout, stderr } = await runWith('source.json', CANARY)
  const report = JSON.parse(stdout)
  assert.equal(findingsFor(report, 'input-not-json').length, 1)
  assertNoLeak(CANARY, stdout, stderr)
})

test('a plan that is only a credential is not quoted back into the report', async () => {
  const { stdout, stderr } = await runWith('reconciliation.json', CANARY)
  const report = JSON.parse(stdout)
  assert.equal(findingsFor(report, 'input-not-json').length, 1)
  assertNoLeak(CANARY, stdout, stderr)
})

test('the human report does not quote it back either', async () => {
  const files = { ...fixture([row()], [row()], [AMOUNT]), 'source.json': CANARY }
  const { stdout, stderr } = await withRoot(files, async (root) => cliRun(['--root', root]))
  assert.match(stdout, /input-not-json/)
  assertNoLeak(CANARY, stdout, stderr)
})

test("a secret longer than V8's quoting window does not leak its prefix either", async () => {
  const { stdout, stderr } = await runWith('source.json', LONG_SECRET)
  assertNoLeak(LONG_SECRET, stdout, stderr)
  assert.equal(stdout.includes('password=h'), false)
})

test('a secret sitting mid-document does not leak through the windowed form', async () => {
  // V8 answers this one with `Unexpected token '}', "[ }AKIAIOSFO"...`: the
  // shape that quotes a window rather than a leading prefix.
  const { stdout, stderr } = await runWith('source.json', `[ }${CANARY}]`)
  assertNoLeak(CANARY, stdout, stderr)
})

test('the position, line and column of a parse failure survive the fix', async () => {
  const { stdout } = await runWith('source.json', '{"schemaVersion": "1" "records": []}')
  const [finding] = findingsFor(JSON.parse(stdout), 'input-not-json')
  assert.match(finding.message, /at position 22 \(line 1 column 23\)/)
})

test('a parse failure still names the token: a detail that says nothing is its own defect', async () => {
  const { stdout } = await runWith('source.json', CANARY)
  const [finding] = findingsFor(JSON.parse(stdout), 'input-not-json')
  assert.match(finding.message, /unexpected token 'A'/)
})

test('parseFailureDetail keeps the position and drops the quoted window', () => {
  const detail = (text) => {
    try {
      JSON.parse(text)
      throw new Error('that text parsed')
    } catch (error) {
      return parseFailureDetail(error)
    }
  }

  // The positional form is all position and no input, and is kept whole.
  assert.equal(
    detail('{"schemaVersion": "1" "records": []}'),
    "Expected ',' or '}' after property value in JSON at position 22 (line 1 column 23)",
  )
  assert.equal(detail('{"a":1}x'), 'Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)')
  assert.equal(detail(''), 'Unexpected end of JSON input')
  assert.equal(detail('[1,2,'), 'Unexpected end of JSON input')

  // Every quoted shape: the whole input, a leading prefix, and a window.
  assert.equal(detail(CANARY), "unexpected token 'A' near the start")
  assert.equal(detail(LONG_SECRET), "unexpected token 'p' near the start")
  assert.equal(detail(`[ }${CANARY}]`), "unexpected token '}' near the start")
  assert.equal(detail(`{"aaaaaaaaaaaaaa": [ }${CANARY} ]}`), "unexpected token '}'")
})

test('parseFailureDetail refuses a document whose own bytes imitate a position', () => {
  // The quoted form is matched first for exactly this reason.
  let detail
  try {
    JSON.parse(`at position 12 ${CANARY}`)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assertNoLeak(CANARY, detail)
  assert.equal(detail.includes('at position 12'), false)
})

test('parseFailureDetail strips a control character that arrives as the token', () => {
  // V8 names the offending character, and that character came from the input.
  let detail
  try {
    JSON.parse(String.fromCharCode(0x1b))
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail.includes(String.fromCharCode(0x1b)), false)
})

test('parseFailureDetail says something for an error it does not recognise', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('something else entirely')), 'it could not be parsed as JSON')
})
