# Contributing

Thanks for contributing to `traceroot-cli`.

## Requirements

- Node.js 20+
- `npm`
- `git`

## Setup

```bash
git clone https://github.com/traceroot-ai/traceroot-cli.git
cd traceroot-cli
npm ci
npm run build
```

Run the CLI from your local build (`node ./bin/traceroot.mjs --help`), or
`npm link` it onto your PATH as `traceroot`.

## Before you start

- Check for an existing issue before starting larger work, or open one first so the change has clear scope.
- Create branches from `main`. If you don't have push access, fork first.
- Keep each pull request focused on one problem.

## Workflow

1. Create a branch from `main` using a short descriptive name (e.g. `feat/traces-export`, `fix/env-precedence`).
2. Make the smallest change that fully solves the issue.
3. Run linting and tests locally before pushing:

   ```bash
   npm run codegen:check   # generated API types are in sync with openapi.json
   npm run typecheck
   npm run lint
   npm run format:check    # `npm run format` auto-fixes
   npm test
   ```

   These mirror CI exactly. To run them automatically, install the hooks: `pipx install pre-commit && pre-commit install`.

4. Open a pull request and link the related issue when applicable.

> `src/api/generated/` is generated from `openapi.json` — never edit it by hand. Update `openapi.json` and run `npm run codegen`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add traces export bundle
fix: honor .env precedence in login
docs: expand contributing guide
test: cover unknown trace id handling
chore: bump development dependencies
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`.

## Pull requests

- Keep PRs scoped to one logical change.
- Explain what changed, why it changed, and how it was validated.
- Add or update tests for behavior changes.
- Preserve the output contract (JSON → stdout, human/errors → stderr, non-zero exit on failure, honor `NO_COLOR`).
- Make sure linting and tests pass before requesting review.
