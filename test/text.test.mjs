import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXCERPT_LIMIT, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue,
  excerpt, hasForbiddenCharacter, isIdentifier, isPlainObject,
} from '../src/index.mjs'
import { FORBIDDEN } from './support.mjs'

test('byCodeUnit orders by UTF-16 code unit, which is where collation would differ', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.equal(byCodeUnit('b', 'a') > 0, true)
})

test('excerpt collapses whitespace, strips every forbidden class and bounds the result', () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const cleaned = excerpt(`before${character}after`)
    assert.equal(hasForbiddenCharacter(cleaned), false, `${name} survived`)
    assert.equal(cleaned.includes('before'), true)
    assert.equal(cleaned.includes('after'), true)
  }
  assert.equal(excerpt('  a \t\n b  '), 'a b')
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT + 10)).length, EXCERPT_LIMIT + 3)
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT + 10)).endsWith('...'), true)
  assert.equal(excerpt('short'), 'short')
})

test('an identifier refuses every forbidden class outright rather than cleaning it', () => {
  assert.equal(isIdentifier('INV-1001'), true)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH)), true)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH + 1)), false)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier(' INV-1'), false)
  assert.equal(isIdentifier('INV-1 '), false)
  assert.equal(isIdentifier(42), false)
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(isIdentifier(`INV${character}1`), false, `${name} was accepted`)
  }
})

/**
 * The classes above are necessary and not sufficient.
 *
 * `excerpt` collapses every run of whitespace to one space, and JavaScript's
 * `\s` is wider than the ASCII three. Four distinct keys that differ only by
 * which space they carry all printed `INV- 1`, so the report named one key
 * four times while grouping four -- through characters none of the four
 * refused classes covers.
 */
test('an identifier must print as it was written, so no space the report would collapse', () => {
  const collapsing = {
    'no-break space': String.fromCharCode(0x00a0),
    'figure space': String.fromCharCode(0x2007),
    'ideographic space': String.fromCharCode(0x3000),
    'zero width no-break space': String.fromCharCode(0xfeff),
    'narrow no-break space': String.fromCharCode(0x202f),
    tab: String.fromCharCode(0x09),
  }
  for (const [name, character] of Object.entries(collapsing)) {
    const key = `INV-${character}1`
    assert.equal(excerpt(key), 'INV- 1', `${name} does not print as written`)
    assert.equal(isIdentifier(key), false, `${name} was accepted`)
  }
  assert.equal(isIdentifier('INV-  1'), false, 'a doubled space prints as one')

  for (const good of ['INV-1001', 'INV- 1', 'INV 1 A', 'facture n.12']) {
    assert.equal(isIdentifier(good), true, `${good} was refused`)
    assert.equal(excerpt(good), good, `${good} does not print as written`)
  }
})

test('ordinary right-to-left text is not an override and is left alone', () => {
  const hebrew = 'INV-אב'
  assert.equal(isIdentifier(hebrew), true)
  assert.equal(excerpt(hebrew), hebrew)
})

test('decoding is the decoder\'s decision, never an inference from the decoded text', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x61, 0x62])), { ok: true, text: 'ab' })
  assert.equal(decodeUtf8(new Uint8Array([0xff])).ok, false)
  assert.equal(decodeUtf8(new Uint8Array([0xc3, 0x28])).ok, false)
  // A file that legitimately holds U+FFFD decodes; only the bytes decide.
  const replacement = new TextEncoder().encode('{"a":"�"}')
  assert.equal(decodeUtf8(replacement).ok, true)
})

test('describeValue names a shape and reproduces no content', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(7.5), 'a number')
  assert.equal(describeValue('4111111111111111'), 'a string of 16 character(s)')
  assert.equal(describeValue([1, 2]), 'an array of 2 item(s)')
  assert.equal(describeValue({}), 'an object')
  assert.equal(describeValue('secret').includes('secret'), false)
})

test('isPlainObject refuses arrays, null and dressed-up instances', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Map()), false)
})
