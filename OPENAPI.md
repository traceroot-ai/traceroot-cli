# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `21d9fdb7` (branch `feat/sql-gateway-epic`, not yet on backend main)
- sha256(openapi.json): `9689ce03e95d537f600fa4ee82f54b6cd660a73f21e168b89791d323c112be26`
- Vendored on: 2026-09-16

The snapshot comes from the integration branch that carries the public SQL
operations, which is also where staging is deployed from, rather than from
backend main. It is the same commit the vendored `@traceroot-ai/tools` build
comes from (see `vendor/README.md`). Once that branch lands, refresh from main.

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
