# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `8de2bea58` (branch `main`)
- sha256(openapi.json): `508a8e7ca2aa5b9c43276cd61bdb8c929289eb023e007d2a60bdc0df06d53e28`
- Vendored on: 2026-09-24

A straight copy of backend `main`, taken after the evaluation reads merged (traceroot-ai/traceroot#2262,
#2263 and the listing reads in #2340) and after `@traceroot-ai/tools@0.5.0` was published from it. The
seven evaluation read paths — `/datasets`, `/datasets/{dataset_id}`, `/datasets/{dataset_id}/versions`,
`/dataset-versions/{version_id}`, `/evaluation-runs/{run_id}`, `/evaluations` and `/evaluation-runs` —
are in it, and the registry this matches is the published 0.5.0 with its 50 tools.

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
