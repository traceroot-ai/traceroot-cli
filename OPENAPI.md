# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `5791ebddf` (branch `main`)
- sha256(openapi.json): `d885dbc7fbf28ade4862252f749e5c72db5705270e256c6039deb9dd513da7ca`
- Vendored on: 2026-11-12

A straight copy of backend `main` at the commit `@traceroot-ai/tools@0.6.0` is published from. The
three signal paths — `/signals`, `/signals/{signal_id}` (with the signal's `recent_hits`) and
`/signals/{signal_id}/status` — are in it, and the registry this matches is the published 0.6.0 with
its 53 tools.

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
