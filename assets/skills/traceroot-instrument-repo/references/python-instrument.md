# Python instrumentation

## Initialize once, on the path that runs the application

Call `traceroot.initialize()` where it runs when the application is **run** — inside the entry
point's `if __name__ == "__main__":` block — and not at module scope. Module scope runs on import,
and a project's test suite imports its entry point: initialize there and every test that reaches an
instrumented function exports a trace of its own, each one indistinguishable from the
application's afterwards. Load the env vars on that same path, beside it.

The order that matters is not the import order. `initialize()` has to run before the first model
call and before the first `@observe`-decorated function runs: `@observe` starts the SDK itself when
nothing else has, and a second `initialize()` after that is skipped with a warning, so the
integrations named here would never be applied. Auto-instrumentation patches the provider library's
own methods through `wrapt`, which takes effect whatever the import order — so leave the provider
imports where they are.

```python
from dotenv import load_dotenv

import traceroot
from traceroot import Integration

if __name__ == "__main__":
    load_dotenv()
    traceroot.initialize(
        integrations=[
            Integration.OPENAI,      # auto-instruments all OpenAI calls
            Integration.LANGCHAIN,   # auto-instruments LangChain/LangGraph
            Integration.ANTHROPIC,   # auto-instruments Anthropic calls
        ]
        # Use only the integrations present in the project
    )
    main()  # whatever this entry point already does
```

Two shapes cannot do this. A module another process imports in order to run it — uvicorn,
gunicorn, a queue worker — has no such block, so initialize at the framework's own startup hook
instead. And an application that needs its own credentials while it is still being imported has to
keep the load at module scope. In either case, run the project's own checks with
`TRACEROOT_ENABLED=false` in the environment so that they do not export. None of this belongs in
the project's test configuration — not a `conftest.py`, not a fixture, not a `pytest.ini`.

`TRACEROOT_API_KEY` is read from the environment automatically. No need to pass it explicitly.

### Supported integrations

TraceRoot auto-instruments many model providers and agent frameworks (OpenAI, Anthropic,
LangChain/LangGraph, and more). The installed SDK is the current list — read it with the one command below rather than fetching
a docs page, which costs a network round trip to learn something the package already knows.
Coverage changes over time, so don't assume a library is unsupported without looking.

Pass only the `Integration.*` members for libraries the project actually uses. The enum names
aren't always the obvious ones (e.g. Gemini is `Integration.GOOGLE_GENAI`), so rather than
guessing, list the exact members available in the installed SDK:

```python
from traceroot import Integration
print([i.name for i in Integration])  # exact members for your installed version
```

Run this **once**, with the interpreter your task names rather than bare `python`, and read every
member you need off that single result. Re-checking per integration is the same answer again at
the cost of another interpreter start.

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
