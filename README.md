# TraceRoot CLI

Set up [TraceRoot](https://traceroot.ai) in your repository, then work with your
traces, findings, detectors and evaluations from the terminal.

## Set up a repository

Run this from the root of the repository you want to trace:

```sh
npx -y traceroot-cli@latest setup
```

Setup signs you in, picks or creates a project, writes a project API key into your
application's env file, has Claude Code or Codex add the TraceRoot SDK, and waits for
the first trace. It needs Node.js 20.12 or later; every other command runs on 20.3.

- Using another coding agent? Pass `--no-instrument` and setup writes the change out
  as a task for it to run.
- Self-hosting? Point setup at your deployment with `--host` (the API origin) and
  `--auth-host` (the web app origin).

See the [setup guide](https://traceroot.ai/docs/tracing/get-started) for each step and
for troubleshooting, and the [CLI guide](https://traceroot.ai/docs/cli/get-started#run-without-prompts)
to run it without prompts. `setup --help` lists every option.

If a run stops partway, ask setup what went wrong, then continue from where it stopped:

```sh
npx -y traceroot-cli@latest setup doctor
npx -y traceroot-cli@latest setup --resume
```

## Install

```sh
npx -y traceroot-cli@latest --help   # run without installing
npm install -g traceroot-cli         # or install the `traceroot` command
```

## Quick start

Once your application sends traces, the rest of the CLI works with them:

```sh
traceroot login                       # sign in with your browser (device flow)
traceroot status                      # confirm who you are
traceroot projects list               # find a project id to scope reads to
traceroot traces list --project <id> --limit 10   # list recent traces
traceroot traces get <trace-id> --project <id>    # inspect one
traceroot traces export <trace-id> --project <id> # export its bundle to a directory
traceroot detectors list --project <id>           # list your detectors (copy a detector id)
traceroot findings list --since 24h --project <id> # list recent detector findings
traceroot evals list --project <id>               # list your evaluations (copy an evaluation id)
traceroot logout                      # revoke the session and clear the credential
```

Set `TRACEROOT_PROJECT_ID` (or `project_id` in the config file) once instead of
repeating `--project`. With a project API key the project is fixed by the key,
so `--project` is unnecessary:

```sh
traceroot login --api-key tr-...      # key mode: validates, saves ./.traceroot/config.json
traceroot traces list --limit 10
```

## Configuration

The CLI authenticates with either a **browser login** (a session credential
stored in `~/.config/traceroot/credentials.json`, exchanged for a short-lived
access token before every request) or a **project API key** (`tr-...`, sent
directly). The credential resolves in this priority order:

1. `--api-key` flag (API key)
2. Env file — `--env-file <path>` (`TRACEROOT_TOKEN`, then `TRACEROOT_API_KEY`)
3. `TRACEROOT_TOKEN` env var (session token)
4. Credentials file — `~/.config/traceroot/credentials.json`, keyed by host
5. `TRACEROOT_API_KEY` env var
6. Config file — `./.traceroot/config.json`
7. Auto-discovered `./.env`

The host resolves independently (`--host` > env file > `TRACEROOT_HOST_URL` >
config > `./.env`) and defaults to `https://app.traceroot.ai`. Split dev setups
(web app and API on different ports) can point login/token-mint at the web app
with `--auth-host` / `TRACEROOT_AUTH_URL`.

`traceroot login` runs the browser device flow by default and stores the session
credential (`0600`) in your home config directory; with `--api-key` it validates
the key, then writes `./.traceroot/config.json` (`0600`, auto-gitignored).
Override the paths with `TRACEROOT_CREDENTIALS_PATH` / `TRACEROOT_CONFIG_PATH`.
For CI or scripts, prefer a project API key via env vars or flags:

```sh
export TRACEROOT_API_KEY=tr-...
export TRACEROOT_HOST_URL=https://app.traceroot.ai
traceroot traces list
```

> Your API key and session token are secrets. The CLI only ever prints a masked
> hint and keeps its files out of git — don't paste them into shared terminals.

### Project scoping

A browser login identifies *you*, not a project, so project-scoped reads
(traces, detectors, findings, datasets, evals) need a project id: `--project <id>` >
`TRACEROOT_PROJECT_ID` > `project_id` in the config file. Run
`traceroot projects list` to find one. On a browser login, `traceroot setup`
saves the project it sets up as `project_id` there. API keys are already
project-scoped and need none of this.

## Commands

| Command | Description |
| :-- | :-- |
| `setup` | Connect this repository to TraceRoot and see your first trace. `--project <name-or-id>`, `--agent <agent>`, `--no-instrument`, `--manual`, `--language <language>`, `--service <path>`, `--no-browser`, `--resume`, `--no-input`, `--trace-timeout <seconds>` |
| `setup doctor` | Diagnose a setup run that did not complete: the `doctor` checks, plus how far the run got and what stopped it. `--service <path>` |
| `login` | Sign in with the browser (device flow) and store the session credential; with `--api-key`, validate and save the key instead. |
| `logout` | Revoke the session server-side (best-effort) and remove the local credential. |
| `status` | Show the identity your credentials resolve to — email/workspaces (browser login) or workspace/project/key hint (API key), plus host and source. |
| `workspaces list` | List the workspaces you can access (browser login only). |
| `projects list` | List the projects you can access, across workspaces; the `PROJECT ID` column is what `--project` takes. `--workspace-id <id>` |
| `traces list` | List traces for your project, newest first. `--limit <n>`, `--since <dur>`, `--from`/`--to` (for field filters, use `sql`) |
| `traces get <id>` | Show one trace: span tree, derived duration, and a link to open it. Defaults to the lightweight `skeleton` projection (no per-span input/output/metadata); pass `--fields full` (or `--fields io,metadata`) to fetch span I/O. `--fields <groups>` |
| `traces export <id>` | Write a trace bundle (`trace.json`, `spans.json`, `git_context.json`, `manifest.json`) to a directory. Defaults to the `full` projection (span input/output/metadata included); pass `--fields <groups>` to narrow it. `--output <dir>`, `--force`, `--fields <groups>` |
| `detectors list` | List your project's detectors, newest first. The `DETECTOR ID` column is what you pass to `findings list --detector`. `--limit <n>`, `--since <dur>`, `--from`/`--to` |
| `detectors get <id>` | Show one detector. |
| `findings list` | List detector findings for your project, newest first. `--limit <n>`, `--since <dur>`, `--from`/`--to`, `--detector <id>`, `--trace <id>` |
| `findings get [id]` | Show one finding: per-detector results and its free-text RCA. Look it up by finding id or with `--trace <id>` (exactly one). |
| `alerts list` | List the project's threshold alerts with their status, severity and rule. `--limit <n>`, `--page <n>`, `--search <q>` |
| `alerts get <id>` | Show one alert's full rule, filters, renotify and evaluation state. |
| `alerts create` | Create a threshold alert. Takes the rule as JSON: `--from-file <path>` (or `-` for stdin), with flags overriding single fields. |
| `alerts update <id>` | Edit an alert's rule. Fields left out are untouched; editing an evaluated field resets the alert's evaluation state. `--from-file <path>`, plus a flag per rule field |
| `alerts status <id>` | Pause or resume an alert without touching its rule. `--status <ACTIVE\|PAUSED>` |
| `alerts delete <id>` | Permanently delete an alert. `--reason <text>` (3–500 characters, recorded on the audit row) |
| `dashboards list` | List the project's dashboards. |
| `dashboards get <id>` | Show one dashboard. |
| `dashboards create` | Create a dashboard. `--from-file <path>`, `--name`, `--description` |
| `dashboards update <id>` | Rename a dashboard or change its description. `--from-file <path>`, `--name`, `--description` |
| `dashboards delete <id>` | Permanently delete a dashboard and its widgets. `--reason <text>` |
| `widgets get <id>` | Show one saved widget: its title, type and the query spec exactly as stored. |
| `widgets data <id>` | Answer a saved widget for a window, without re-sending its spec. `--range <preset>`, `--start-time`/`--end-time` |
| `widgets create` | Add a widget to a dashboard. `--from-file <path>`, `--dashboard-id`, `--title`, `--type`, `--spec` |
| `widgets update <id>` | Edit a widget's title, spec or display config. A sent spec replaces the whole spec. `--from-file <path>`, `--title`, `--spec`, `--display-config` |
| `widgets delete <id>` | Permanently delete one widget from its dashboard. `--reason <text>` |
| `detectors create` | Create a detector. `--from-file <path>`, `--name`, `--template`, `--prompt` |
| `detectors update <id>` | Edit a detector: prompt, enabled, sampling, RCA, output schema or trigger conditions. `--from-file <path>`, `--name`, `--prompt`, `--enabled`, `--sample-rate`, … |
| `detectors delete <id>` | Permanently delete a detector; its findings stay readable. `--reason <text>` |
| `projects create` | Create a project in a workspace. `--from-file <path>`, `--name`, `--workspace-id` |
| `projects update <id>` | Rename a project or set its trace retention. Requires ADMIN. `--from-file <path>`, `--name`, `--trace-ttl-days` |
| `projects delete <id>` | Delete a project; its API keys stop authenticating. Requires ADMIN. `--reason <text>` |
| `workspaces create` | Create a workspace. `--from-file <path>`, `--name` |
| `workspaces update <id>` | Rename a workspace you administer. `--from-file <path>`, `--name` |
| `workspaces delete <id>` | Permanently delete a workspace and everything in it. Not reversible. `--name <current-name>` (typed as confirmation), `--reason <text>` |
| `sql [query]` | Run one read-only SQL query over your project's spans and traces. Prints a table, CSV with `--csv`, or JSON with `--json`. `--file <path>`, `--param <name=value>`, `--max-rows <n>`, `--output <file>` |
| `sql schema` | List the tables and columns a query may reference, with their types. |
| `datasets list` | List the project's evaluation datasets, newest first, with each one's current published version. `--limit <n>`, `--cursor <cursor>`, `--name <substring>` |
| `datasets get <id>` | Show one dataset: name, key, description, and the version its cases are read from. A dataset with nothing published says so. |
| `datasets versions list <dataset-id>` | List a dataset's published versions, newest first, with each one's case count; `*` marks the current one. `--limit <n>`, `--cursor <cursor>` |
| `datasets versions get <version-id>` | Show one immutable version and one page of its test cases (input, expected, and the trace a case was captured from) — 200 by default, up to 1000. `--limit <n>`, `--cursor <cursor>` |
| `evals list` | List the project's evaluations, newest first: how many runs each has and how its latest one ended. The `EVALUATION ID` column is what `evals runs list --evaluation-id` takes. `--limit <n>`, `--cursor <cursor>`, `--name <substring>` |
| `evals runs list` | List evaluation runs, newest first, with the id each is read by. The row is identity and outcome only — counts and scores come from `evals runs get`. `--limit <n>`, `--cursor <cursor>`, `--evaluation-id <id>`, `--status <status>` |
| `evals runs get <run-id>` | Show one run: the dataset version it pinned, how its cases came out, its per-scorer means and per-case cost and duration, and a link to open it. |
| `evals run <file>` | Run an evaluation file on this machine with the project's own SDK, save the run, and print each evaluation's run id and score means. With `--baseline`, compare the new run with an earlier one and exit 18 if a case regressed. With `--upload`, also send the run and its traces to TraceRoot. `--baseline <run id or path>`, `--upload` |
| `skills list` | List first-party TraceRoot skills and install status across supported agents. |
| `skills install [skill]` | Copy a bundled skill into an agent's skill directory. Prompts for missing skill/agent in an interactive terminal. `--agent <agent>`, `--force`, `--dry-run` |
| `instrument` | Generate an agent-ready prompt to add TraceRoot tracing to this repo. Prompts for missing agent/output path in an interactive terminal. `--agent <agent>`, `--print`, `--output <path>`, `--force` |
| `doctor` | Diagnose credentials, repo shape, runtime env, installed skills, and any setup run (`pass`/`warn`/`fail`). `--service <path>` |

Add `--json` to any command for a single machine-readable document on stdout;
`setup` writes one JSON event per line instead.
Run `traceroot <command> --help` for the full flag list.
Flags that `--help` shows as `--<flag> [true|false]` take `true` or `false` (`--enabled false`) or `--no-<flag>`, and mean true on their own.
A word right after such a flag is read as its value, so put positional arguments first or write `--<flag>=true`.

### Creating things

Write commands take their whole body as one JSON document, because rules and
specs nest more deeply than flags express comfortably:

```sh
traceroot alerts create --from-file rule.json
jq '.threshold = 2000' rule.json | traceroot alerts create --from-file -
traceroot alerts create --from-file rule.json --threshold 2000
```

Individual flags override fields from the file. Required fields and enum
values are checked locally, so a typo fails immediately as a usage error
(exit 2) rather than as a server rejection (types and nested structure inside a
`--from-file` document are validated by the server, not locally). Under a browser login,
`--project` (or `TRACEROOT_PROJECT_ID`) supplies the project for
project-scoped writes, so the file describes the thing being created, not
where it goes. An API key is already scoped to one project and does not carry
`--project` — pass `--project-id` instead (or set `project_id` in
`--from-file`).

### More examples

```sh
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef --fields full   # include span input/output/metadata
traceroot traces export <trace-id> --output ./out
traceroot traces list --from 2026-06-23T14:00:00Z --to 2026-06-23T20:00:00Z --limit 5 --json | jq '.data[].trace_id'
traceroot detectors list --json | jq '.data[].detector_id'
traceroot findings list --detector <detector-id> --since 7d --json | jq '.data[].finding_id'
traceroot findings get --trace 99224be337d725fd5e8f2e7b45dc22ef
```

### SQL queries

`traceroot sql` runs one read-only `SELECT` against your project's own trace
data. The schema is analytical: `spans` and `traces` with their metric and
dimension columns, while span and trace input and output payloads are not
queryable. `traceroot sql schema` lists every column a query may use.

```sh
# spans in the last 24 hours
traceroot sql "SELECT count() AS spans FROM spans WHERE span_start_time >= now() - INTERVAL 1 DAY"

# p95 latency by model
traceroot sql "SELECT model_name, quantile(0.95)(duration_ms) AS p95_ms FROM spans WHERE model_name IS NOT NULL GROUP BY model_name ORDER BY p95_ms DESC"

# cost by model over the last week
traceroot sql "SELECT model_name, sum(cost) AS total_cost FROM spans WHERE span_start_time >= now() - INTERVAL 7 DAY GROUP BY model_name ORDER BY total_cost DESC"

# export a week of spans to CSV
traceroot sql "SELECT span_id, trace_id, name, duration_ms, model_name, cost FROM spans WHERE span_start_time >= now() - INTERVAL 7 DAY" --csv --output spans.csv

# recent error spans
traceroot sql "SELECT span_id, name, status_message FROM spans WHERE status = 'ERROR' ORDER BY span_start_time DESC LIMIT 100"

# the tables and columns available
traceroot sql schema
```

These output modes are for `traceroot sql`. `traceroot sql schema` prints a
table, or JSON with `--json`, and refuses the query flags.

| Output | How | Notes |
| :-- | :-- | :-- |
| Table | default | Column names as headers, `NULL` for nulls; the row count goes to stderr. |
| CSV | `--csv` | RFC 4180 quoting; nulls are empty cells. Cannot be combined with `--json`. |
| JSON | `--json` | The full response on one line: `columns`, `rows`, `row_count`, `truncated`, `elapsed_ms`. |
| File | `--output <file>` | Writes any of the above to a file instead of stdout. |

Quote the whole query as one argument, or keep it in a file and pass
`--file <path>`. Values for `{name:Type}` placeholders go in `--param name=value`,
once per name. Results are capped by the server: when more rows matched than
were returned, table and CSV output warn on stderr and JSON sets `truncated`.
`--max-rows <n>` asks for fewer rows, never more than the server allows. A
query stopped by a server limit on time, memory, or result size fails with a
hint to narrow it.

### Evaluation reads

Offline evaluations read from the terminal too: the datasets you run against,
the versions of them you published, and the runs that scored them. Start at
`evals list` — a run id used to be reachable only from the web app.

```sh
traceroot evals list                           # what exists, and how each one's latest run ended
traceroot evals runs list --evaluation-id <id> # that evaluation's runs, newest first
traceroot evals runs get <run-id>              # one run: counts, per-scorer means, cost and duration
traceroot evals runs list --status failed --limit 5
```

Datasets read the same way, from the dataset down to the cases in one published
version:

```sh
traceroot datasets list --name triage
traceroot datasets versions list <dataset-id>            # every published version, `*` on the current one
traceroot datasets versions get <version-id> --limit 50  # its cases: input, expected, source trace
traceroot evals runs get <run-id> --json > run.json      # warnings go to stderr, so the file stays valid JSON
```

Four things these reads do deliberately:

- **An absent value prints `—`, never `0`.** A run still going has no scored,
  task-error or scorer-error count yet, and an em dash says so; `0` would claim a
  measurement nobody made. `(none)` is the third case: a thing that exists and
  has no value yet, like a dataset with no published version.
- **Each read returns one page, and says how to read the next.** When more
  matched than came back, the command says so on stderr, in `--json` too, and
  prints the `--cursor` that reads the next page; `--json` also carries it as
  `next_cursor`. The lists return 50 by default and take `--limit` up to 200;
  `datasets versions get` reads 200 cases by default and takes `--limit` up to
  1000.
- **`evals runs get` reports means, not totals.** A numeric score's value is its
  mean over the results that carried it, a boolean score's is the share that came
  back true, and a categorical score has no mean at all. Cost and duration are
  labelled `(mean per case)`: a run's total cost is a different, larger number.
- **A run row carries no scores, counts or cost.** Those are aggregates over one
  run's results, so `evals runs list` stays identity and outcome, and
  `evals runs get` does the arithmetic one run at a time.

Dataset names, case inputs and run URLs are whatever an SDK or a captured trace
stored, so they print with control characters escaped: nothing read back out of
your own data can move the cursor or repaint the terminal.

### Running an evaluation locally

`traceroot evals run` runs one evaluation file on this machine, through the eval
runner of the SDK the project already has, and saves each evaluation's run under
`.traceroot/eval/runs/<run id>.json`. Unless you pass `--upload`, the runner gets
no API key and runs with tracing off, so the run stays on the machine. Run it once,
change the code, and run it again against the first run:

```sh
traceroot evals run evals/triage_eval.py                       # prints the run id and the command to compare with it
traceroot evals run evals/triage_eval.py --baseline <run-id>   # exits 18 if a case regressed
traceroot evals run evals/triage_eval.py --baseline <run-id> --json | jq '.verdict.newly_failing'
```

- **`.py` files** run under the project's virtual environment (`.venv`, `venv` or
  `env` beside the file or at the repository root), then `$VIRTUAL_ENV`, then
  `python3`, with traceroot 0.3.0 or later installed.
- **`.ts`, `.js` and `.mjs` files** run through the project's tsx (4.10.4 or
  later) on Node 20.6 or later, with @traceroot-ai/traceroot 0.8.0 or later.
- **A regression** is a case and scorer pair that passed in the baseline run and
  doesn't pass now, or a case that ran cleanly there and errors now. The summary
  names each one. A score from a new version of its scorer is never a regression:
  it's listed under `changed`, and the summary names each one that passed in the
  baseline run and doesn't now.
- **Two runs are compared only when the comparison means something:** the same
  evaluation over the same dataset, every case run in both, each case id naming
  the same input and expected in both, and no case repeating a score name.
  Otherwise the command exits `2` and says why. A sampled or interrupted baseline
  is refused before the runner starts, so a wrong `--baseline` doesn't cost a run.
- **`--baseline`** takes a run id, read from `.traceroot/eval/runs` under the
  current directory, or the path of a run file.
- **The summary** puts the results first: each evaluation's run id, its case and
  error counts, the mean time a case took (its task and its scorers), and each
  score's mean. Then the regression check, then the run file and case file each
  evaluation saved, then the commands to run next. Without `--baseline` the
  regression check says it was skipped, so an exit `0` there isn't a claim that
  every case passed, and the commands to run next start with the one that
  compares the next run with this one, unless the run can't be a baseline, as a
  sampled or interrupted run can't.
- **On a terminal, the summary fits its width.** Prose wraps at word boundaries
  with a hanging indent. A table too wide for the terminal wraps its last column
  within the cell when that column is prose, such as an error, and there's room
  for it; otherwise it's stacked, each row's values under its first cell. A
  command, a link, a path or an id is never broken or shortened, so each copies
  whole. Piped or redirected output keeps every line whole.
- **Each score's mean says what it is a mean of.** `SCORED` counts the cases that
  gave the score a number or true/false, out of the run's cases: a case whose task
  or scorer raised has none, and any other value is left out of the mean rather
  than read as 0, with a note naming it. A true/false score's mean is the share of
  cases that were true. `PASSED` and `FAILED` come from each value's own verdict,
  and read `—` for a score nothing passes or fails, such as a number from a
  scorer with no threshold: its mean is a measurement in the scorer's units.
- **The cases that raised are listed** with what their task or scorer raised,
  with or without a baseline: the first ten, then a count of the rest, whose
  errors are in the case file. A case the verdict lists as newly errored isn't
  listed twice.
- **While the runner runs, a terminal gets a progress line** at the bottom of
  stderr: the evaluation's name, the cases done, how many are running and how
  many errored, and the time so far. The runner's own output still prints above
  it, line by line, and the line is gone once the run ends. The cases done show
  out of a total only where the SDK's count is the number of cases it runs,
  which traceroot's is; @traceroot-ai/traceroot counts cases an evaluation's
  `select` leaves out, so for TypeScript and JavaScript files the line shows the
  cases done alone. There's no progress line under `--json`, `NO_COLOR`,
  `TERM=dumb` or `CI`, or when stderr isn't a terminal: stderr then carries the
  runner's output as it's written.
- **The runner's output prints as the evaluation writes it**, logs and
  tracebacks included, with two exceptions. An uploaded run's API key prints as
  `<redacted>` wherever it appears. And the SDK's own notice that it found no
  Git repository or commit to link traces to prints as a short warning naming
  what to set on an uploaded run, and is left out of a local run, which sends no
  traces.
- **The line saying what runs** names the file, the SDK and the interpreter's
  version, and for a `.py` file the interpreter it runs under, relative to the
  current directory. `--json` has the interpreter's full path as
  `runtime.executable`.

`--upload` also sends the run and each case's trace to TraceRoot, where the rest
of the team can see it. The run is still saved under `.traceroot/eval/runs`, and
`--baseline` still compares the runs saved there:

```sh
traceroot evals run evals/triage_eval.py --upload   # prints the run's link and the command that opens it
```

- **It takes a project API key:** from `--api-key`, `--env-file`,
  `TRACEROOT_API_KEY`, the config file `traceroot login --api-key` writes, or
  `./.env`, the first that has one. A browser login can't upload, so `--upload`
  uses the key even when you're also signed in through the browser, and exits `3`
  when there's no key.
- **The key is checked before the runner starts.** A key TraceRoot rejects exits
  `3`, and a host it can't reach exits `5`, before any case runs. A check that
  fails another way exits with the shared code for its HTTP status, such as `4`
  for a 404 or `1` for a server error, and nothing runs either way.
- **The cases have to be a `Dataset`.** TraceRoot records an uploaded run against
  a dataset, and the runner publishes a `Dataset` TraceRoot doesn't have yet
  before the run. An evaluation whose cases are a plain list exits `17` before
  any of its cases run.
- **An evaluation whose upload fails saves no run here either**, even when it
  fails after its cases ran, as when TraceRoot can't complete the run. The
  command exits `17` with the runner's message; rerun without `--upload` to check
  the evaluation locally.
- **The evaluations that finished before a failure keep their runs.** In a file
  with several evaluations, a later one failing doesn't undo an earlier one: its
  run stays saved here and uploaded. The summary prints each as for a completed
  run, with the command that opens it, and the `--json` document carries its
  `uploaded_run_id`. The error names it too when what failed was the later
  evaluation's upload, but not after a crash or any other failure.
- **An evaluation that finishes without a TraceRoot run id**, such as one defined
  with `local=True` (`local: true` in TypeScript), is named and exits `17`, unless
  a case regressed, which exits `18`.
- **The summary gives each uploaded run's TraceRoot id and link** beside the
  files it saved, and ends with the command that reads it. The link is the one
  TraceRoot gave the run; a host that gives none gets the id alone. The command is
  `traceroot evals runs get <id> --project <project id>`. It names the key's
  project, so it works under a browser login too. It repeats `--host` and
  `--env-file` when the host or the key came from them, and when the key came
  from `--api-key` it adds `--api-key <key>`, never the key itself. Like the hint
  for a missing key, it's spelled the way the CLI was started: under npx, as
  `npx -y traceroot-cli@<version> …`. Cost and token use come from the run's
  traces, which TraceRoot processes after the upload, so they show there rather
  than in the summary.

The summary goes to stdout and the runner's own output to stderr. Under `--json`,
stdout holds one document whenever the evaluation ran: `schema_version`,
`outcome` (`ok`, `regressed`, `not_comparable`, `not_uploaded`, `interrupted` or
`failed`), the file, the SDK, the `runtime` it ran under (`name`, `version` and
the interpreter's full path as `executable`), `project_id` (the key's project under `--upload`,
otherwise null), each run with its `path` and `cases_path` (its run file and
case file), its counts, `duration_ms` (the mean time a case took, and how many
cases were timed), its `scores` (each with its `mean`, how many cases produced
it as `count`, how many values the mean is over as `mean_count`, and how many
`passed`, `failed` and neither as `unjudged`), `uploaded_run_id` and
`uploaded_run_url` (null unless it was uploaded, and the link null too when
TraceRoot gave none), the baseline, a `verdict` with `newly_failing`
(each with its `reason`), `newly_errored`, `changed`, `not_comparable_reason` and
`payloads`, and `failure`. `failure` is null unless the runner failed after some
evaluations finished; then it holds the failure's `kind` (the runner's own, or
`crashed`) and `message`, the text of the `error:` line human mode prints, and
`outcome` is `failed`, or `regressed` when one of the evaluations that finished
regressed. Case ids, scorer names and the runner's messages print with control
characters escaped, as the evaluation reads' text does.

### Exit codes

Every command exits with a class-specific code so scripts can branch on the kind
of failure — retry a network blip, re-authenticate, or give up on a missing
resource — without parsing prose.

| Code | Class | JSON `code` | Meaning |
| ---- | ----- | ----------- | ------- |
| `0` | success | — | The command completed. |
| `1` | internal | `internal` | Unexpected/internal error (the default when nothing else fits). |
| `2` | usage | `usage` | Invalid arguments or options (bad flag value, unknown agent/skill, missing required input), or input the server rejected (HTTP 400/422). |
| `3` | auth | `auth` | Authentication required or invalid: HTTP 401/403, or no local credentials. |
| `4` | not_found | `not_found` | The requested resource does not exist (HTTP 404). |
| `5` | network | `network` | Network failure or timeout — transient, so a retry may succeed. |
| `6` | conflict | `conflict` | The request conflicts with current state (HTTP 409): a name already taken, a limit reached, something changed since you read it, or a typed confirmation that does not match (`workspaces delete --name`). |

On failure the human-readable message goes to stderr as `error: <message>`. Under
`--json` the failure is written to stderr instead as exactly one line —
`{"error":{"code":"<class>","message":"<text>"}}` — while stdout stays empty, so a
`jq` pipeline over stdout is never corrupted by an error. `evals run` is the one
exception: once its runner has run, its document goes to stdout even when it
exits `2`, `17` or `18`, because the caller needs the new run's id either way.
When it stops before the runner starts, or the runner fails before any evaluation
finishes, it uses the envelope like any other command.

The six classes above belong to the whole CLI and mean the same thing whichever
command handed them back, which is why every number below `10` stays reserved for
them. `setup` has outcomes no other command can produce — the trace never
arrived, the coding agent crashed, the file was already there — so it numbers
those from `10` up rather than overloading one of the shared classes:

| Code | Meaning |
| ---- | ------- |
| `0` | A question answered no. Declining is a decision rather than a fault, so a script that wraps `setup` carries on. |
| `10` | More than one candidate matched and nothing chose between them. |
| `11` | The repository's language or framework is not one `setup` can instrument. |
| `12` | The coding agent ran and exited non-zero. |
| `13` | Reserved. No run returns it, and no other outcome will be given it. |
| `14` | Instrumentation landed, but no trace reached TraceRoot before the deadline. |
| `15` | This TraceRoot deployment is missing an endpoint the step needs; the message names a manual fallback. |
| `16` | Writing would have overwritten something `setup` was not told it could replace. |
| `130` | Ctrl+C or Escape at a prompt. The shell's own status for a run ended by `SIGINT`, not a number this table assigns, and the reason it cannot share the `0` above: `traceroot setup && <next step>` must not run the next step over an abandoned run. |

Besides that `0`, which is the shared success code doing its usual job, the two
numbers `setup` does take from the shared table it takes unchanged: an
unexpected failure is `1`, and a run with no usable credentials is the same `3`
every other command reports, so a caller re-authenticating in response is right
whichever one it came from.

`evals run` numbers its own two outcomes from `17`, after setup's, so a number of
`10` or more means one outcome across the whole CLI. Everything else it returns
is a shared code with its shared meaning, and `17` reads `harness` in the `--json`
envelope:

| Code | Meaning |
| ---- | ------- |
| `0` | Nothing newly fails or newly errors, or no baseline was given. |
| `2` | Invalid arguments, or a baseline the new run can't be compared with: sampled, interrupted, of another evaluation or dataset, or with a case that repeats a score name. The reason is printed. |
| `3` | `--upload` found no project API key, or TraceRoot rejected it. Nothing ran. |
| `4` | The baseline run doesn't exist. |
| `5` | `--upload` couldn't reach TraceRoot. Nothing ran. |
| `17` | The evaluation couldn't run: no interpreter or tsx, an SDK too old to run it, a failure the runner reported, no evaluation in the file, a runner that crashed, or a reader that closed the CLI's output while the runner ran. The message carries the fix, or the runner's own kind and message. With `--upload`, also cases that aren't a `Dataset`, an upload that failed, or an evaluation that finished without a TraceRoot run id. The evaluations that finished before the failure are still compared and reported, and a regression among them exits `18`. |
| `18` | A case and scorer pair newly fails, or a case newly errors. |
| `130` | Ctrl+C. A `SIGTERM` exits `143` and a `SIGHUP` `129`, the shell's status for each. The summary names any run the runner saved before it stopped, with that run's own status. |

## Skills & agents

Make your coding agent TraceRoot-aware without touching your application source. The
CLI ships two first-party skills. Installing a skill copies bundled files from this
package; the install step does not fetch from the network or run install scripts.
Install targets depend on the agent:

- `--agent claude` → project-local `.claude/skills/<skill>/`
- `--agent codex` → global `$CODEX_HOME/skills/<skill>/` (defaults to `~/.codex/skills/`)
- `--agent generic` → project-local `.agents/skills/<skill>/`

`skills install` and `instrument` are interactive: run them without the required
flags in a terminal and they prompt (skill, then agent; or agent, then output
path), accepting a default on Enter. Pass the flags to skip the prompts.

```sh
traceroot skills list                                              # available skills + per-agent install status

traceroot skills install                                           # interactive: prompts for skill, then agent
traceroot skills install traceroot-instrument-repo --agent claude  # add tracing to an app
traceroot skills install traceroot-quickstart --agent codex        # install for Codex (~/.codex/skills)

traceroot instrument                                               # interactive: prompts for agent, then output path
traceroot instrument --agent claude --print                        # print the prompt to stdout
traceroot instrument --agent codex --output .traceroot/prompts/codex-instrument-repo.md

traceroot doctor                                                   # check credentials, repo, runtime env, skills
```

`skills install` and `instrument` refuse to overwrite an existing target without
`--force` (in a terminal they ask first); `--dry-run` reports what `skills install`
would write without touching disk.
