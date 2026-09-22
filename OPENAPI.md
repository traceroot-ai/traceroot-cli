# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `2f73589f` (branch `main`), plus the five evaluation read paths
  from `6947437a3` (branch `feat/eval-run-read-tool`)
- sha256(openapi.json): `bd8687287160aa5a090752c203415e04ccbebd539eb39631d4ca8957be579011`
- Vendored on: 2026-09-22

The snapshot is backend main at the merge that brought in the public SQL
operations. The five evaluation reads were merged into it, verbatim with every schema they
reference, from the backend branch that adds them (traceroot-ai/traceroot#2262 and #2263):
`/datasets`, `/datasets/{dataset_id}`, `/datasets/{dataset_id}/versions`,
`/dataset-versions/{version_id}` and `/evaluation-runs/{run_id}`. The tool registry this
matches is the one `@traceroot-ai/tools` 0.5.0 carries. Once that is published, refresh the
whole file from backend main as below.

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
