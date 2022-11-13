# integration-reconciliation-report

Join two exported sides by a declared stable key, compare declared fields under
declared normalisation, and report **matched**, **missing**, **duplicated** and
**conflicting** records.

Two promises, because both are usually broken:

- **A duplicated key never overwrites itself.** Records are grouped, not
  indexed into a last-write-wins map. Two rows sharing a key produce a reported
  duplication — not a clean-looking match over whichever row was read last.
- **Nothing is rounded and no float is compared.** Amounts are compared as
  integer minor units at a declared precision; timestamps at a declared fixed
  offset and granularity. A value that does not fit the declaration is reported
  as unevaluated, never quietly made to fit.

The tool opens no socket and calls no provider. Two exported files and a plan
are the whole of the evidence.

- **Repository:** [edilec/integration-reconciliation-report](https://github.com/edilec/integration-reconciliation-report)
- **License:** MIT
- **Runtime:** Node 22 or later, no dependencies

## Install

```sh
npm install integration-reconciliation-report
```

Or run it from a checkout with no install step at all — the package has no
runtime and no development dependencies.

## Use

```sh
integration-reconciliation-report --root examples/clean
integration-reconciliation-report --root examples/broken --json | jq '.findings[].ruleId'
```

The JSON report goes to stdout and nothing else does, so stdout pipes straight
into a parser. The human summary and every diagnostic go to stderr; `--json`
suppresses the summary.

```
plan reconciliation.json: 3 field(s) compared under the declared normalisation.
source source.json: 6 record(s). destination destination.json: 5 record(s). 0 not indexed.
join: 6 key(s), 1 matched, 2 conflicting, 1 duplicated, 1 missing in destination, 1 missing in source, 0 unevaluated. status fail.
```

As a library:

```js
import { reconcileExports, exitCodeFor, formatReport } from 'integration-reconciliation-report'

const report = await reconcileExports({ root: 'examples/broken' })
process.stderr.write(formatReport(report))
process.exitCode = exitCodeFor(report)
```

### Exit codes

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | reconciled, and nothing broke | the report |
| `1` | reconciled, and at least one error-severity rule fired | the report |
| `2` | invalid configuration or bad usage | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

A consumer that pipes stdout must handle an empty stdout on exit 2: a
configuration error means the run never had a subject, so there is nothing to
report about. An input that could not be read *did* have a subject, so that run
emits an `incomplete` report naming the input it could not obtain.

## The three inputs

All three live inside one declared root, and all three must be distinct files.

`reconciliation.json` — the plan:

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

`source.json` and `destination.json` — the two exported sides:

```json
{
  "schemaVersion": "1",
  "records": [
    { "invoiceId": "INV-1001", "amount": "1250.00", "currency": "INR",
      "postedAt": "2026-03-01T20:30:00Z", "status": "Posted" }
  ]
}
```

Properties the plan does not mention are data and are left alone. Unknown keys
in the plan or in an export *envelope* are refused by name: a one-character
typo that silently disabled a comparison would turn a real break into a green
run.

Field types are `amount`, `date`, `integer` and `string`. The full schema,
including which keys each type accepts, is in
[`docs/reconciliation-rules.md`](./docs/reconciliation-rules.md).

## What it reports

Each key present on either side gets exactly one outcome — `matched`,
`conflicting`, `duplicated`, `missingInDestination` or `missingInSource` — and
a fifth state is reported as itself rather than folded into one of them: a key
whose comparison needed evidence the export does not carry is **unevaluated**,
and makes the run `incomplete`.

Some rules worth knowing before the first run:

- `duplicate-key-in-source` / `duplicate-key-in-destination` name **every** row
  in the group. A duplicated key is not compared, because it has no single
  value to compare.
- `amount-not-exact` refuses a JSON number with a fractional part. `10.1` in a
  file is the binary double nearest 10.1; quote it and it compares exactly.
- `amount-exceeds-declared-precision` refuses a significant digit beyond the
  declared precision rather than rounding it away.
- `date-offset-missing` refuses a timestamp with no UTC offset, because it
  names a different instant for every reader.
- `plan-timezone-unsupported` refuses a named IANA zone. Only fixed offsets are
  supported, and an unsupported declaration makes the run incomplete rather
  than being silently treated as UTC.
- `key-case-collision` warns when two keys differ only by letter case — one
  system upper-casing its identifiers is a classic silent merge.
- `inputs-are-one-file` refuses two names for one inode. A hard link has no
  target, so a path comparison cannot see it, and a file joined against itself
  matches every key.

## Limits and non-goals

**What a `pass` means.** Every key present on either side was decided, and every
decided key agreed on every declared field at the declared precision, timezone
and granularity. That is all it means.

**What this tool cannot conclude:**

- It cannot show that two systems agree. It compares the fields the plan
  declares in the files it was given. A column neither export carries is not
  evidence, and a column the plan does not name is not compared.
- It cannot tell you whether the declared precision, timezone or granularity is
  the *right* one. Declaring `day` granularity makes two postings eleven hours
  apart equal; that is the declaration's doing, not a discovery.
- It cannot tell a missing record from a record that was never exported. Both
  sides are files. What the systems actually hold is not visible from here.
- It cannot decide which row of a duplicated group is authoritative. It reports
  the duplication and keeps every row; choosing between them is a business
  decision.
- It does no fuzzy matching, no similarity scoring and no transitive
  reconciliation. Two rows join when their declared key components are equal as
  text, and not otherwise.
- It does not support named IANA timezones. A named zone is reported as
  `plan-timezone-unsupported`, nothing is compared on that field and the run is
  `incomplete`. A leap second is a separate matter: `23:59:60` is not an
  instant this tool can place, so it is refused as `date-invalid` — a refusal
  of that one value, not support for the leap-second calendar.
- It knows no currency's minor unit. An amount is compared at the precision the
  plan declares and at no other, and `currencyField` only checks that both
  sides carry the same three-letter code. A currency whose smallest unit is not
  a power of ten — MGA and MRU are fifths — is compared at the declared
  precision like every other, and nothing reports it.
- It reads no database, calls no API and opens no socket. There is no "pull the
  live side" mode.
- It is read-only and writes nothing. A run leaves its root byte-identical.

## Guarantees, and what holds them

- **A duplicated key is never resolved by overwrite.** Every record for a key is
  kept. `test/duplicates.test.mjs` is built so that both the keep-the-first and
  the keep-the-last variants fail it: each case asserts `duplicated`, `matched`
  and `conflicting` together, and asserts that a group of *n* rows names *n*
  pointers — which no map keyed by the join key can produce.
- **No float takes part in a comparison.** Amounts are `BigInt` minor units.
  Two amounts that are one binary double apart are still told apart, and a
  fractional JSON number is refused rather than compared.
- **Nothing is rounded silently.** An over-precise amount is refused with a
  finding; the run is incomplete, not a match and not a break.
- **The declared timezone decides.** The same instant in two zones is one
  bucket; two instants an hour apart are one day in `+05:30` and two days in
  `Z`, and the tests assert both.
- **`pass` is never reported on evidence that was not obtained**, and `pass`
  with `checked: 0` is not reachable. Every site that marks a run `incomplete`
  has a test asserting the status and the process exit code, so removing one
  turns exit 2 into exit 1 and fails.
- **Severity is pinned behaviourally.** One frozen `ruleId -> severity` table
  feeds every finding and an unknown rule id throws; the table is asserted
  against the documented catalog in both directions. Those are declarations, and
  a coordinated edit agrees with itself — so every rule is *also* pinned by
  running the real binary: the exit code where severity alone decides the
  verdict, and a literal error count plus the printed severity word where the
  run is incomplete either way. `test/severity-word.test.mjs` shares no map, no
  table and no builder with anything else.
- **Ordering is pinned behaviourally, at every site.** A scan for
  `.localeCompare(` is not a determinism test — `Intl.Collator` collates
  identically and spells differently. `test/ordering.test.mjs` has a case for
  each of the eight places this tool orders something, using values the two
  comparators genuinely disagree about, and asserts the exact emitted sequence.
- **Every untrusted string is sanitised** — join keys, field names, paths,
  pointers, messages, suggestions and evidence alike — of C0, DEL, the whole C1
  range, U+2028, U+2029 and the bidi controls. A key carrying one of them is
  refused outright rather than cleaned up.
- **Every documented limit is enforced and tested from both sides**, and every
  flag is driven through the real binary so none can be documented and ignored.
- **Nothing opens a socket, reads a clock, reads a random source or reads the
  environment.**

## Verify

```sh
npm run check
```

Lint with `node --check` over every file, the `node:test` suite, the runnable
clean example, and a pack dry run. No network access and no install step.

## License

MIT. See [LICENSE](./LICENSE).
