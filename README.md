# TraceRoot CLI

[![Y Combinator][y-combinator-image]][y-combinator-url]
[![License][license-image]][license-url]
[![X (Twitter)][twitter-image]][twitter-url]
[![Discord][discord-image]][discord-url]
[![Documentation][docs-image]][docs-url]
[![npm Version][npm-version-image]][npm-version-url]
[![npm Downloads][npm-downloads-image]][npm-downloads-url]

The command-line interface for [TraceRoot](https://traceroot.ai) — read your
traces from the terminal. `traceroot` is a small, dependency-light, read-only
client for the TraceRoot public API: authenticate once, then list, inspect, and
export traces for your project. It never instruments your code or emits spans —
that's what the [SDKs](https://traceroot.ai/docs) are for.

## Install

Requires **Node.js ≥ 20**.

```sh
# Run without installing
npx traceroot-cli --help

# Or install globally to get the `traceroot` command
npm install -g traceroot-cli
traceroot --help
```

## Quick start

```sh
# 1. Authenticate (saves a project-local ./.traceroot/config.json)
traceroot login --api-key tr_... --host https://api.traceroot.ai

# 2. Confirm who you are
traceroot status

# 3. List recent traces
traceroot traces list --limit 10

# 4. Inspect one
traceroot traces get <trace-id>

# 5. Export its bundle to a directory
traceroot traces export <trace-id> --output ./my-trace
```

## Authentication & configuration

The CLI needs an **API key** (`tr_...`) and an **API host**. It resolves them
from the following sources, highest priority first:

1. CLI flags — `--api-key`, `--host`
2. An explicit env file — `--env-file <path>`
3. Environment variables — `TRACEROOT_API_KEY`, `TRACEROOT_HOST_URL`
4. The config file — `./.traceroot/config.json`
5. An auto-discovered `./.env` in the current directory

Any of these works on its own. For interactive use, `traceroot login` saves your
credentials so later commands need no flags. For CI/scripts, prefer env vars or
flags.

### `.env` and environment variables

```sh
# ./.env (auto-discovered) or any file passed with --env-file
TRACEROOT_API_KEY=tr_...
TRACEROOT_HOST_URL=https://api.traceroot.ai
```

```sh
export TRACEROOT_API_KEY=tr_...
export TRACEROOT_HOST_URL=https://api.traceroot.ai
traceroot traces list

# or fully inline
traceroot --api-key tr_... --host https://api.traceroot.ai traces list
```

### Config file

`traceroot login` writes `./.traceroot/config.json` in the current project
directory with `0600` permissions, alongside a `.gitignore` so your key is never
committed. Point the CLI at a different file with `TRACEROOT_CONFIG_PATH`.

```jsonc
// ./.traceroot/config.json
{ "api_key": "tr_...", "host_url": "https://api.traceroot.ai" }
```

> Your API key is a secret. The CLI only ever prints a masked hint of it, and
> keeps the config out of git — but don't paste the full key into shared
> terminals or commit it elsewhere.

## Commands

### `traceroot login`

Authenticate and save credentials. Validates the key against the API before
writing anything; on failure nothing is saved.

```sh
traceroot login --api-key tr_... --host https://api.traceroot.ai
traceroot login            # interactive prompts (masked key)
traceroot login            # or non-interactive if a key already resolves (env/.env)
```

### `traceroot status`

Show the identity your credentials resolve to — workspace, project, key hint,
host, and where the credentials came from.

```sh
traceroot status
traceroot status --json
```

### `traceroot traces list`

List traces for your project (newest first).

```sh
traceroot traces list
traceroot traces list --limit 25
traceroot traces list --json | jq '.data[].trace_id'
```

| Flag | Description |
| :-- | :-- |
| `--limit <n>` | Maximum number of traces to return. |
| `--json` | Emit the raw API response as JSON on stdout. |

### `traceroot traces get <trace-id>`

Show a single trace: header, span tree, derived duration, and an I/O preview,
plus a link to open it in TraceRoot.

```sh
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef
traceroot traces get <trace-id> --json   # full, untruncated payload
```

### `traceroot traces export <trace-id>`

Write a trace bundle to a directory: `trace.json`, `spans.json`,
`git_context.json`, and a `manifest.json` index. `export/trace.json` is
byte-for-byte the same as `traces get --json`.

```sh
traceroot traces export <trace-id>                 # ./trace_<id>_<timestamp>/
traceroot traces export <trace-id> --output ./out  # custom directory
traceroot traces export <trace-id> --output ./out --force  # overwrite non-empty dir
```

| Flag | Description |
| :-- | :-- |
| `--output <dir>` | Destination directory (default `./trace_<id>_<timestamp>/`). |
| `--force` | Allow writing into a non-empty directory. |

## JSON output & scripting

The CLI follows a strict output contract that keeps it pipe-friendly:

- `--json` prints **exactly one JSON document to stdout** — nothing else.
- Human-readable text, progress, and errors go to **stderr**.
- Failures exit with a **non-zero** status and write nothing to stdout.
- Color is disabled automatically when output isn't a TTY or `NO_COLOR` is set.

```sh
# Safe to pipe into jq — stdout is pure JSON on success, empty on failure.
traceroot traces list --limit 5 --json | jq '.data[] | {id: .trace_id, name}'
```

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the check suite, and
conventions.

```sh
npm ci
npm run build
npm test
```

## License

[Apache License 2.0](./LICENSE) © TraceRoot.AI

<!-- Links -->

[discord-image]: https://img.shields.io/discord/1395844148568920114?logo=discord&labelColor=%235462eb&logoColor=%23f5f5f5&color=%235462eb
[discord-url]: https://discord.gg/tPyffEZvvJ
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://traceroot.ai/docs
[license-image]: https://img.shields.io/badge/License-Apache%202.0-blue.svg
[license-url]: https://opensource.org/licenses/Apache-2.0
[npm-version-image]: https://img.shields.io/npm/v/traceroot-cli?label=traceroot-cli&labelColor=0dbf43&color=grey
[npm-version-url]: https://www.npmjs.com/package/traceroot-cli
[npm-downloads-image]: https://img.shields.io/npm/dm/traceroot-cli
[npm-downloads-url]: https://www.npmjs.com/package/traceroot-cli
[twitter-image]: https://img.shields.io/twitter/follow/TracerootAI
[twitter-url]: https://x.com/TracerootAI
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
