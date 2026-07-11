// A throwaway localhost stand-in for the TraceRoot public API, run as its OWN
// process so the contract tests can drive the real binary via the synchronous
// `spawnSync` (an in-process server can't respond while spawnSync blocks the
// shared event loop). Serves one trace detail with a configurable span count and
// 404s the finding lookup (→ finding: null). Prints `PORT <n>` once listening.
import { createServer } from "node:http";

const spanCount = Number.parseInt(process.env.SPAN_COUNT ?? "2000", 10);

function makeTrace(traceId) {
  const spans = Array.from({ length: spanCount }, (_, i) => ({
    span_id: `s-${i}`,
    trace_id: traceId,
    parent_span_id: i === 0 ? null : `s-${i - 1}`,
    name: `span-${i}`,
    span_kind: "INTERNAL",
    status: "OK",
    status_message: null,
    span_start_time: "2024-01-01T00:00:00Z",
    span_end_time: "2024-01-01T00:00:01Z",
    input: null,
    output: null,
    metadata: null,
    model_name: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_details: {},
    usage_details: {},
  }));
  return {
    trace_id: traceId,
    project_id: "p-1",
    name: "contract trace",
    trace_start_time: "2024-01-01T00:00:00Z",
    trace_url: "https://app.example.com/trace/contract",
    session_id: null,
    user_id: null,
    input: null,
    output: null,
    metadata: null,
    git_repo: null,
    git_ref: null,
    spans,
  };
}

const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (/\/finding$/.test(url)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "not flagged" }));
    return;
  }
  const match = /\/api\/v1\/public\/traces\/([^/?]+)/.exec(url);
  if (match) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(makeTrace(decodeURIComponent(match[1]))));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ detail: "unknown" }));
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
