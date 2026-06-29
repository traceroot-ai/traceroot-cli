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
traceroot login --api-key tr_... --host https://app.traceroot.ai  # authenticate (saves ./.traceroot/config.json)
traceroot status                      # confirm who you are
traceroot traces list --limit 10      # list recent traces
traceroot traces get <trace-id>       # inspect one
traceroot traces export <trace-id>    # export its bundle to a directory
```

## Configuration

The CLI needs an API key (`tr_...`) and an API host. It resolves them in this
priority order:

1. Flags — `--api-key`, `--host`
2. Env file — `--env-file <path>`
3. Env vars — `TRACEROOT_API_KEY`, `TRACEROOT_HOST_URL`
4. Config file — `./.traceroot/config.json`
5. Auto-discovered `./.env`

`traceroot login` validates the key, then writes `./.traceroot/config.json`
(`0600`, auto-gitignored) so later commands need no flags. Override the path with
`TRACEROOT_CONFIG_PATH`. For CI or scripts, prefer env vars or flags:

```sh
export TRACEROOT_API_KEY=tr_...
export TRACEROOT_HOST_URL=https://app.traceroot.ai
traceroot traces list
```

> Your API key is a secret. The CLI only ever prints a masked hint and keeps the
> config out of git — don't paste the full key into shared terminals.

## Commands

| Command | Description |
| :-- | :-- |
| `login` | Authenticate and save credentials (validates before writing). |
| `status` | Show the identity your credentials resolve to — workspace, project, key hint, host, source. |
| `traces list` | List traces for your project, newest first. `--limit <n>`, `--since <dur>`, `--from`/`--to` |
| `traces get <id>` | Show one trace: span tree, derived duration, I/O preview, and a link to open it. |
| `traces export <id>` | Write a trace bundle (`trace.json`, `spans.json`, `git_context.json`, `manifest.json`) to a directory. `--output <dir>`, `--force` |
| `skills list` | List first-party TraceRoot skills and install status across supported agents. |
| `skills install [skill]` | Copy a bundled skill into an agent's skill directory. Prompts for missing skill/agent in an interactive terminal. `--agent <agent>`, `--force`, `--dry-run` |
| `instrument` | Generate an agent-ready prompt to add TraceRoot tracing to this repo. Prompts for missing agent/output path in an interactive terminal. `--agent <agent>`, `--print`, `--output <path>`, `--force` |
| `doctor` | Diagnose credentials, repo shape, runtime env, and installed skills (`pass`/`warn`/`fail`). |

Add `--json` to any command for a single machine-readable document on stdout.
Run `traceroot <command> --help` for the full flag list.

```sh
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef
traceroot traces export <trace-id> --output ./out
traceroot traces list --from 2026-06-23T14:00:00Z --to 2026-06-23T20:00:00Z --limit 5 --json | jq '.data[].trace_id'
```

## SQL — analytical export

`traceroot sql` runs read-only ClickHouse SQL against the TraceRoot analytical
export. **input, output, and metadata blobs are excluded from the export** (raw
blob access may be offered as an opt-in in the future).

```sh
# count spans in the last 24h
traceroot sql "SELECT count() AS spans_24h FROM spans WHERE span_start_time >= now() - INTERVAL 24 HOUR"

# p95 latency by model
traceroot sql "SELECT model_name, quantile(0.95)(duration_ms) AS p95_ms FROM spans WHERE model_name IS NOT NULL GROUP BY model_name ORDER BY p95_ms DESC"

# cost by model
traceroot sql "SELECT model_name, sum(cost) AS total_cost FROM spans GROUP BY model_name ORDER BY total_cost DESC"

# export spans to CSV
traceroot sql "SELECT * FROM spans WHERE span_start_time >= now() - INTERVAL 7 DAY" --csv --output spans.csv

# find error spans
traceroot sql "SELECT span_id, name, status_message FROM spans WHERE status = 'ERROR' ORDER BY span_start_time DESC LIMIT 100"

# show the analytical export schema
traceroot sql schema
```

Output modes: default table | `--json` (one JSON line) | `--csv` (RFC-4180).
`--output <file>` writes any mode to a file instead of stdout.

`traceroot sql schema` prints the curated list of available tables, columns, and
types without running a query.

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
