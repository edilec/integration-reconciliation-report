/**
 * Decoding, sanitising, ordering, identifiers and value description.
 *
 * Nothing here touches the filesystem, the network, the locale or the clock.
 * Every value this module handles arrived in a file the tool did not write, so
 * every value it returns is treated as data on its way to a report -- never as
 * something that can shape a line of output.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Locale-aware comparison -- the string method and the collator class alike --
 * depends on ICU data that differs between Node builds and between hosts, and
 * both treat punctuation as ignorable: under collation `INV-1` and `INV_1`
 * swap places depending on where the tool runs, and `Z` sorts after `a`. A
 * reconciliation report that is only deterministic on one machine is not
 * deterministic, so every order this tool exposes is decided here.
 *
 * Neither spelling appears anywhere in this package, and a scan for one of
 * them is not a determinism test: substituting the collator class collates
 * identically and spells differently. `test/ordering.test.mjs` pins the
 * emitted order for inputs that the two comparators genuinely disagree about,
 * one call site at a time.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the JavaScript parser, and
 * the rest are invisible in an editor. Spelling each one keeps this file plain
 * ASCII and keeps the list readable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in
 *   the human report; ESC opens a terminal escape sequence; NUL truncates a
 *   value in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two of them
 *   do the same damage unaided: U+0085 NEL is a line break to a great many
 *   consumers, and U+009B is the 8-bit CSI, a terminal control introducer that
 *   needs no ESC in front of it.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a join key can be displayed as something other than the value
 *   that was grouped and compared. Ordinary right-to-left text -- Arabic,
 *   Hebrew -- needs none of these: the letters carry their own direction, so
 *   refusing the overrides refuses nothing legitimate.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- join keys,
 * field names, field values, file names, pointers, messages, suggestions and
 * evidence alike, not only an excerpt field. Tab, newline and carriage return
 * are left out of this class deliberately: `excerpt` collapses them into a
 * single space in the very next step, which is the same result by a shorter
 * route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What an identifier may not contain: the same four classes, plus the three
 * ASCII whitespace controls `CONTROL` leaves to the collapse. An identifier
 * gets no second pass, and a join key that prints differently from the value
 * that was grouped is a key nobody can reconcile by hand.
 *
 * This class is necessary and it is not sufficient: `isIdentifier` also
 * requires the value to survive `excerpt` unchanged, which is the property
 * this comment is really claiming. See there.
 */
const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * Detects any of the four classes anywhere in a string. Exported so tests can
 * walk a whole report and assert that nothing survived, rather than checking
 * the one field a developer remembered.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN_IN_IDENTIFIER.test(String(value))
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 200

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every join key, field name, value excerpt, path, pointer, message and piece
 * of evidence that reaches a finding goes through here. A tool in this catalog
 * sanitised its evidence carefully and left its identifiers raw, so a record
 * id holding a newline printed two lines into the human report and invented a
 * finding that was never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Join key components are this tool's vocabulary: they are grouped, compared,
 * counted and then printed. A control character in one of them is refused at
 * the door rather than cleaned up on the way out, because a value that prints
 * differently from the value that was grouped cannot be checked by the person
 * reading the report -- and a right-to-left override inside an invoice number
 * makes two different keys look like the same one.
 *
 * The four refused classes are not the whole of that promise. `excerpt` also
 * collapses every run of whitespace to a single space, and `\s` is wider than
 * the ASCII three: U+00A0 NO-BREAK SPACE, U+2007 FIGURE SPACE, U+3000
 * IDEOGRAPHIC SPACE and U+FEFF ZERO WIDTH NO-BREAK SPACE all match it, and so
 * does a second ordinary space. Accepting one of those grouped four distinct
 * keys and printed `INV- 1` four times -- the exact defect the classes above
 * exist to prevent, arriving through a character nobody thinks of as a
 * control.
 *
 * So the promise is enforced rather than approximated: an identifier must be
 * what `excerpt` will print of it, character for character. Legitimate text is
 * untouched -- letters of any script, digits, punctuation and single interior
 * spaces all survive `excerpt` unchanged and are accepted.
 */
export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (FORBIDDEN_IN_IDENTIFIER.test(value)) return false
  return excerpt(value, MAX_IDENTIFIER_LENGTH) === value
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field is arbitrary content from an export this tool did not
 * write, and the report goes to stdout -- a stream that is piped, logged and
 * pasted somewhere more public than the export ever was. Echoing the value
 * back ("received \"4111111111111111\"") hands that content a wider audience
 * than it had, and it does so on exactly the fields whose validation exists to
 * keep a payload, an account number or a personal detail out of the report.
 *
 * The pointer on the finding already names the exact position in the file, so
 * the shape is all a reader needs from the report itself; the value is in the
 * file, where it started.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Say why a document would not parse, without reproducing any of it.
 *
 * `describeValue` above keeps a refused field value out of the report; this
 * keeps a refused *document* out of it, and the error path is where that guard
 * was missing. V8 reports a parse failure two ways, and one of them quotes the
 * input: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. An
 * export or a plan short enough to be only a credential is therefore
 * reproduced in full by its own error message, and a longer one is reproduced
 * ten characters at a time -- a window around the offending character, drawn
 * from wherever in the document that character sits.
 *
 * `excerpt` does not help. It strips control characters and cuts from the
 * *end*; the quoted span is at the front of the message, so it survives and
 * the position is what gets lost.
 *
 * The quoted form carries no position, so nothing diagnostic is lost by
 * reducing it to the offending token. The other form is all position and no
 * input, and is kept. The quoted window never leaves this function.
 *
 * The quoted form is matched first on purpose: an export whose own bytes read
 * `at position 12` would otherwise be sliced after its own quoted copy.
 */
export function parseFailureDetail(error) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const token = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s.exec(message)
  if (token) {
    const where = token[2] === undefined ? ' near the start' : ''
    return `unexpected token ${excerpt(token[1], 8)}${where}`
  }
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
  if (position) return message.slice(0, position.index + position[0].length)
  if (/^Unexpected end of JSON input$/.test(message)) return message
  return 'it could not be parsed as JSON'
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains
 * a replacement character, and that confusion has let an unread input report a
 * pass in this catalog. The decoder decides; the decoded text never gets a
 * vote.
 *
 * Every file this tool opens goes through here -- the reconciliation plan
 * included. The plan is configuration that happens to live in a file, and the
 * configuration path is exactly where a sibling tool hardened its data path
 * and forgot.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
