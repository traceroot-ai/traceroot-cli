# TypeScript instrumentation

## Initialize once

Call `TraceRoot.initialize()` at the application entry point, before any LLM library imports. Load env vars first.

```typescript
import 'dotenv/config'; // must come before TraceRoot import
import { TraceRoot } from '@traceroot-ai/traceroot';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import * as lcCallbackManager from '@langchain/core/callbacks/manager';

TraceRoot.initialize({
  instrumentModules: {
    openAI: OpenAI,       // auto-instruments all OpenAI calls
    anthropic: Anthropic, // auto-instruments Anthropic calls
    langchain: lcCallbackManager,  // see LangChain note below
  },
  // Use only the modules present in the project
});
```

`TRACEROOT_API_KEY` is read from the environment automatically. No need to pass it explicitly.

Other supported `instrumentModules` keys: `claudeAgentSDK`, `bedrock`, `openaiAgents` (pass the imported module, same as above). Pass only the ones the project uses. For the Vercel AI SDK, no entry is needed — set `experimental_telemetry: { isEnabled: true }` on each call and TraceRoot enriches those spans automatically. For Mastra, use `@traceroot-ai/mastra`'s `TraceRootExporter` instead of `instrumentModules`.

The TS runtime supports fewer frameworks than Python (many agent frameworks are Python-only). The canonical, current list per runtime is https://traceroot.ai/docs/integrations/overview — treat the docs page as the source of truth, since coverage changes over time.

### LangChain note

Pass the callbacks manager module, not the LangChain class:

```typescript
import * as lcCallbackManager from '@langchain/core/callbacks/manager';

TraceRoot.initialize({
  instrumentModules: { langchain: lcCallbackManager },
});
```

## Add manual spans with `observe()`

Use `observe()` to wrap functions that represent meaningful steps: agent entrypoints, tool calls, orchestration logic.

```typescript
import { observe } from '@traceroot-ai/traceroot';

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
  { name: 'process_step', type: 'span', input: { query } },
  async () => await processQuery(query),
);
```

### `observe()` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `fn.name` or `'anonymous'` | Span name shown in the UI |
| `type` | `string` | `'span'` | `'span'`, `'tool'`, `'agent'`, or `'llm'` |
| `input` | `unknown` | — | Input data to record on the span |
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
