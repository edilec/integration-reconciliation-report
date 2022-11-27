# Rule catalog, schemas and limits

`integration-reconciliation-report` joins two exported sides by a declared
stable key, compares declared fields under declared normalisation, and reports
matched, missing, duplicated and conflicting records.

It reads three files inside one declared root and opens no socket. Two exports
and a plan are the whole of the evidence.

- `reconciliation.json` — the plan: the join key, and how each compared field
  is normalised.
- `source.json` — one exported side.
- `destination.json` — the other exported side.

All three names are defaults; `--plan`, `--source` and `--destination` change
them, and all three must be distinct files inside `--root`.

## What this tool can and cannot conclude

**It can show** that two exports disagree: a key on one side and not the other,
a key carried by more than one row on a side, or a declared field whose two
values are not equal once normalised at the declared precision, timezone and
granularity.

**It cannot show** that two systems agree. In particular:

- A `pass` is a statement about the fields the plan declares, and about nothing
  else. A column neither export mentions is not evidence; a column the plan
  does not name is not compared.
- A `pass` is not a statement that the declared precision, timezone or
  granularity is the *right* one. Declaring `day` granularity makes two
  postings eleven hours apart equal, and that is the declaration's doing.
- It cannot tell a missing record from a record that was never exported. Both
  sides are files; what the systems actually hold is not visible from here.
- It cannot decide which row of a duplicated group is authoritative. It reports
  the duplication and keeps every row.
- It does no fuzzy matching. Two rows join when their declared key components
  are equal as text, and not otherwise.
- It is read-only. A run leaves its root byte-identical.

## The plan

```json
{
  "schemaVersion": "1",
  "key": ["invoiceId"],
  "fields": [
    { "name": "amount", "type": "amount", "precision": 2, "currencyField": "currency" },
    { "name": "postedAt", "type": "date", "timezone": "+05:30", "granularity": "day" },
    { "name": "status", "type": "string", "trim": true, "caseSensitive": false }
  ]
}
```

- `schemaVersion` must be the string `"1"`.
- `key` is 1 to `maxKeyFields` field names. Every record must carry all of
  them; a record that does not is reported and is not joined.
- `fields` is 1 to `maxFields` field specifications. An empty list is refused:
  a key that matched on no field at all would be green on no evidence.

A field `name` is a literal property of a record — 1 to 64 characters of
letters, digits, `.`, `-` or `_`, starting with a letter or a digit. A dot
means a dot: field names are never paths, and nested objects are not reached
into.

Unknown keys are refused by name, at the top level and inside every field
specification, including a key that is valid for a different type. A key field
may not also appear in `fields`: both sides hold the same value there by
construction, so comparing it proves nothing.

### Field types

| `type` | Accepted keys | Compared as |
| --- | --- | --- |
| `amount` | `name`, `type`, `precision`, `currencyField` | integer minor units at `precision` |
| `date` | `name`, `type`, `timezone`, `granularity` | the bucket the instant falls in |
| `integer` | `name`, `type` | an exact integer |
| `string` | `name`, `type`, `trim`, `caseSensitive`, `collapseWhitespace` | text after the declared normalisation |

`precision` is an integer from 0 to 8. `timezone` is a fixed offset: `Z`,
`+HH:MM` or `-HH:MM`, at most ±14:00. `granularity` is `instant`, `minute`,
`hour` or `day`. `trim` defaults to `true`, `caseSensitive` to `true`,
`collapseWhitespace` to `false`.

## The two exports

```json
{
  "schemaVersion": "1",
  "records": [
    { "invoiceId": "INV-1001", "amount": "1250.00", "currency": "INR", "postedAt": "2026-03-01T20:30:00Z", "status": "Posted" }
  ]
}
```

The envelope accepts `schemaVersion` and `records` and nothing else. Inside a
record, properties the plan does not mention are data and are left alone — an
export carries whatever columns it carries.

A key component may be a string or a JSON integer; an integer is rendered as
its exact decimal string, so `4711` and `"4711"` are one key. It must then be a
usable identifier: 1 to 200 characters, none of the control, separator or bidi
characters listed under *Sanitisation*, and nothing else the report would have
to change on the way out. In practice that last condition refuses whitespace
the rendering collapses — a tab, a doubled space, and the spaces outside ASCII
such as U+00A0, U+2007, U+3000 and U+FEFF — because four keys that differ only
by which space they carry would otherwise be grouped as four and printed as
one. A single ordinary space between characters is fine.

## Normalisation

### Amounts

Compared as **integer minor units** at the declared precision, using arbitrary-
precision integers. No floating-point value takes part in a comparison.

- `"10.5"`, `"10.50"` and `"10.500"` are one amount at precision 2. Trailing
  zeros beyond the precision discard nothing and are accepted.
- A JSON **integer** is accepted and scaled exactly: `4200` is `"4200.00"` at
  precision 2.
- A JSON number with a **fractional part** is refused (`amount-not-exact`).
  `10.1` in a file is the binary double nearest to 10.1, and comparing two of
  those invents one-cent breaks and hides real ones. Quote the value and it is
  compared exactly.
- A value with a **significant** digit beyond the declared precision is refused
  (`amount-exceeds-declared-precision`). Nothing is rounded: whether `10.005`
  and `10.004` are the same amount at two places is a decision that belongs in
  the plan.
- `currencyField`, when declared, must be present on both sides and hold a
  three-letter uppercase code. Two amounts in different currencies are a
  conflict, never a match.

### Dates

Compared as the **bucket** the instant falls in, in the declared zone at the
declared granularity.

- The bucket is computed from the instant, so the same instant written two ways
  — `2026-03-01T20:30:00Z` and `2026-03-02T02:00:00+05:30` — is one bucket at
  every granularity.
- The declared timezone decides where a day begins. `2026-03-01T20:30:00Z` and
  `2026-03-02T04:00:00Z` are one day in `+05:30` and two days in `Z`.
- A value with **no offset** is refused (`date-offset-missing`): it names a
  different instant for every reader.
- A value with **no time part** is accepted only at `day` granularity, where it
  means that calendar day in the declared zone. At any finer granularity it is
  refused rather than assumed to be midnight.
- The calendar is checked arithmetically, so `2026-02-29` is refused rather
  than rolled forward to 1 March.
- Years outside 1970–2100 are refused.

**Named zones are not supported.** Resolving `Asia/Kolkata` correctly needs a
tz database with daylight-saving history, which this package does not carry and
will not approximate. A named zone is reported as
`plan-timezone-unsupported`, the run is `incomplete`, and nothing is compared
on that field. It is never silently treated as UTC.

### Strings and integers

A string is trimmed, optionally whitespace-collapsed and optionally case-folded
(with the locale-independent lower-casing, never the locale-aware one), and
then compared as text. An integer is compared exactly, from a JSON integer or a
quoted one; a fractional number is refused.

## The join and the four outcomes

Records are grouped by their key. **Every record for a key is kept.** A
reconciliation tool that indexes records into a last-write-wins map loses a row
every time two share a key, reports a clean one-to-one outcome over whichever
row was read last, and never mentions the duplicate. That does not happen here,
and `test/duplicates.test.mjs` is built so that both the keep-the-first and the
keep-the-last variants fail it.

Each key present on either side gets exactly one outcome:

| Outcome | When |
| --- | --- |
| `duplicated` | more than one record for the key on a side |
| `missingInDestination` | one record in the source, none in the destination |
| `missingInSource` | one record in the destination, none in the source |
| `conflicting` | one on each side, and at least one declared field not equal |
| `matched` | one on each side, and every declared field equal |

A fifth state is reported as itself rather than folded into one of the four: a
key whose comparison needed evidence the export does not carry — an absent
field, an amount written as a float, a timestamp with no offset — is
**unevaluated**. It is not a match, it is not a break, and it makes the run
`incomplete`. Unknown evidence is never a pass.

Duplication takes precedence: a duplicated key is not compared, because a
duplicated key has no single value to compare. The finding names how many
records the other side holds.

## Rule catalog

Severity is taken from one frozen `ruleId -> severity` table in
`src/index.mjs`; an unknown rule id throws. This catalog is asserted against
that table in both directions. That is a check on the documentation, not a pin
on behaviour: every error rule is additionally pinned by running the real
binary and asserting the observable consequence — the process exit code where
severity alone decides the verdict, and the error count together with the
printed severity word where the run is incomplete either way.

| ruleId | severity | What it reports |
| --- | --- | --- |
| `amount-currency-conflict` | error | one key carries an amount in two different currencies |
| `amount-exceeds-declared-precision` | error | an amount has a significant digit beyond the declared precision; nothing was rounded |
| `amount-invalid` | error | an amount is not a decimal this tool can read exactly |
| `amount-not-exact` | error | an amount is a JSON number with a fractional part, so it is a binary double |
| `date-invalid` | error | a timestamp is not a real instant, or not usable at the declared granularity |
| `date-offset-missing` | error | a timestamp carries no UTC offset, so it names no single instant |
| `duplicate-key-in-destination` | error | more than one destination record carries one key |
| `duplicate-key-in-source` | error | more than one source record carries one key |
| `duplicate-values-identical` | info | the records in a duplicated group agree on every declared field |
| `field-evidence-missing` | error | a declared field is absent from one side, so the two were not compared |
| `field-match-after-normalization` | info | the two sides agree only after the declared normalisation was applied |
| `field-value-conflict` | error | a declared field normalises to two different values |
| `field-value-invalid` | error | a value is not of the shape the declared field type reads |
| `field-value-too-long` | error | a compared string is above `maxFieldLength` |
| `identifier-invalid` | error | a key component is not a printable identifier of 1–200 characters |
| `input-not-json` | error | an input decoded but is not JSON |
| `input-not-utf8` | error | an input is not valid UTF-8 and was not parsed |
| `input-too-large` | error | an input is above `maxFileBytes` and was not read |
| `input-unreadable` | error | an input could not be inspected, resolved or read |
| `inputs-are-one-file` | error | two of the three inputs are two names for one file on disk |
| `key-case-collision` | warning | two join keys differ only by letter case |
| `no-fields-declared` | error | the plan declares no field to compare |
| `no-records-evaluated` | error | the join decided no key at all, so a pass would be green on nothing |
| `path-escapes-root` | error | an input resolves outside `--root` and was refused unread |
| `plan-field-duplicate` | error | a field or key component is declared twice |
| `plan-field-invalid` | error | a field specification is malformed, or declares a key its type does not accept |
| `plan-granularity-unsupported` | error | a date field declares a granularity this tool does not support |
| `plan-invalid` | error | the plan is not an object, or its shape is wrong |
| `plan-key-unknown` | error | the plan declares a top-level key that does not exist |
| `plan-timezone-unsupported` | error | a date field declares a timezone that is not a fixed offset |
| `plan-type-unsupported` | error | a field declares a type this tool does not support |
| `record-invalid` | error | a record is not an object and was not indexed |
| `record-key-missing` | error | a record does not carry every declared key component |
| `record-missing-in-destination` | error | a key is in the source export and not the destination |
| `record-missing-in-source` | error | a key is in the destination export and not the source |
| `records-invalid` | error | an export is not an object, or its envelope is wrong |
| `too-many-fields` | error | the plan declares more fields than `maxFields` |
| `too-many-findings` | error | the run produced more findings than `maxFindings`; the report is partial |
| `too-many-key-fields` | error | the plan declares more key components than `maxKeyFields` |
| `too-many-keys` | error | the two exports hold more distinct keys than `maxKeys` |
| `too-many-records` | error | an export holds more records than `maxRecords` |
| `too-many-records-for-key` | error | a duplicated group holds more records than `maxRecordsPerKey` can name |

## Report, ordering and exit codes

stdout carries the JSON report and nothing else. stderr carries the human
summary and every diagnostic; a non-empty stderr is normal.

```json
{
  "schemaVersion": "1",
  "tool": "integration-reconciliation-report",
  "status": "pass",
  "summary": {
    "checked": 3, "errors": 0, "warnings": 0, "fields": 3,
    "sourceRecords": 3, "destinationRecords": 3, "unindexed": 0,
    "keys": 3, "matched": 3, "conflicting": 0, "duplicated": 0,
    "missingInDestination": 0, "missingInSource": 0, "unevaluated": 0
  },
  "findings": []
}
```

`checked` counts keys given a definite outcome. `unevaluated` counts keys the
run could not decide, plus keys a `maxKeys` cut-off never reached.

Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then
`message`, then `evidence` — **by UTF-16 code unit** throughout, never by
locale collation. Every other order the report exposes follows the same rule:
the key walk, the record listing inside a duplicated group, the missing-key
list, the colliding-key list and the diagnostics naming an unknown limit or
option. Running the tool twice over identical inputs produces byte-identical
stdout.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | reconciled, and nothing broke | the report |
| `1` | reconciled, and at least one error-severity rule fired | the report |
| `2` | invalid configuration or bad usage | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

### Sanitisation

Every untrusted string that reaches output — key components, field names, file
names, pointers, messages, suggestions and evidence — is stripped of C0
(U+0000–U+001F), DEL (U+007F), C1 (U+0080–U+009F), U+2028, U+2029 and the bidi
controls U+200E, U+200F, U+202A–U+202E and U+2066–U+2069, then collapsed to one
line and bounded. A key component carrying any of them is refused outright
rather than cleaned up, because a key that prints differently from the value
that was grouped cannot be reconciled by hand — and so is a key carrying
whitespace the collapse would alter. What is accepted as a key component is
printed verbatim and at its full length, never truncated to a shorter one.
Ordinary right-to-left text is untouched: letters carry their own direction and
need no override.

Stripping is not enough for one message, so a parse failure is reported by
position rather than by quotation. `JSON.parse` has two error messages and one
of them embeds the input — `Unexpected token 'A', "AKIA…" is not valid JSON`
for a short document, and a ten-character window around the offending character
for a long one. An export or a plan short enough to be only a credential would
otherwise be reproduced by its own error message, and the bound does not help:
the quoted span is at the front of the message while the bound cuts from the
back. `parseFailureDetail` keeps the position, line and column — which carry no
input — and drops the quotation, the same principle as `describeValue` applied
to a whole document instead of one field.

## Limits

Every limit is enforced, and exceeding one produces a finding naming it and
makes the run `incomplete`. Nothing is silently truncated. A caller may lower a
limit but not raise it past the hard cap; an unknown limit key is a
configuration error with an empty stdout.

| Limit | Flag | Default | Hard cap | What it bounds |
| --- | --- | ---: | ---: | --- |
| `maxFileBytes` | `--max-file-bytes` | 5242880 | 67108864 | bytes per input file |
| `maxRecords` | `--max-records` | 20000 | 500000 | records per export |
| `maxKeys` | `--max-keys` | 20000 | 500000 | distinct join keys |
| `maxRecordsPerKey` | `--max-records-per-key` | 100 | 10000 | records named in one duplicated group |
| `maxFields` | `--max-fields` | 50 | 500 | compared fields in the plan |
| `maxKeyFields` | `--max-key-fields` | 8 | 32 | components of the join key |
| `maxFieldLength` | `--max-field-length` | 1024 | 65536 | characters in a compared string |
| `maxFindings` | `--max-findings` | 1000 | 20000 | findings in one report |

A key component is additionally bounded at 200 characters, a field name at 64,
an amount at 18 integer and 18 fractional digits, and a year to 1970–2100.
