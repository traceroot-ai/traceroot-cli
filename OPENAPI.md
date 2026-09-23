# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `2f73589f` (branch `main`), plus the five evaluation read paths
  from `1472c50eb` (branch `feat/eval-listing-reads`)
- sha256(openapi.json): `5f195bf9a2af1d07c0896b4f4d291db4fd4d6398b48a7a2a716f0864039878c1`
- Vendored on: 2026-09-22

The snapshot is backend main at the merge that brought in the public SQL
operations. The five evaluation reads were merged into it, verbatim with every schema they
reference, from the backend branch that adds them (traceroot-ai/traceroot#2262 and #2263):
`/datasets`, `/datasets/{dataset_id}`, `/datasets/{dataset_id}/versions`,
`/dataset-versions/{version_id}`, `/evaluation-runs/{run_id}`, `/evaluations` and
`/evaluation-runs`. The tool registry this
matches is the one `@traceroot-ai/tools` 0.5.0 carries. Once that is published, refresh the
whole file from backend main as below.

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
