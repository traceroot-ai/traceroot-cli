# TypeScript instrumentation

## Initialize once, on the path that runs the application

Call `TraceRoot.initialize()` inside the function the entry point calls to start itself, and not at
module scope. Module scope runs on import, and a project's test suite imports its entry point:
initialize there and every test that reaches an instrumented function exports a trace of its own,
each one indistinguishable from the application's afterwards. Load the env vars on that same path,
beside it — which is why the snippet below calls `config()` rather than importing
`dotenv/config` for its side effect at module scope.

The order that matters is not the import order. `initialize()` has to run before the first model
call and before the first `observe()` callback runs. `observe(options, fn, ...args)` invokes rather
than wraps, so there is no module-scope wrapper to order against: it starts the SDK itself at call
time when nothing else has, and a second `initialize()` after that is skipped with a warning, so
the modules named here would never be instrumented. Auto-instrumentation patches the provider
library's own methods, which takes effect whatever the import order — so leave the provider imports
where they are.

```typescript
import { config } from 'dotenv';
import { TraceRoot } from '@traceroot-ai/traceroot';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import * as lcCallbackManager from '@langchain/core/callbacks/manager';

async function main() {
  config();
  TraceRoot.initialize({
    instrumentModules: {
      openAI: OpenAI,       // auto-instruments all OpenAI calls
      anthropic: Anthropic, // auto-instruments Anthropic calls
      langchain: lcCallbackManager,  // see LangChain note below
    },
    // Use only the modules present in the project
  });
  await run();  // whatever this entry point already does
}
```

A module another process imports in order to run it — a server started by a process manager, a
queue worker — has no such function, so initialize at the framework's own startup hook instead.

Whatever the shape, keeping `initialize()` off module scope does not on its own keep the tests from
exporting: `observe()` starts the SDK at call time whenever `TRACEROOT_API_KEY` is in the
environment, however it got there. Run the project's own checks with `TRACEROOT_ENABLED=false` in
the environment (`TRACEROOT_ENABLED=false npm test`) so that they do not export.

`TRACEROOT_API_KEY` is read from the environment automatically. No need to pass it explicitly.

Other supported `instrumentModules` keys: `claudeAgentSDK`, `bedrock`, `openaiAgents` (pass the imported module, same as above). Pass only the ones the project uses. For the Vercel AI SDK, no entry is needed — set `experimental_telemetry: { isEnabled: true }` on each call and TraceRoot enriches those spans automatically. For Mastra, use `@traceroot-ai/mastra`'s `TraceRootExporter` instead of `instrumentModules`.

The TS runtime supports fewer frameworks than Python (many agent frameworks are Python-only). The installed package is the current list — read the `instrumentModules` keys from `node_modules/@traceroot-ai/traceroot`'s type declarations rather than fetching a docs page, which costs a network round trip to learn what the dependency already states. Those keys are the auto-instrumentation coverage; the Vercel AI SDK and Mastra paths above are separate and are not keys. Coverage changes over time, so look rather than assume.

### LangChain note

Pass the callbacks manager module, not the LangChain class:

```typescript
import * as lcCallbackManager from '@langchain/core/callbacks/manager';

// A key in the one initialize() call above, on the run path — not a second call.
TraceRoot.initialize({
  instrumentModules: { langchain: lcCallbackManager },
});
```

## Add manual spans with `observe()`

Use `observe()` to wrap functions that represent meaningful steps: agent entrypoints, tool calls, orchestration logic.

```typescript
import { observe, updateCurrentSpan } from '@traceroot-ai/traceroot';

// Agent entrypoint
const result = await observe({ name: 'agent.run', type: 'agent' }, async () => {
  return await runPipeline(query);
});

// Tool call
const docs = await observe({ name: 'search_tool', type: 'tool' }, async () => {
  return await doSearch(query);
});

// Generic span with input recorded
const answer = await observe(
  { name: 'process_step', type: 'span' },
  async () => {
    updateCurrentSpan({ input: { query } });
    return await processQuery(query);
  },
);
```

### `observe()` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `fn.name` or `'anonymous'` | Span name shown in the UI |
| `type` | `string` | `'span'` | `'span'`, `'tool'`, `'agent'`, or `'llm'` |
| `metadata` | `object` | — | Static metadata to attach |
| `tags` | `string[]` | — | Tags for filtering |

## Set user and session context

Use `usingAttributes()` — all spans created inside the callback inherit the values, including those from auto-instrumented LLM calls.

```typescript
import { usingAttributes } from '@traceroot-ai/traceroot';

const result = await usingAttributes(
  { userId: 'user-123', sessionId: 'sess-456', tags: ['production'] },
  async () => {
    return await runAgent(userMessage);
  },
);
```

`usingAttributes` calls can be nested; the innermost value for each field wins.

## Update spans and traces programmatically

For custom providers or when you need to set attributes after the fact:

```typescript
import { updateCurrentSpan, updateCurrentTrace } from '@traceroot-ai/traceroot';

// Inside an observe() callback:
updateCurrentSpan({
  input: { query: 'hello' },
  output: { response: 'world' },
  model: 'gpt-4o',
  modelParameters: { temperature: 0.7, maxTokens: 1024 },
  usage: { inputTokens: 100, outputTokens: 50 },
});

updateCurrentTrace({
  userId: 'user-123',
  sessionId: 'sess-456',
  tags: ['production'],
});
```

## Flush in short-lived scripts

For scripts/CLIs/serverless, flush before the process exits (never for long-running servers):

```typescript
await runMyScript();
await TraceRoot.shutdown(); // export all buffered spans before exit
```

> Verify the exact export before editing — the lifecycle method can vary by SDK version. Check the installed package's types/exports (e.g. inspect `node_modules/@traceroot-ai/traceroot`) and use what it provides (`TraceRoot.shutdown()` in current versions).

## What to instrument

**Prioritize:**
- Request/response boundaries (API handlers, queue consumers, cron jobs)
- Agent entrypoints and their major steps
- Tool calls and external calls not already auto-instrumented

**Avoid:**
- Low-level utilities called in tight loops
- Small pure functions that add noise
- Per-item spans in large fanout loops (use one span around the loop)
