import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient, TraceDetail } from "../../src/api/client.js";
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

function fakeClient(over: { trace?: TraceDetail; error?: Error }): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("unused")),
    listTraces: () => Promise.reject(new Error("unused")),
    getTrace: () =>
      over.error ? Promise.reject(over.error) : Promise.resolve(over.trace as TraceDetail),
    exportTrace: () => Promise.reject(new Error("unused")),
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
  it("writes exactly one doc equal to the full untruncated trace", async () => {
    const trace = detail({});
    const { writers: w, out, err } = writers();
    await runGet({ client: fakeClient({ trace }), json: true, writers: w, traceId: "t-1" });

    const docs = out.data.trim().split("\n");
    expect(docs).toHaveLength(1);
    const parsed = JSON.parse(docs[0] as string);
    expect(parsed).toEqual(trace);
    // full input present, untruncated
    expect(parsed.input).toBe(LONG_INPUT);
    expect(out.data).not.toContain("truncated");
    expect(err.data).not.toContain("{");
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
