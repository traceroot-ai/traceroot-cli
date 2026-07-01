# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `85116bec`
- sha256(openapi.json): `f76ad6a1f96372d47de6b9ddc0a86349a3e55fdcae87de73151c959e05a9793a`
- Vendored on: 2026-06-30

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
