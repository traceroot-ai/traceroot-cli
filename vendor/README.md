# Vendored dependencies

## @traceroot-ai/tools 0.3.0-dev.21d9fdb

Built from https://github.com/traceroot-ai/traceroot commit `21d9fdb7`
(`frontend/packages/tools`, branch `feat/sql-gateway-epic`) on 2026-09-16.
The published `@traceroot-ai/tools` 0.2.0 predates the `run_sql` and
`get_sql_schema` tools, so the `sql` command needs a build that carries them.
The contents are what a `tools-v0.3.0` release from that branch would publish;
the `-dev.21d9fdb` label names the source commit and does not exist on npm.
Rebuild:

    git worktree add --detach /tmp/tools-build <commit>
    cd /tmp/tools-build/frontend/packages/tools
    npx -y -p typescript@5.7 tsc -p tsconfig.json
    npm pkg set version=0.3.0-dev.<short-commit>
    npm pack --pack-destination <this repo>/vendor
    cd <this repo> && npm install --save-exact ./vendor/traceroot-ai-tools-0.3.0-dev.<short-commit>.tgz

Refresh `openapi.json` from the same commit (see `OPENAPI.md`) so the parity
test keeps passing.

**Before the next traceroot-cli npm release** this must be replaced with the
real npm dependency (`npm install @traceroot-ai/tools@<version>` and delete
this tarball): a `file:` dependency is not installable by npm consumers, and
`prepublishOnly` refuses to publish with one. That release should also declare
a Node engine range this CLI supports; this build inherits `"node": ">=24"`
from the package, while the CLI supports Node 20.3 and later.
The parity test (`tests/registry/parity.test.ts`) fails if this tarball and
the committed `openapi.json` drift apart.
