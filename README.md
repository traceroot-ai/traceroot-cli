# TraceRoot CLI

Read your [TraceRoot](https://traceroot.ai) traces from the terminal: list,
inspect, and export traces from the TraceRoot public API.

## Install

```sh
npx traceroot-cli --help        # run without installing
npm install -g traceroot-cli    # or install the `traceroot` command
```

## Quick start

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
traceroot login --api-key tr_...      # key mode: validates, saves ./.traceroot/config.json
traceroot traces list --limit 10
```

## Configuration

The CLI authenticates with either a **browser login** (a session credential
stored in `~/.config/traceroot/credentials.json`, exchanged for a short-lived
access token before every request) or a **project API key** (`tr_...`, sent
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
export TRACEROOT_API_KEY=tr_...
export TRACEROOT_HOST_URL=https://app.traceroot.ai
traceroot traces list
```

> Your API key and session token are secrets. The CLI only ever prints a masked
> hint and keeps its files out of git — don't paste them into shared terminals.

### Project scoping

A browser login identifies *you*, not a project, so project-scoped reads
(traces, detectors, findings, datasets, evals) need a project id: `--project <id>` >
`TRACEROOT_PROJECT_ID` > `project_id` in the config file. Run
`traceroot projects list` to find one. API keys are already project-scoped and
need none of this.

## Commands

| Command | Description |
| :-- | :-- |
| `login` | Sign in with the browser (device flow) and store the session credential; with `--api-key`, validate and save the key instead. |
| `logout` | Revoke the session server-side (best-effort) and remove the local credential. |
| `status` | Show the identity your credentials resolve to — email/workspaces (browser login) or workspace/project/key hint (API key), plus host and source. |
| `workspaces list` | List the workspaces you can access (browser login only). |
| `projects list` | List the projects you can access, across workspaces; the `PROJECT ID` column is what `--project` takes. `--workspace-id <id>` |
| `traces list` | List traces for your project, newest first. `--limit <n>`, `--since <dur>`, `--from`/`--to` (for field filters, use `sql`) |
| `traces get <id>` | Show one trace: span tree, derived duration, and a link to open it. Defaults to the lightweight `skeleton` projection (no per-span input/output/metadata); pass `--fields full` (or `--fields io,metadata`) to fetch span I/O. `--fields <groups>` |
| `traces export <id>` | Write a trace bundle (`trace.json`, `spans.json`, `git_context.json`, `manifest.json`) to a directory. Defaults to the `full` projection (span input/output/metadata included); pass `--fields <groups>` to narrow it. `--output <dir>`, `--force`, `--fields <groups>` |
| `detectors list` | List your project's detectors, newest first. The `DETECTOR ID` column is what you pass to `findings list --detector`. `--limit <n>`, `--since <dur>`, `--from`/`--to` |
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
| `datasets list` | List the project's evaluation datasets, newest first, with each one's current published version. `--limit <n>`, `--name <substring>` |
| `datasets get <id>` | Show one dataset: name, key, description, and the version its cases are read from. A dataset with nothing published says so. |
| `datasets versions list <dataset-id>` | List a dataset's published versions, newest first, with each one's case count; `*` marks the current one. `--limit <n>` |
| `datasets versions get <version-id>` | Show one immutable version and one page of its test cases (input, expected, and the trace a case was captured from) — 200 by default, up to 1000. `--limit <n>` |
| `evals list` | List the project's evaluations, newest first: how many runs each has and how its latest one ended. The `EVALUATION ID` column is what `evals runs list --evaluation-id` takes. `--limit <n>`, `--name <substring>` |
| `evals runs list` | List evaluation runs, newest first, with the id each is read by. The row is identity and outcome only — counts and scores come from `evals runs get`. `--limit <n>`, `--evaluation-id <id>`, `--status <status>` |
| `evals runs get <run-id>` | Show one run: the dataset version it pinned, how its cases came out, its per-scorer means and per-case cost and duration, and a link to open it. |
| `skills list` | List first-party TraceRoot skills and install status across supported agents. |
| `skills install [skill]` | Copy a bundled skill into an agent's skill directory. Prompts for missing skill/agent in an interactive terminal. `--agent <agent>`, `--force`, `--dry-run` |
| `instrument` | Generate an agent-ready prompt to add TraceRoot tracing to this repo. Prompts for missing agent/output path in an interactive terminal. `--agent <agent>`, `--print`, `--output <path>`, `--force` |
| `doctor` | Diagnose credentials, repo shape, runtime env, and installed skills (`pass`/`warn`/`fail`). |

Add `--json` to any command for a single machine-readable document on stdout.
Run `traceroot <command> --help` for the full flag list.

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

### Generated commands

`traces`, `detectors`, `findings`, `alerts`, `dashboards`, `widgets`,
`workspaces`, `projects`, `sql`, `datasets`, and `evals` are generated from the
tool registry shipped in
[`@traceroot-ai/tools`](https://www.npmjs.com/package/@traceroot-ai/tools): each
entry's input schema drives its flags, and its response type drives the default
rendering. Adding a new backend endpoint to the CLI is a registry bump
plus one placement line in `src/registry/naming.ts` — no hand-written command
handler needed. `login`, `logout`, `status`, `skills`, `instrument`, and
`doctor` stay hand-written: they are auth flows or local tooling with no
registry entry.

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
- **Each read returns one page.** There is no cursor flag, so when more matched
  than came back the command says so on stderr and names the ceiling. The lists
  return 50 by default and take `--limit` up to 200; `datasets versions get`
  reads 200 cases by default and takes `--limit` up to 1000. Past that ceiling is
  not reachable from the CLI.
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

On failure the human-readable message goes to stderr as `error: <message>`. Under
`--json` the failure is written to stderr instead as exactly one line —
`{"error":{"code":"<class>","message":"<text>"}}` — while stdout stays empty, so a
`jq` pipeline over stdout is never corrupted by an error.

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
