import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient, FindingDetail, TraceDetail } from "../../src/api/client.js";
import { runGet } from "../../src/commands/traces/get.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const LONG_INPUT = "x".repeat(250);

function span(over: Partial<TraceDetail["spans"][number]>): TraceDetail["spans"][number] {
  return {
    span_id: "s-1",
    trace_id: "t-1",
    parent_span_id: null,
    name: "span-one",
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
    cost: null,
    ...over,
  };
}

function detail(over: Partial<TraceDetail>): TraceDetail {
  return {
    trace_id: "t-1",
    project_id: "p-1",
    name: "my trace",
    trace_start_time: "2024-01-01T00:00:00Z",
    trace_url: "https://app.example.com/trace/t-1",
    session_id: null,
    user_id: null,
    input: LONG_INPUT,
    output: "the output",
    metadata: null,
    git_repo: null,
    git_ref: null,
    spans: [
      span({ span_id: "root", name: "root-span" }),
      span({ span_id: "child", parent_span_id: "root", name: "child-span" }),
    ],
    ...over,
  };
}

function finding(over: Partial<FindingDetail> = {}): FindingDetail {
  return {
    finding_id: "fnd-1",
    project_id: "p-1",
    trace_id: "t-1",
    summary: "a finding summary",
    timestamp: "2024-01-01T00:00:00Z",
    detectors: ["hallucination", "failure"],
    results: [],
    rca: { status: "done", result: "Root cause: the model cited a source absent from the tools." },
    ...over,
  };
}

function fakeClient(over: {
  trace?: TraceDetail;
  error?: Error;
  finding?: FindingDetail | null;
  findingError?: Error;
}): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("unused")),
    listTraces: () => Promise.reject(new Error("unused")),
    getTrace: () =>
      over.error ? Promise.reject(over.error) : Promise.resolve(over.trace as TraceDetail),
    exportTrace: () => Promise.reject(new Error("unused")),
    findFindingByTrace: () =>
      over.findingError ? Promise.reject(over.findingError) : Promise.resolve(over.finding ?? null),
  };
}

describe("runGet (human)", () => {
  it("renders the span tree and the verbatim trace_url", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({ client: fakeClient({ trace }), json: false, writers: w, traceId: "t-1" });

    // span tree
    expect(out.data).toContain("root-span");
    expect(out.data).toContain("child-span");
    // trace_url printed verbatim
    expect(out.data).toContain("https://app.example.com/trace/t-1");
    // human view no longer shows an Input/Output preview
    expect(out.data).not.toContain("Input:");
    expect(out.data).not.toContain("Output:");
  });

  it("renders the trace_url as an OSC 8 hyperlink on a TTY", async () => {
    const trace = detail({});
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: { out, err },
      traceId: "t-1",
    });
    const url = "https://app.example.com/trace/t-1";
    expect(out.data).toContain(`\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`);
  });

  it("does not construct a frontend URL (only the backend trace_url appears)", async () => {
    const trace = detail({ trace_url: "https://backend-built.example/abc" });
    const { writers: w, out } = writers();
    await runGet({ client: fakeClient({ trace }), json: false, writers: w, traceId: "t-1" });
    expect(out.data).toContain("https://backend-built.example/abc");
    expect(out.data).not.toContain("app.example.com");
  });

  it("derives Ended and Duration from the spans", async () => {
    const trace = detail({
      trace_start_time: "2024-01-01T00:00:00Z",
      spans: [
        span({ span_id: "root", span_end_time: "2024-01-01T00:00:01Z" }),
        span({ span_id: "child", parent_span_id: "root", span_end_time: "2024-01-01T00:00:02Z" }),
      ],
    });
    const { writers: w, out } = writers();
    await runGet({ client: fakeClient({ trace }), json: false, writers: w, traceId: "t-1" });

    // Ended = latest span end (the child's), duration = 2s from trace start.
    // (The displayed timestamp is localized, so assert the duration, not the raw string.)
    expect(out.data).toContain("Ended:");
    expect(out.data).toContain("Duration:");
    expect(out.data).toContain("2.0s");
  });

  it("marks a trace LIVE (no Ended, '***' marker) when a span has not ended", async () => {
    const trace = detail({
      spans: [span({ span_id: "root", span_end_time: null })],
    });
    const { writers: w, out } = writers();
    await runGet({ client: fakeClient({ trace }), json: false, writers: w, traceId: "t-1" });

    // Ongoing: no end time, a LIVE status, and a marker that more spans are coming.
    expect(out.data).not.toContain("Ended:");
    expect(out.data).toContain("LIVE");
    expect(out.data).toContain("*** (live");
  });
});

describe("runGet live Duration under a non-UTC timezone", () => {
  // trace_start_time is zone-less UTC; a bare `new Date(...)` reads it as LOCAL,
  // which blanks the elapsed Duration west of UTC and inflates it east. These
  // tests run under real non-UTC zones to prove the elapsed math is UTC-based.
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  /** Extracts the "Duration: <N>s (so far)" value (seconds) from the output. */
  function liveDurationSeconds(out: StringSink): number {
    const line = out.data.split("\n").find((l) => l.includes("Duration:")) as string;
    expect(line).toBeDefined();
    const match = /Duration:\s+([\d.]+)s/.exec(line);
    expect(match).not.toBeNull();
    return Number.parseFloat((match as RegExpExecArray)[1] as string);
  }

  for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
    it(`shows elapsed ~10m for a live trace (TZ=${tz})`, async () => {
      process.env.TZ = tz;
      // A zone-less UTC start ~10 minutes ago (drop the trailing Z the backend omits).
      const startedZoneless = new Date(Date.now() - 10 * 60_000).toISOString().slice(0, -1);
      const trace = detail({
        trace_start_time: startedZoneless,
        spans: [span({ span_id: "root", span_end_time: null })],
      });
      const { writers: w, out } = writers();
      await runGet({ client: fakeClient({ trace }), json: false, writers: w, traceId: "t-1" });
      expect(out.data).toContain("Duration:");
      // 10 minutes = 600s; allow a small tolerance for elapsed test time.
      expect(liveDurationSeconds(out)).toBeGreaterThanOrEqual(600);
      expect(liveDurationSeconds(out)).toBeLessThan(605);
    });
  }
});

describe("runGet (--json)", () => {
  it("writes exactly one doc: the full untruncated trace plus finding:null when unflagged", async () => {
    const trace = detail({});
    const { writers: w, out, err } = writers();
    await runGet({ client: fakeClient({ trace }), json: true, writers: w, traceId: "t-1" });

    const docs = out.data.trim().split("\n");
    expect(docs).toHaveLength(1);
    const parsed = JSON.parse(docs[0] as string);
    expect(parsed).toEqual({ ...trace, finding: null });
    // full input present, untruncated
    expect(parsed.input).toBe(LONG_INPUT);
    expect(out.data).not.toContain("truncated");
    expect(err.data).not.toContain("{");
  });

  it("includes the full finding object when the trace is flagged", async () => {
    const trace = detail({});
    const f = finding();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace, finding: f }),
      json: true,
      writers: w,
      traceId: "t-1",
    });
    const parsed = JSON.parse(out.data.trim());
    expect(parsed.finding).toEqual(f);
  });
});

describe("runGet (finding indicator)", () => {
  it("shows a Finding line and RCA preview when the trace is flagged", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace, finding: finding() }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).toContain("Finding ID:");
    expect(out.data).toContain("fnd-1");
    expect(out.data).toContain("hallucination");
    expect(out.data).toContain("RCA:");
    // The "<status> — " prefix is dropped; the RCA text is shown directly.
    expect(out.data).not.toContain("done —");
    expect(out.data).toContain("Root cause"); // preview of rca.result
    expect(out.data).toContain("findings get fnd-1"); // pointer to full detail
  });

  it("omits the Finding block for an unflagged trace", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace, finding: null }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).not.toContain("Finding ID:");
    expect(out.data).not.toContain("RCA:");
  });

  it("shows the Finding but no RCA line when rca is null", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace, finding: finding({ rca: null }) }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).toContain("Finding ID:");
    expect(out.data).not.toContain("RCA:");
  });

  it("shows the RCA status with no preview when the rca is still loading (result null)", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace, finding: finding({ rca: { status: "running", result: null } }) }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).toContain("RCA:");
    expect(out.data).toContain("running");
    // No preview text yet, so no " — <preview>" separator is appended.
    expect(out.data).not.toContain(" — ");
  });

  it("shows the Finding id without a '(flagged by …)' suffix when detectors is empty", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace, finding: finding({ detectors: [] }) }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).toContain("Finding ID:");
    expect(out.data).toContain("fnd-1");
    expect(out.data).not.toContain("flagged by");
  });

  it("truncates a long RCA preview to a single line ending in an ellipsis", async () => {
    const trace = detail({});
    const longResult = `Root cause: ${"x".repeat(200)} TAIL_MARKER`;
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({
        trace,
        finding: finding({ rca: { status: "done", result: longResult } }),
      }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).toContain("RCA:");
    expect(out.data).toContain("…");
    // The tail past the 80-char cap is dropped.
    expect(out.data).not.toContain("TAIL_MARKER");
  });

  it("strips a leading bullet and the status prefix from the RCA preview", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({
        trace,
        finding: finding({ rca: { status: "done", result: "- Root cause: boom" } }),
      }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).toContain("Root cause: boom");
    // No leading "- " bullet and no "done — " status prefix.
    expect(out.data).not.toContain("- Root cause");
    expect(out.data).not.toContain("done");
  });

  it("still renders the trace when the finding lookup fails (best-effort)", async () => {
    const trace = detail({});
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace, findingError: new CliError("Failed to read finding") }),
      json: false,
      writers: w,
      traceId: "t-1",
    });
    expect(out.data).toContain("root-span"); // trace still rendered
    expect(out.data).not.toContain("Finding ID:"); // finding silently omitted
  });
});

/** A trace with a 4-span linear chain: root → a → b → c, all OK. */
function chainTrace(): TraceDetail {
  return detail({
    spans: [
      span({ span_id: "root", name: "root", parent_span_id: null }),
      span({ span_id: "a", name: "a", parent_span_id: "root" }),
      span({ span_id: "b", name: "b", parent_span_id: "a" }),
      span({ span_id: "c", name: "c", parent_span_id: "b" }),
    ],
  });
}

describe("runGet --max-spans", () => {
  it("caps the JSON spans array and records the true total", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: true,
      writers: w,
      traceId: "t-1",
      maxSpans: 2,
    });
    const parsed = JSON.parse(out.data.trim());
    expect(parsed.spans).toHaveLength(2);
    expect(parsed.spans_truncated).toEqual({ shown: 2, total: 4 });
  });

  it("caps the human tree and appends an elision line with the true remainder", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: w,
      traceId: "t-1",
      maxSpans: 2,
    });
    expect(out.data).toContain("… 2 more spans");
  });

  it("adds no marker when the cap is not exceeded", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: true,
      writers: w,
      traceId: "t-1",
      maxSpans: 10,
    });
    const parsed = JSON.parse(out.data.trim());
    expect(parsed.spans).toHaveLength(4);
    expect(parsed.spans_truncated).toBeUndefined();
  });
});

describe("runGet --depth", () => {
  it("filters deep spans out of the JSON array", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: true,
      writers: w,
      traceId: "t-1",
      depth: 2,
    });
    const parsed = JSON.parse(out.data.trim());
    expect(parsed.spans.map((s: { span_id: string }) => s.span_id)).toEqual(["root", "a"]);
  });

  it("emits a depth elision marker in the human tree", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: w,
      traceId: "t-1",
      depth: 2,
    });
    expect(out.data).toContain("deeper span");
    expect(out.data).not.toContain("c [ok]");
  });
});

describe("runGet --errors-only", () => {
  /** root → a → err(ERROR), plus an unrelated OK branch root → other. */
  function errorTrace(): TraceDetail {
    return detail({
      spans: [
        span({ span_id: "root", name: "root", parent_span_id: null, status: "OK" }),
        span({ span_id: "a", name: "a", parent_span_id: "root", status: "OK" }),
        span({ span_id: "err", name: "err", parent_span_id: "a", status: "ERROR" }),
        span({ span_id: "other", name: "other", parent_span_id: "root", status: "OK" }),
      ],
    });
  }

  it("keeps error spans and their ancestors, dropping unrelated branches (JSON)", async () => {
    const trace = errorTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: true,
      writers: w,
      traceId: "t-1",
      errorsOnly: true,
    });
    const parsed = JSON.parse(out.data.trim());
    expect(parsed.spans.map((s: { span_id: string }) => s.span_id)).toEqual(["root", "a", "err"]);
  });

  it("drops the unrelated branch from the human tree", async () => {
    const trace = errorTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: w,
      traceId: "t-1",
      errorsOnly: true,
    });
    expect(out.data).toContain("err");
    expect(out.data).not.toContain("other");
  });

  it("indicates explicitly when no error spans match (JSON)", async () => {
    const trace = chainTrace(); // all OK
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: true,
      writers: w,
      traceId: "t-1",
      errorsOnly: true,
    });
    const parsed = JSON.parse(out.data.trim());
    expect(parsed.spans).toEqual([]);
    expect(parsed.errors_only_no_matches).toBe(true);
  });

  it("indicates explicitly when no error spans match (human)", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: w,
      traceId: "t-1",
      errorsOnly: true,
    });
    expect(out.data).toContain("no error spans");
  });
});

describe("runGet --output jsonl", () => {
  it("emits a header line then one JSON-parseable line per span; header excludes spans", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: w,
      traceId: "t-1",
      output: "jsonl",
    });
    const lines = out.data.trim().split("\n");
    expect(lines).toHaveLength(5); // 1 header + 4 spans
    const header = JSON.parse(lines[0] as string);
    expect(header.spans).toBeUndefined();
    expect(header.trace_id).toBe("t-1");
    expect(header.finding).toBeNull();
    for (const line of lines.slice(1)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[1] as string).span_id).toBe("root");
  });

  it("works without the global --json flag (jsonl implies machine output)", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: w,
      traceId: "t-1",
      output: "jsonl",
    });
    // Machine output only: no human tree connectors / labels.
    expect(out.data).not.toContain("Trace:");
    expect(out.data).not.toContain("[ok]");
  });

  it("carries the truncation marker on the header when capped", async () => {
    const trace = chainTrace();
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: false,
      writers: w,
      traceId: "t-1",
      output: "jsonl",
      maxSpans: 2,
    });
    const lines = out.data.trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 spans
    const header = JSON.parse(lines[0] as string);
    expect(header.spans_truncated).toEqual({ shown: 2, total: 4 });
  });
});

describe("runGet --max-spans selection consistency", () => {
  // Reviewer repro: sibling B appears BEFORE A in the backend array but A
  // starts earlier, so tree order (root, A, B) differs from array order
  // (root, B, A). Both modes must keep the SAME spans.
  function siblingTrace(): TraceDetail {
    return detail({
      spans: [
        span({
          span_id: "root",
          name: "root",
          parent_span_id: null,
          span_start_time: "2024-01-01T00:00:00Z",
        }),
        span({
          span_id: "B",
          name: "B",
          parent_span_id: "root",
          span_start_time: "2024-01-01T00:00:02Z",
        }),
        span({
          span_id: "A",
          name: "A",
          parent_span_id: "root",
          span_start_time: "2024-01-01T00:00:01Z",
        }),
      ],
    });
  }

  it("keeps the same spans in human and JSON (tree-order selection)", async () => {
    const human = writers();
    await runGet({
      client: fakeClient({ trace: siblingTrace() }),
      json: false,
      writers: human.writers,
      traceId: "t-1",
      maxSpans: 2,
    });
    const machine = writers();
    await runGet({
      client: fakeClient({ trace: siblingTrace() }),
      json: true,
      writers: machine.writers,
      traceId: "t-1",
      maxSpans: 2,
    });
    const parsed = JSON.parse(machine.out.data.trim());
    // Tree order is root → A (earlier start) → B, so the cap keeps root and A
    // in BOTH modes; B is the elided span everywhere.
    expect(parsed.spans.map((s: { span_id: string }) => s.span_id).sort()).toEqual(["A", "root"]);
    expect(human.out.data).toContain("A [ok]");
    expect(human.out.data).not.toContain("B [ok]");
    expect(parsed.spans_truncated).toEqual({ shown: 2, total: 3 });
  });

  it("emits the kept spans in the original backend array order", async () => {
    // Child c1 precedes its parent in the array; both survive the cap, so the
    // JSON must keep the array order [c1, root], not tree order [root, c1].
    const trace = detail({
      spans: [
        span({
          span_id: "c1",
          name: "c1",
          parent_span_id: "root",
          span_start_time: "2024-01-01T00:00:01Z",
        }),
        span({
          span_id: "root",
          name: "root",
          parent_span_id: null,
          span_start_time: "2024-01-01T00:00:00Z",
        }),
        span({
          span_id: "c2",
          name: "c2",
          parent_span_id: "root",
          span_start_time: "2024-01-01T00:00:02Z",
        }),
      ],
    });
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: true,
      writers: w,
      traceId: "t-1",
      maxSpans: 2,
    });
    const parsed = JSON.parse(out.data.trim());
    // Keep-set from tree order = {root, c1}; emitted array-stable as [c1, root].
    expect(parsed.spans.map((s: { span_id: string }) => s.span_id)).toEqual(["c1", "root"]);
    expect(parsed.spans_truncated).toEqual({ shown: 2, total: 3 });
  });
});

describe("runGet (flags compose)", () => {
  it("applies --errors-only before --max-spans; total reflects the post-filter set", async () => {
    // root → a → err(ERROR); a second error branch root → b → err2(ERROR).
    const trace = detail({
      spans: [
        span({ span_id: "root", name: "root", parent_span_id: null, status: "OK" }),
        span({ span_id: "a", name: "a", parent_span_id: "root", status: "OK" }),
        span({ span_id: "err", name: "err", parent_span_id: "a", status: "ERROR" }),
        span({ span_id: "b", name: "b", parent_span_id: "root", status: "OK" }),
        span({ span_id: "err2", name: "err2", parent_span_id: "b", status: "ERROR" }),
      ],
    });
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ trace }),
      json: true,
      writers: w,
      traceId: "t-1",
      errorsOnly: true,
      maxSpans: 2,
    });
    const parsed = JSON.parse(out.data.trim());
    // All 5 spans are on an error path, so the post-filter total is 5, capped to 2.
    expect(parsed.spans).toHaveLength(2);
    expect(parsed.spans_truncated).toEqual({ shown: 2, total: 5 });
  });
});

describe("runGet (errors)", () => {
  it("rejects and writes nothing to stdout on an unknown id", async () => {
    const { writers: w, out } = writers();
    await expect(
      runGet({
        client: fakeClient({ error: new CliError("trace not found") }),
        json: false,
        writers: w,
        traceId: "missing",
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(out.data).toBe("");
  });
});
