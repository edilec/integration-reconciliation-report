# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a reconciliation plan — a declared join key of 1 to 8 components and a list
  of compared fields typed `amount`, `date`, `integer` or `string` — compiled
  from data, with every unknown key refused by name at both levels, including a
  key that is valid for a different field type, and a field that did not
  compile counted as uncompared rather than passed over;
- key grouping that **keeps every record**. Indexing into a last-write-wins map
  is the defining bug of a reconciliation tool: the second row for a key
  silently replaces the first, the group looks like a clean one-to-one match,
  and the duplicate is never reported. Every row is kept, the duplication is an
  error, and the group is not compared — a duplicated key has no single value
  to compare;
- amount comparison in integer minor units at a declared precision, on
  `BigInt`, so no floating-point value takes part. A JSON number with a
  fractional part is refused as the binary double it actually is; a significant
  digit beyond the declared precision is refused rather than rounded away;
  trailing zeros beyond the precision discard nothing and are accepted;
- date comparison as the bucket an instant falls in, at a declared fixed offset
  and granularity. The same instant written in two zones is one bucket at every
  granularity; two different instants are one day in `+05:30` and two days in
  `Z`. A timestamp with no offset is refused, a date with no time part is
  accepted only at `day` granularity, and the calendar is checked
  arithmetically, so `2026-02-29` is refused rather than rolled forward;
- named IANA timezones reported as **unsupported** rather than approximated:
  resolving one needs a tz database with daylight-saving history that this
  package does not carry, so the field is not compared, the rule fires and the
  run is `incomplete` — never silently treated as UTC;
- the four outcomes — matched, missing on either side, duplicated and
  conflicting — plus an explicit fifth state: a key whose comparison needed
  evidence the export does not carry is *unevaluated*, which is neither a match
  nor a break and makes the run incomplete;
- `amount-currency-conflict`, so two amounts are never declared equal across two
  currencies, and `key-case-collision`, so two keys that differ only by letter
  case are named before one system's upper-casing merges them;
- `field-match-after-normalization` and `duplicate-values-identical`, so a
  green run is not read as a claim that the two exports were spelled the same
  way, and a duplicated group that agrees with itself still says it is
  duplicated;
- `inputs-are-one-file`, which compares device and inode numbers rather than
  paths. `realpath` resolves a symbolic link, but a hard link has no target:
  two names for one inode are two distinct real paths, and a file joined
  against itself matches every key;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })` on all
  three inputs, the plan included — the configuration path is exactly where a
  sibling tool hardened its data path and forgot;
- real-path confinement on both sides for all three inputs, so a symbolic link
  planted inside the root is refused unread and a root reached through a link
  is not falsely refused; a name carrying `..` or an absolute path is refused
  earlier still, as a usage error with an empty stdout;
- explicit file-byte, record, key, per-key-group, field, key-component,
  field-length and finding limits, each reported by name when hit and each
  making the run `incomplete` instead of truncating. The key walk and the
  duplicate listing each name the first entry they did not reach;
- sanitisation of every untrusted string that reaches output — join keys, field
  names, paths, pointers, messages and suggestions as well as `evidence`, and
  an unknown CLI option on its way to stderr — covering C0 and DEL, the whole
  C1 range (U+0085 NEL forges a line of its own, U+009B is the 8-bit CSI),
  U+2028 and U+2029, and the bidi and isolate controls U+200E, U+200F,
  U+202A–U+202E and U+2066–U+2069, which are also refused inside a join key.
  Ordinary right-to-left letters are untouched: they carry their own direction
  and need no override;
- a CLI with `--help`, `--version`, `--json`, `--plan`, `--source`,
  `--destination` and the eight limit flags, the report on stdout, diagnostics
  on stderr, exit codes 0 / 1 / 2 with an empty stdout for a configuration
  error and an `incomplete` report for evidence that could not be obtained, and
  a repeated value-carrying flag refused instead of silently overwriting the
  earlier value;
- runnable `examples/clean`, `examples/broken` and `examples/incomplete` roots
  that exit 0, 1 and 2; the clean one demonstrates the same instant written in
  two zones, an amount written three ways, and a status that matches only after
  the declared trim and case fold;
- the rule catalog, both schemas, the normalisation rules, the ordering rule,
  the limits, the exit codes and the list of things this tool cannot conclude
  in `docs/reconciliation-rules.md`.

### Guaranteed

- Nothing in this package opens a socket, reads a clock, reads a random source
  or reads the environment. There is no "pull the live side" mode: the two
  exports are the only evidence there is.
- The tool is read-only. Nothing under `src/` or `bin/` writes, appends,
  renames or removes a file, and a run leaves its root byte-identical.
- A duplicated key is never resolved by overwrite. `test/duplicates.test.mjs`
  is built so that both the keep-the-first and the keep-the-last variants fail
  it, and so that a group of *n* rows must name *n* pointers.
- `pass` is never reported on evidence that was not obtained, and `pass` with
  `checked: 0` is not reachable. Every site that marks a run `incomplete` has a
  test that asserts the status and the process exit code, so removing one turns
  exit 2 into exit 1 and fails.
- Every finding takes its severity from one frozen `ruleId -> severity` table;
  an unknown rule id throws, and the table is asserted against the documented
  catalog in both directions. Those are declarations, and a coordinated edit
  agrees with itself, so every rule is also pinned by behaviour: a real input
  through the real binary, asserting the rules raised, the status and the exit
  code where severity alone decides the verdict, and a literal error count and
  the printed severity word where the run is incomplete either way.
  `test/severity-word.test.mjs` shares no map, no table and no builder with
  anything else in the suite.
- No wall clock, locale-aware comparison, random source, network access or
  filesystem enumeration order affects the output. Ordering is pinned by
  asserting the emitted sequence at six of the eight sites that order
  something, for inputs a collator orders the other way round; the two sites
  whose real values make both comparators identical -- the known-limit list and
  the record listing inside a duplicated group -- are proven equivalent over
  every ordered pair rather than claimed to be pinned, and the listing is
  pinned against a numeric collator, which its values *can* tell apart.
- This tool can show that two exports disagree. It cannot show that two systems
  agree, and it does not claim otherwise. `README.md` and
  `docs/reconciliation-rules.md` both state what a `pass` does and does not
  mean.

No release has been published.
