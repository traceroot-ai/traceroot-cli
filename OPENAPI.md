# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `8e7e8c60`
- sha256(openapi.json): `036e1a7f2b6e30a86bd6c9f91196134466cfd44b2ad676433f921133fcb4236d`
- Vendored on: 2026-08-25

### Account-scope splice (temporary)

The `/api/v1/public/workspaces` and `/api/v1/public/projects` operations (and
their `WorkspaceListItem` / `ProjectListItem` / `Public*ListResponse` schemas)
are spliced in from the still-open CLI-auth server stack
(branch `feat/cli-credential-jwt`, backend commit `42b04570`); backend main
`8e7e8c60` does not expose them yet. They carry no `x-tool`, so they are absent
from the `@traceroot-ai/tools` registry and reach the CLI only through the
curated `workspaces`/`projects` commands, not the generated command surface.
Once that branch lands on backend main, drop this splice: a plain wholesale
refresh (below) picks the endpoints up with their `x-tool` annotations.

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
