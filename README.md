# TraceRoot CLI

Read your [TraceRoot](https://traceroot.ai) traces from the terminal: list,
inspect, and export traces from the TraceRoot public API.

## Install

Requires **Node.js ≥ 20**.

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
| `traces list` | List traces for your project, newest first. `--limit <n>` |
| `traces get <id>` | Show one trace: span tree, derived duration, I/O preview, and a link to open it. |
| `traces export <id>` | Write a trace bundle (`trace.json`, `spans.json`, `git_context.json`, `manifest.json`) to a directory. `--output <dir>`, `--force` |

Add `--json` to any command for a single machine-readable document on stdout.
Run `traceroot <command> --help` for the full flag list.

```sh
traceroot traces get 99224be337d725fd5e8f2e7b45dc22ef
traceroot traces export <trace-id> --output ./out
traceroot traces list --limit 5 --json | jq '.data[].trace_id'
```

## JSON output

The CLI follows a strict, pipe-friendly output contract:

- `--json` prints **exactly one JSON document to stdout** — nothing else.
- Human text, progress, and errors go to **stderr**.
- Failures exit **non-zero** and write nothing to stdout.
- Color is disabled when output isn't a TTY or `NO_COLOR` is set.

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
