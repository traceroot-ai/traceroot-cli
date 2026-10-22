---
name: traceroot-instrument-repo
description: >
  Add TraceRoot tracing/observability to an existing codebase. Use when the user wants to
  instrument their app, add tracing, set up LLM observability, add OpenTelemetry-based tracing,
  capture spans for agents/tools/LLM calls, or "add TraceRoot to my project" — for Python or
  TypeScript/Node.js. Covers auto-instrumentation for many LLM providers and agent frameworks
  (OpenAI, Anthropic, LangChain, and more — see the docs integrations list) plus manual spans
  and user/session context.
metadata:
  author: traceroot-ai
  version: "1.0"
compatibility: >
  Python uses the `traceroot` package (pip). TypeScript/Node.js uses `@traceroot-ai/traceroot`
  (npm); Mastra apps use `@traceroot-ai/mastra`. Both runtimes read TRACEROOT_API_KEY from the
  environment.
---

# TraceRoot Instrument Repo

Add TraceRoot tracing to an existing project. Tracing is **additive** — it never changes business logic.

## Rules (read first)

- **Only add tracing code.** Never refactor or change behavior.
- **One language, one service per run.** If the repo has several candidates (monorepo, multiple services), ask which to instrument before starting.
- **Don't duplicate.** If TraceRoot is already initialized, extend it — never add a second init.
- **Fail open.** The app must still run if `TRACEROOT_API_KEY` is missing — warn, never crash.
- **Never hardcode secrets.** Read `TRACEROOT_API_KEY` from the environment; never write the literal key into code or echo it back to the user.
- **Flush only short-lived processes.** Add a flush before exit for scripts/CLIs/serverless; never for long-running servers.

## Before writing code

Work through the steps below in order. **Skip any step whose answer you were already given** — an
automated caller may have established the runtime, the target service, or the credential before
invoking this, and re-deriving those costs a round trip to reach the same answer.

## Workflow

### 1. API key (non-blocking — skip if you were told it is set)
TraceRoot reads `TRACEROOT_API_KEY` from the process environment. The SDK does not load `.env`
itself, so a key kept there only reaches it if the file is loaded before the SDK import — the
language reference's snippet already does this (`load_dotenv()` in Python, `import 'dotenv/config'`
in Node). Do not grep or print the key to
confirm; if the SDK reports at runtime that it is missing, say so then. If it is **not** set, do not stop: still add the instrumentation (it reads the key from the environment at runtime), and tell the user they must set `TRACEROOT_API_KEY` — found in the TraceRoot UI under project settings — before running the verification step. Never hardcode or print the key. Only stop early if you cannot determine which service/runtime to instrument (see step 3).

### 2. Analyze (read-only — do not edit yet)
- Detect the runtime (Python or TypeScript/Node.js). Read the dependency manifest (`pyproject.toml`/`requirements.txt` or `package.json`) and scan imports to see what is actually used.
- Identify the LLM providers/frameworks in use (OpenAI, Anthropic, LangChain/LangGraph, and others).
Coverage differs by runtime and changes over time. Use the language reference's list now; after the
step-4 install, the installed package is the current list — read the integration names from it
rather than fetching a docs page. Don't assume a library is unsupported without looking.
- Check for **existing tracing/OpenTelemetry** (a `TracerProvider`, `opentelemetry` imports, another vendor's SDK) to avoid double-instrumentation.
- Infer what user/session context is available:

  | If the code has… | Infer | Attach |
  |---|---|---|
  | conversation history / chat endpoints | multi-turn app | `session_id` |
  | auth or `user_id` variables | user-aware app | `user_id` |
  | multiple distinct endpoints/features | multi-feature app | a `feature` tag |

### 3. Confirm scope (only if ambiguous)
If the target service is clear and the user asked to instrument now, proceed. If it is ambiguous (monorepo, multiple entrypoints), state your plan in one line and ask before editing.

### 4. Install + initialize
Install the SDK and initialize **once, at the entry point, before any LLM library imports**, enabling only the integrations the project actually uses. Follow the language reference:
- Python → `references/python-instrument.md`
- TypeScript/Node.js → `references/ts-instrument.md`

### 5. Add spans
Wrap agent entrypoints, tool functions, and key orchestration steps (`@observe` / `observe()`), attaching the user/session context inferred in step 2. Prefer auto-instrumentation; add manual spans only where they add signal (see "What to instrument" in the reference).

### 6. Verify (required — do not stop early)
Run a representative flow, then confirm the trace landed:
- If the SDK prints a trace URL, share it as proof.
- Otherwise log the trace id (`get_current_trace_id()` / `getCurrentTraceId()`) and point the user to the TraceRoot UI → Traces to confirm the span tree appears (entrypoint + child/tool spans with input/output).
- A good trace has: a descriptive name, model + token usage on LLM spans, proper nesting, and no PII/secrets in inputs.
- If nothing appears → `references/troubleshooting.md`.

## References
- `references/python-instrument.md` — Python SDK patterns: `initialize`, `@observe`, `using_attributes`, context updates
- `references/ts-instrument.md` — TypeScript/Node.js SDK patterns: `initialize`, `observe`, `usingAttributes`, context updates
- `references/troubleshooting.md` — what to do when traces don't appear
