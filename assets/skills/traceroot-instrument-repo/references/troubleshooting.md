# Troubleshooting — traces don't appear

Work top to bottom. Each row is symptom → likely cause → fix.

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing in the UI at all | `TRACEROOT_API_KEY` not loaded at runtime | Confirm it is set in the environment. In Python, import `traceroot` **after** `load_dotenv()`. In Node, `import 'dotenv/config'` **before** importing the SDK. |
| Script runs but no trace | spans never exported before exit | Short-lived scripts/CLIs must flush before exit: `traceroot.flush()` / `await TraceRoot.flush()`. |
| LLM calls not auto-captured | SDK initialized after the LLM client | `initialize()` must run **before** the LLM library is imported/instantiated. |
| Self-hosted: nothing arrives | backend URL not pointed at your instance | Set `TRACEROOT_HOST_URL` (Python) / `baseUrl` or `TRACEROOT_HOST_URL` (TS). |
| Trace shows up after a delay | batched export (normal) | Expected — spans batch. For immediate export in scripts/tests, flush (Python) or `disableBatch: true` (TS). |
| Spans look sparse (LLM only, no tools) | tool/agent functions not wrapped | Wrap them with `@observe` / `observe()` so each call shows input/output. |

## Localizing a failure

If traces still don't appear, distinguish app-side from server-side before retrying:

- Confirm spans are emitted locally — set `logLevel: 'debug'` (TS) or inspect the OTel exporter logs (Python).
- Spans emitted locally but absent in the UI → credential or connectivity issue (key, host URL, network).
- Report which side is failing rather than silently retrying or rewriting credentials.
