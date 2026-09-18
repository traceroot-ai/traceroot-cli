# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `2f73589f` (branch `main`)
- sha256(openapi.json): `3ec062174a320680ddb3e3b12f77cbdec12c6ea47f039804eb1adc64b159ab30`
- Vendored on: 2026-09-18

The snapshot is backend main at the merge that brought in the public SQL
operations. Its tool registry is the one `@traceroot-ai/tools` 0.3.0 carries.

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
