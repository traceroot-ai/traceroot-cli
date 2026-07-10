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
| `traces get <id>` | Show one trace: span tree, derived duration, I/O preview, and a link to open it. Bound large traces with `--max-spans <n>`, `--depth <n>`, `--errors-only`, `--output jsonl`. |
| `traces export <id>` | Write a trace bundle (`trace.json`, `spans.json`, `git_context.json`, `manifest.json`) to a directory. `--output <dir>`, `--force` |
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
traceroot traces export <trace-id> --output ./out
traceroot traces list --from 2026-06-23T14:00:00Z --to 2026-06-23T20:00:00Z --limit 5 --json | jq '.data[].trace_id'
traceroot detectors list --json | jq '.data[].detector_id'
traceroot findings list --detector <detector-id> --since 7d --json | jq '.data[].finding_id'
traceroot findings get --trace 99224be337d725fd5e8f2e7b45dc22ef
```

### Bounding large traces

An agent trace can carry thousands of spans, which is a lot to dump into a
terminal — or into another model's context. `traces get` has four opt-in,
backward-compatible flags to subset the output (they apply to both the human
tree and the JSON/JSONL bodies):

| Flag | Effect |
| :-- | :-- |
| `--max-spans <n>` | Show at most `n` spans. JSON adds `spans_truncated: { shown, total }`; the human tree appends a `… N more spans` line. |
| `--depth <n>` | Cap tree depth (roots are depth 1); deeper spans are dropped. The human tree marks each elided subtree with `… N deeper spans hidden`. |
| `--errors-only` | Keep only error spans and their full ancestor chains, dropping unrelated branches. |
| `--output jsonl` | Stream a header line (the trace minus its spans, plus `finding`) then one span per line. Implies machine output, so it works with or without `--json`, and stays `head`-safe. |

The flags compose — `--errors-only` is applied first, then `--depth`, then
`--max-spans` — and the truncation total always reflects the post-filter set.

```sh
# Just the failures and how they were reached, as JSON.
traceroot traces get <trace-id> --errors-only --json | jq '.spans[].name'

# Stream spans and grep for slow model calls without buffering the whole trace.
traceroot traces get <trace-id> --output jsonl | grep '"model_name":"gpt-4o"'

# Peek at the top of a huge trace: the header line, nothing more.
traceroot traces get <trace-id> --output jsonl | head -1
```

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
