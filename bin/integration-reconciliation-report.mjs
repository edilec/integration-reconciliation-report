#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_DESTINATION_NAME,
  DEFAULT_PLAN_NAME,
  DEFAULT_SOURCE_NAME,
  excerpt,
  exitCodeFor,
  formatReport,
  reconcileExports,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `integration-reconciliation-report

Join two exported sides by a declared stable key, compare declared fields under
declared normalisation, and report matched, missing, duplicated and conflicting
records. Nothing is fetched: the two exports and the plan are the whole of the
evidence.

Usage:
  integration-reconciliation-report --root DIR [--plan FILE] [--source FILE]
                                    [--destination FILE] [--json]
                                    [--max-file-bytes N] [--max-records N]
                                    [--max-keys N] [--max-records-per-key N]
                                    [--max-fields N] [--max-key-fields N]
                                    [--max-field-length N] [--max-findings N]

Options:
  --root DIR                Directory holding the plan and both exports (required)
  --plan FILE               Reconciliation plan, relative to --root
                            (default ${DEFAULT_PLAN_NAME})
  --source FILE             Source export, relative to --root
                            (default ${DEFAULT_SOURCE_NAME})
  --destination FILE        Destination export, relative to --root
                            (default ${DEFAULT_DESTINATION_NAME})
  --json                    Suppress the human summary on stderr
  --max-file-bytes N        Maximum bytes per input file (default 5242880)
  --max-records N           Maximum records per export (default 20000)
  --max-keys N              Maximum distinct join keys (default 20000)
  --max-records-per-key N   Maximum records named in one duplicate group (default 100)
  --max-fields N            Maximum compared fields in the plan (default 50)
  --max-key-fields N        Maximum fields forming the join key (default 8)
  --max-field-length N      Maximum characters in a compared string (default 1024)
  --max-findings N          Maximum findings in one report (default 1000)
  -h, --help                Show this help
  -v, --version             Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  Every key present on either side was decided, and every decided key matched
  on every declared field at the declared precision, timezone and granularity.
  It is not a statement about fields the plan does not declare, about rows that
  carry no join key, or about whether the declared precision is the right one.
  A key whose comparison needed evidence the export does not carry is reported
  as unevaluated and makes the run incomplete -- never a match.

Exit codes:
  0  reconciled, and nothing broke
  1  reconciled, and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-field-length', 'maxFieldLength'],
  ['--max-fields', 'maxFields'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-key-fields', 'maxKeyFields'],
  ['--max-keys', 'maxKeys'],
  ['--max-records', 'maxRecords'],
  ['--max-records-per-key', 'maxRecordsPerKey'],
])

const VALUE_FLAGS = new Map([
  ['--destination', 'destination'],
  ['--plan', 'plan'],
  ['--root', 'root'],
  ['--source', 'source'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, plan: null, source: null, destination: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--source a --source b` reconciles a file nobody named and
   * `--max-records 5 --max-records 50000` enforces a bound nobody asked for.
   * That is the same defect as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await reconcileExports({
      root: options.root,
      limits: options.limits,
      ...(options.plan === null ? {} : { plan: options.plan }),
      ...(options.source === null ? {} : { source: options.source }),
      ...(options.destination === null ? {} : { destination: options.destination }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and the
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) {
    process.stderr.write(formatReport(report, {
      plan: options.plan ?? DEFAULT_PLAN_NAME,
      source: options.source ?? DEFAULT_SOURCE_NAME,
      destination: options.destination ?? DEFAULT_DESTINATION_NAME,
    }))
  }
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.keys} key(s) were decided; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
