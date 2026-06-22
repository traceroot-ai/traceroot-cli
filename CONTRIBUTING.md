# Contributing to TraceRoot CLI

Thanks for your interest in contributing!

## Development Requirements

- Node.js 20+
- `npm`: Node.js package manager
- `git`

## Quick Start

```bash
git clone https://github.com/traceroot-ai/traceroot-cli.git
cd traceroot-cli
npm ci
npm run build
```

Run the CLI from your local build with `node ./bin/traceroot.mjs --help`, or `npm link` it onto your PATH as `traceroot`.

## Before You Start

- Check for an existing issue before starting larger work, or open one first so the change has clear scope.
- If you do not have push access, fork the repo first, create your branch from `main`, push to your fork, and open the PR back to `traceroot-ai/traceroot-cli`.
- If you have push access, still create a branch from `main` and open a PR instead of working directly on `main`.
- Keep each pull request focused on one problem and link the related issue when possible.

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript from `src/` to `dist/`. |
| `npm run typecheck` | Type-check the project without emitting output. |
| `npm run lint` | Lint the codebase with Biome. |
| `npm run format` | Format the codebase with Biome. Use `npm run format:check` to check without writing. |
| `npm test` | Run the test suite with Vitest. Use `npm run test:watch` for watch mode. |
| `npm run codegen` | Regenerate API types from `openapi.json`. Use `npm run codegen:check` to verify they are in sync. |

These commands mirror CI exactly. To run them automatically before each commit, install the hooks: `pipx install pre-commit && pre-commit install`.

> `src/api/generated/` is generated from `openapi.json` — never edit it by hand. Update `openapi.json` and run `npm run codegen`.

## Workflow

1. Create a branch from `main` using a short descriptive name (e.g. `feat/traces-export`, `fix/env-precedence`).
2. Make the smallest change that fully solves the issue.
3. Commit your changes and let the pre-commit hook run automatically.
4. Run the relevant checks and tests for your change before pushing:

   ```bash
   npm run codegen:check
   npm run typecheck
   npm run lint
   npm run format:check
   npm test
   ```

5. Open a pull request and link the issue when applicable.

## Commit Message Best Practices

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add traces export bundle`
- `fix: honor .env precedence in login`
- `docs: expand contributing guide`
- `ci: align local checks with GitHub Actions`

Guidelines:

- Start with a type such as `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, `chore`, or `build`.
- Add a scope when it helps, for example `feat(traces): add export filters`.
- Use the imperative mood, for example `fix: avoid duplicate config writes`.
- Keep the summary short and specific.

## Pull Request Best Practices

- Keep the PR scoped to one logical change.
- Explain what changed, why it changed, and how it was validated.
- Add or update tests for behavior changes.
- Update documentation for setup, command, or UX changes.
- Preserve the output contract: JSON to stdout, human-readable output and errors to stderr, non-zero exit on failure, and honor `NO_COLOR`.
- Reference the issue in the PR body when relevant, for example `Closes #11`.
- Make sure pre-commit and the relevant tests pass before requesting review.

## License

This project is licensed under [Apache 2.0](LICENSE).

When contributing to the TraceRoot codebase, you need to agree to the [Contributor License Agreement](https://cla-assistant.io/traceroot-ai/traceroot-cli). You only need to do this once.
