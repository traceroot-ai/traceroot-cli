# OpenAPI schema provenance

The typed API client is generated from a vendored copy of the backend's public
OpenAPI schema. `openapi.json` is the ONLY cross-repo artifact; nothing in the
build graph imports the backend.

- Backend source: `backend/rest/openapi/public.json`
- Backend commit: `a45a93e5`
- sha256(openapi.json): `89f44383e9590d5b4cf9c6fec5b995d78c3e85522b424d46a283a60517d6ad2f`
- Vendored on: 2026-06-18

## Refresh

1. Copy the backend file `backend/rest/openapi/public.json` to repo-root `openapi.json`.
2. Update the fields above (backend commit, sha256, vendored date).
3. Run `npm run codegen` to regenerate `src/api/generated/schema.ts`.
4. Run `npm run codegen:check` to confirm the committed schema matches.
5. Commit `openapi.json` + `OPENAPI.md` + `src/api/generated/schema.ts` together.
