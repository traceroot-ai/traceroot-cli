# Vendored dependencies

## @traceroot-ai/tools 0.1.0

Built from https://github.com/traceroot-ai/traceroot commit `df3cd621`
(`frontend/packages/tools`) on 2026-08-17, because the package is not yet
published to npm (issue #65 explicitly allows a packed tarball during
development). Rebuild:

    git worktree add --detach /tmp/tools-build <commit>
    cd /tmp/tools-build/frontend/packages/tools
    npx -y -p typescript@5.7 tsc -p tsconfig.json
    npm pack --pack-destination <this repo>/vendor

**Before the next traceroot-cli npm release** this must be replaced with the
real npm dependency (`npm install @traceroot-ai/tools@<version>` and delete
this tarball) — a `file:` dependency is not installable by npm consumers.
The parity test (`tests/registry/parity.test.ts`) fails if this tarball and
the committed `openapi.json` drift apart.
