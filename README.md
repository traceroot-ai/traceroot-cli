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
traceroot traces list --since 24h     # traces from the last 24 hours
traceroot traces list --from "2026-06-23T14:29:54Z" --to "2026-06-23T20:00:00-06:00"  # explicit time range
traceroot traces list --wide                          # add STARTED ISO column for copy/paste
traceroot traces list --from 2026-06-23T20:31:02Z    # filter by UTC ISO timestamp
traceroot traces list --from 2026-06-23T14:31:02-06:00  # filter by offset timestamp
traceroot traces get <trace-id>       # inspect one
traceroot traces export <trace-id>    # export its bundle to a directory
```

> The `STARTED` column shows times in your local timezone; `--from`/`--to` require
> ISO 8601 timestamps (no spaces). Copy exact ISO values with `--wide` (adds a
> `STARTED ISO` column in UTC `Z` form) or `--json` (exposes `trace_start_time`).
> Quote values to avoid shell splitting, e.g. `--from "2026-06-23T14:29:54Z"` or
> `--from "2026-06-23T14:29:54-06:00"`.

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
| `traces list` | List traces for your project, newest first. `--limit <n>`, `--since <dur>`, `--from`/`--to` (ISO 8601, e.g. `"2026-06-23T14:29:54Z"`), `--wide` (adds UTC ISO column for copy/paste) |
| `traces get <id>` | Show one trace: span tree, derived duration, I/O preview, and a link to open it. |
| `traces export <id>` | Write a trace bundle (`trace.json`, `spans.json`, `git_context.json`, `manifest.json`) to a directory. `--output <dir>`, `--force` |

Add `--json` to any command for a single machine-readable document on stdout.
Run `traceroot <command> --help` for the full flag list.

```sh
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef
traceroot traces export <trace-id> --output ./out
traceroot traces list --limit 5 --json | jq '.data[].trace_id'
```

