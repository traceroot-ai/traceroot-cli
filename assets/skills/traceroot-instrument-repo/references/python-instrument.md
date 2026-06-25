# Python instrumentation

## Initialize once

Call `traceroot.initialize()` at the application entry point, before any LLM library imports. Load env vars first.

```python
from dotenv import load_dotenv
load_dotenv()  # must come before traceroot import

import traceroot
from traceroot import Integration

traceroot.initialize(
    integrations=[
        Integration.OPENAI,      # auto-instruments all OpenAI calls
        Integration.LANGCHAIN,   # auto-instruments LangChain/LangGraph
        Integration.ANTHROPIC,   # auto-instruments Anthropic calls
    ]
    # Use only the integrations present in the project
)
```

`TRACEROOT_API_KEY` is read from the environment automatically. No need to pass it explicitly.

### Supported integrations

TraceRoot auto-instruments many model providers and agent frameworks (OpenAI, Anthropic,
LangChain/LangGraph, and more). The canonical, current list is the docs integrations overview:
**https://traceroot.ai/docs/integrations/overview** — coverage changes over time, so treat the
docs page (not this file) as the source of truth, and don't assume a library is unsupported
without checking it.

Pass only the `Integration.*` members for libraries the project actually uses. The enum names
aren't always the obvious ones (e.g. Gemini is `Integration.GOOGLE_GENAI`), so rather than
guessing, list the exact members available in the installed SDK:

```python
from traceroot import Integration
print([i.name for i in Integration])  # exact members for your installed version
```

## Add manual spans with `@observe`

Use `@observe` on functions that represent meaningful steps: agent entrypoints, tool calls, orchestration logic.

```python
from traceroot import observe

@observe(name="agent.run", type="agent")
def run_agent(query: str) -> str:
    return process(query)

@observe(name="search_tool", type="tool")
def search(query: str) -> list:
    return do_search(query)

# Works with async functions too
@observe(name="async_step", type="span")
async def async_step(input: str) -> str:
    return await process(input)
```

### `@observe` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `str` | function name | Span name shown in the UI |
| `type` | `str` | `"span"` | `"span"`, `"tool"`, `"agent"`, or `"llm"` |
| `metadata` | `dict` | `None` | Static metadata to attach |
| `tags` | `list[str]` | `None` | Tags for filtering |

## Set user and session context

Use `using_attributes` as a context manager — all traces created inside inherit the values.

```python
from traceroot import using_attributes

with using_attributes(user_id="user-123", session_id="sess-456"):
    result = run_agent("What is the weather?")
```

## Update spans and traces programmatically

For custom providers or when you need to set attributes after the fact:

```python
from traceroot import update_current_span, update_current_trace

# Inside an @observe-decorated function:
update_current_span(
    input={"query": "hello"},
    output={"response": "world"},
    model="gpt-4o",
    model_parameters={"temperature": 0.7, "max_tokens": 1024},
    usage={"input_tokens": 100, "output_tokens": 50},
    prompt=[{"role": "user", "content": "hello"}],
)

update_current_trace(
    user_id="user-123",
    session_id="sess-456",
    tags=["production"],
    metadata={"environment": "prod"},
)
```

## Flush in short-lived scripts

```python
if __name__ == "__main__":
    run_my_script()
    traceroot.flush()  # export all buffered spans before exit
```

## What to instrument

**Prioritize:**
- Request/response boundaries (API handlers, queue consumers, cron jobs)
- Agent entrypoints and their major steps
- Tool calls and external calls not already auto-instrumented

**Avoid:**
- Low-level utilities called in tight loops
- Small pure functions that add noise
- Per-item spans in large fanout loops (use one span around the loop)
