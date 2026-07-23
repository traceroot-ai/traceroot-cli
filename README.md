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
traceroot detectors list                   # list your detectors (copy a detector id)
traceroot findings list --since 24h        # list recent detector findings
traceroot findings get <finding-id>        # inspect one finding + its RCA
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
| `traces get <id>` | Show one trace: span tree, derived duration, and a link to open it. Defaults to the lightweight `skeleton` projection (no per-span input/output/metadata); pass `--fields full` (or `--fields io,metadata`) to fetch span I/O. `--fields <groups>` |
| `traces export <id>` | Write a trace bundle (`trace.json`, `spans.json`, `git_context.json`, `manifest.json`) to a directory. Defaults to the `full` projection (span input/output/metadata included); pass `--fields <groups>` to narrow it. `--output <dir>`, `--force`, `--fields <groups>` |
| `detectors list` | List your project's detectors, newest first. The `DETECTOR ID` column is what you pass to `findings list --detector`. `--limit <n>`, `--since <dur>`, `--from`/`--to` |
| `findings list` | List detector findings for your project, newest first. `--limit <n>`, `--since <dur>`, `--from`/`--to`, `--detector <id>`, `--trace <id>` |
| `findings get [id]` | Show one finding: per-detector results and its free-text RCA. Look it up by finding id or with `--trace <id>` (exactly one). |
| `skills list` | List first-party TraceRoot skills and install status across supported agents. |
| `skills install [skill]` | Copy a bundled skill into an agent's skill directory. Prompts for missing skill/agent in an interactive terminal. `--agent <agent>`, `--force`, `--dry-run` |
| `instrument` | Generate an agent-ready prompt to add TraceRoot tracing to this repo. Prompts for missing agent/output path in an interactive terminal. `--agent <agent>`, `--print`, `--output <path>`, `--force` |
| `doctor` | Diagnose credentials, repo shape, runtime env, and installed skills (`pass`/`warn`/`fail`). |

Add `--json` to any command for a single machine-readable document on stdout.
Run `traceroot <command> --help` for the full flag list.

```sh
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef --fields full   # include span input/output/metadata
traceroot traces export <trace-id> --output ./out
traceroot traces list --from 2026-06-23T14:00:00Z --to 2026-06-23T20:00:00Z --limit 5 --json | jq '.data[].trace_id'
traceroot detectors list --json | jq '.data[].detector_id'
traceroot findings list --detector <detector-id> --since 7d --json | jq '.data[].finding_id'
traceroot findings get --trace 99224be337d725fd5e8f2e7b45dc22ef
```

### Exit codes

Every command exits with a class-specific code so scripts can branch on the kind
of failure — retry a network blip, re-authenticate, or give up on a missing
resource — without parsing prose.

| Code | Class | JSON `code` | Meaning |
| ---- | ----- | ----------- | ------- |
| `0` | success | — | The command completed. |
| `1` | internal | `internal` | Unexpected/internal error (the default when nothing else fits). |
| `2` | usage | `usage` | Invalid arguments or options (bad flag value, unknown agent/skill, missing required input). |
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
