import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { ApiClient, TraceList } from "../../src/api/client.js";
import { buildProgram } from "../../src/cli.js";
import {
  formatLocalDisplay,
  parseLimit,
  renderRangeSummary,
  resolveTimeRange,
  runList,
} from "../../src/commands/traces/list.js";
import { CliError, type Writers } from "../../src/output.js";
import { runCli } from "../helpers/runCli.js";
import { StringSink } from "../helpers/stringSink.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

function listItem(over: Partial<TraceList["data"][number]>): TraceList["data"][number] {
  return {
    trace_id: "t-1",
    project_id: "p-1",
    name: "trace one",
    trace_start_time: "2024-01-01T00:00:00Z",
    trace_url: "https://app.example.com/trace/t-1",
    duration_ms: 1234,
    span_count: 3,
    error_count: 0,
    session_id: null,
    user_id: null,
    input: null,
    output: null,
    total_cost: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    ...over,
  };
}

interface FakeState {
  lastListParams?: { limit?: number; startAfter?: string; endBefore?: string };
}

function fakeClient(res: TraceList, state: FakeState = {}): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("unused")),
    listTraces: (params?: { limit?: number; startAfter?: string; endBefore?: string }) => {
      state.lastListParams = params;
      return Promise.resolve(res);
    },
    getTrace: () => Promise.reject(new Error("unused")),
    exportTrace: () => Promise.reject(new Error("unused")),
  };
}

const META: TraceList["meta"] = { page: 1, limit: 50, total: 2 };

/**
 * Extracts one column's cell from a rendered data row. Columns are width-aligned,
 * so a header's start offset on the header line marks that cell's start on every
 * row; the next header's offset marks its end. This verifies a value lands in the
 * intended column rather than merely appearing somewhere on the line.
 */
function cellAt(dataLine: string, headerLine: string, header: string, nextHeader?: string): string {
  const start = headerLine.indexOf(header);
  const end = nextHeader === undefined ? dataLine.length : headerLine.indexOf(nextHeader);
  return dataLine.slice(start, end).trim();
}

describe("runList (human)", () => {
  it("renders ERRORS/SPANS columns in order with no STATUS column", async () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "ok-1", span_count: 4, error_count: 0 }),
        listItem({ trace_id: "err-1", span_count: 7, error_count: 2 }),
      ],
      meta: META,
    };
    const { writers: w, out, err } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });

    const lines = out.data.split("\n");
    const headerLine = lines.find((l) => l.includes("STARTED")) as string;
    // Column order matches the cloud UI; the STATUS column is gone.
    expect(headerLine).not.toContain("STATUS");
    expect(headerLine).toMatch(/STARTED\s+DURATION\s+NAME\s+ERRORS\s+SPANS\s+TRACE ID/);

    // Counts land in their own columns (checked by column offset, not by the
    // digit merely appearing somewhere on the line).
    const okLine = lines.find((l) => l.includes("ok-1")) as string;
    const errLine = lines.find((l) => l.includes("err-1")) as string;
    expect(cellAt(okLine, headerLine, "ERRORS", "SPANS")).toBe("0");
    expect(cellAt(okLine, headerLine, "SPANS", "TRACE ID")).toBe("4");
    expect(cellAt(errLine, headerLine, "ERRORS", "SPANS")).toBe("2");
    expect(cellAt(errLine, headerLine, "SPANS", "TRACE ID")).toBe("7");

    // No JSON written to stdout in human mode.
    expect(out.data.trimStart().startsWith("{")).toBe(false);
    expect(err.data).not.toContain("{");
  });

  it("emits no ANSI escapes when the sink is not a TTY", async () => {
    const res: TraceList = { data: [listItem({})], meta: META };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    expect(out.data).not.toContain("\x1b[");
  });

  it("renders an unfinished trace (duration_ms null) with no STATUS column", async () => {
    const res: TraceList = {
      data: [listItem({ trace_id: "unfin-1", duration_ms: null, error_count: 0 })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    const headerLine = out.data.split("\n").find((l) => l.includes("STARTED")) as string;
    // The row renders; liveness is no longer expressed as a STATUS label.
    expect(out.data).toContain("unfin-1");
    expect(headerLine).not.toContain("STATUS");
  });

  it("bolds the header row on a TTY", async () => {
    const res: TraceList = { data: [listItem({})], meta: META };
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runList({ client: fakeClient(res), json: false, writers: { out, err } });
    // The header line is wrapped in the ANSI bold code; data rows are not.
    expect(out.data).toContain("\x1b[1m");
    expect(out.data).toContain("STARTED");
  });

  it("reds the whole row for an errored trace on a TTY", async () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "ok-1", error_count: 0 }),
        listItem({ trace_id: "err-1", error_count: 3 }),
      ],
      meta: META,
    };
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runList({ client: fakeClient(res), json: false, writers: { out, err } });
    const errLine = out.data.split("\n").find((l) => l.includes("err-1")) as string;
    const okLine = out.data.split("\n").find((l) => l.includes("ok-1")) as string;
    expect(errLine).toContain("\x1b[91m"); // bright red
    expect(okLine).not.toContain("\x1b[91m");
  });

  it("does not red an unfinished trace row (error_count 0) on a TTY", async () => {
    const res: TraceList = {
      data: [listItem({ trace_id: "unfin-1", duration_ms: null, error_count: 0 })],
      meta: META,
    };
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runList({ client: fakeClient(res), json: false, writers: { out, err } });
    const row = out.data.split("\n").find((l) => l.includes("unfin-1")) as string;
    // Red is keyed on error_count, not liveness, so a live row stays uncolored.
    expect(row).not.toContain("\x1b[91m");
  });

  it("does NOT have a STARTED ISO column (no --wide mode exists)", async () => {
    const res: TraceList = {
      data: [listItem({ trace_start_time: "2026-06-23T20:31:02.000000" })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    expect(out.data).not.toContain("STARTED ISO");
  });
});

describe("runList (--json)", () => {
  it("writes exactly one JSON doc with data, meta, count, and range keys", async () => {
    const res: TraceList = { data: [listItem({ trace_id: "j-1" })], meta: META };
    const { writers: w, out, err } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });

    const docs = out.data.trim().split("\n");
    expect(docs).toHaveLength(1);
    const parsed = JSON.parse(docs[0] as string) as Record<string, unknown>;
    // Original data and meta still present (non-breaking)
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("meta");
    expect((parsed.data as unknown[]).length).toBe(1);
    // New top-level keys
    expect(parsed).toHaveProperty("count", 1);
    expect(parsed).toHaveProperty("range");
    expect(err.data).not.toContain("{");
  });

  it("JSON range.label is 'all traces' when no bounds are given", async () => {
    const res: TraceList = { data: [listItem({ trace_id: "j-2" })], meta: META };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    const range = parsed.range as Record<string, unknown>;
    expect(range.label).toBe("all traces");
    expect(range.startAfter).toBeNull();
    expect(range.endBefore).toBeNull();
  });

  it("JSON range.label is 'since 2m' when sinceLabel is set", async () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    await runList({
      client: fakeClient(res),
      json: true,
      writers: w,
      startAfter: "2026-06-23T20:28:00.000Z",
      sinceLabel: "2m",
    });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    const range = parsed.range as Record<string, unknown>;
    expect(range.label).toBe("since 2m");
    expect(range.startAfter).toBe("2026-06-23T20:28:00.000Z");
    expect(range.endBefore).toBeNull();
  });

  it("JSON range.label is 'from <ISO> to before <ISO>' for both bounds", async () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    await runList({
      client: fakeClient(res),
      json: true,
      writers: w,
      startAfter: "2026-06-23T20:28:35.000Z",
      endBefore: "2026-06-23T20:31:02.000Z",
    });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    const range = parsed.range as Record<string, unknown>;
    expect(range.label).toBe("from 2026-06-23T20:28:35.000Z to before 2026-06-23T20:31:02.000Z");
    expect(range.startAfter).toBe("2026-06-23T20:28:35.000Z");
    expect(range.endBefore).toBe("2026-06-23T20:31:02.000Z");
  });

  it("JSON range.label is 'from <ISO>' for startAfter-only", async () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    await runList({
      client: fakeClient(res),
      json: true,
      writers: w,
      startAfter: "2026-06-23T20:28:35.000Z",
    });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    const range = parsed.range as Record<string, unknown>;
    expect(range.label).toBe("from 2026-06-23T20:28:35.000Z");
    expect(range.startAfter).toBe("2026-06-23T20:28:35.000Z");
    expect(range.endBefore).toBeNull();
  });

  it("JSON range.label is 'before <ISO>' for endBefore-only", async () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    await runList({
      client: fakeClient(res),
      json: true,
      writers: w,
      endBefore: "2026-06-23T20:31:02.000Z",
    });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    const range = parsed.range as Record<string, unknown>;
    expect(range.label).toBe("before 2026-06-23T20:31:02.000Z");
    expect(range.startAfter).toBeNull();
    expect(range.endBefore).toBe("2026-06-23T20:31:02.000Z");
  });

  it("JSON count equals res.data.length", async () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "c-1" }),
        listItem({ trace_id: "c-2" }),
        listItem({ trace_id: "c-3" }),
      ],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    expect(parsed.count).toBe(3);
  });

  it("exposes trace_start_time as a copyable ISO field in each trace", async () => {
    // Confirm --json exposes the backend canonical field (no footer/tip on stdout).
    const trace = listItem({ trace_id: "j-ts", trace_start_time: "2026-06-23T20:31:02.000000" });
    const res: TraceList = { data: [trace], meta: META };
    const { writers: w, out, err } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });

    const parsed = JSON.parse(out.data.trim()) as TraceList & { count: number; range: unknown };
    expect(parsed.data[0]).toHaveProperty("trace_start_time");
    // No footer on stderr in JSON mode
    expect(err.data).toBe("");
    // stdout is ONLY the JSON, no extra lines
    expect(out.data.trim().split("\n")).toHaveLength(1);
  });

  it("JSON does NOT include footer or tip text in stdout", async () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out, err } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });
    expect(out.data).not.toContain("Tip:");
    expect(out.data).not.toContain("trace(s)");
    expect(err.data).toBe("");
  });
});

describe("runList (--limit forwarding)", () => {
  it("forwards the limit to listTraces", async () => {
    const state: FakeState = {};
    const res: TraceList = { data: [], meta: META };
    const { writers: w } = writers();
    await runList({ client: fakeClient(res, state), json: false, writers: w, limit: 5 });
    expect(state.lastListParams).toEqual({ limit: 5 });
  });

  it("omits params when no limit is given", async () => {
    const state: FakeState = {};
    const res: TraceList = { data: [], meta: META };
    const { writers: w } = writers();
    await runList({ client: fakeClient(res, state), json: false, writers: w });
    expect(state.lastListParams).toBeUndefined();
  });
});

describe("runList (time-range forwarding)", () => {
  it("forwards startAfter and endBefore to listTraces", async () => {
    const state: FakeState = {};
    const res: TraceList = { data: [], meta: META };
    const { writers: w } = writers();
    await runList({
      client: fakeClient(res, state),
      json: false,
      writers: w,
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
    expect(state.lastListParams).toEqual({
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
  });
});

describe("resolveTimeRange", () => {
  const fixedNow = () => Date.parse("2024-06-15T12:00:00.000Z");

  it("returns an empty range when no flags are given", () => {
    expect(resolveTimeRange({})).toEqual({});
  });

  it("turns --since into a startAfter window ending now (no endBefore)", () => {
    expect(resolveTimeRange({ since: "24h" }, fixedNow)).toEqual({
      startAfter: "2024-06-14T12:00:00.000Z",
      sinceLabel: "24h",
    });
  });

  it("maps --from/--to to startAfter/endBefore", () => {
    expect(resolveTimeRange({ from: "2024-01-01T00:00:00Z", to: "2024-02-01T00:00:00Z" })).toEqual({
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
  });

  it("treats a bare date as midnight UTC and a zone-less time as UTC", () => {
    expect(resolveTimeRange({ from: "2024-03-04" }).startAfter).toBe("2024-03-04T00:00:00.000Z");
    expect(resolveTimeRange({ from: "2024-03-04T09:30:00" }).startAfter).toBe(
      "2024-03-04T09:30:00.000Z",
    );
  });

  it("rejects an inverted --from/--to range with an ordering message", () => {
    expect(() =>
      resolveTimeRange({ from: "2024-02-01T00:00:00Z", to: "2024-01-01T00:00:00Z" }),
    ).toThrow(/--from must resolve to an earlier time than --to/);
  });

  it("rejects an equal --from/--to range explaining inclusive/exclusive bounds", () => {
    expect(() =>
      resolveTimeRange({ from: "2024-01-01T00:00:00Z", to: "2024-01-01T00:00:00Z" }),
    ).toThrow(/resolve to the same time.*inclusive.*exclusive/s);
  });

  it("rejects combining --since with --from or --to", () => {
    expect(() => resolveTimeRange({ since: "24h", from: "2024-01-01T00:00:00Z" })).toThrow(
      CliError,
    );
    expect(() => resolveTimeRange({ since: "24h", to: "2024-01-01T00:00:00Z" })).toThrow(CliError);
  });

  it("rejects an invalid duration or timestamp", () => {
    expect(() => resolveTimeRange({ since: "soon" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "not-a-date" })).toThrow(CliError);
  });

  it("rejects a --since window so large it overflows the date range", () => {
    expect(() => resolveTimeRange({ since: "99999999w" })).toThrow(CliError);
  });

  // ── Quoted display timestamp format ──────────────────────────────────────

  it("accepts a quoted display timestamp for --from (Denver/MDT)", () => {
    // "2026-06-23 14:31:02 MDT" in America/Denver = 2026-06-23T20:31:02.000Z
    const result = resolveTimeRange(
      { from: "2026-06-23 14:31:02 MDT" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-06-23T20:31:02.000Z");
  });

  it("accepts a quoted display timestamp for --to (Denver/MDT)", () => {
    // "2026-06-23 14:31:02 MDT" = 2026-06-23T20:31:02.000Z
    const result = resolveTimeRange({ to: "2026-06-23 14:31:02 MDT" }, Date.now, "America/Denver");
    expect(result.endBefore).toBe("2026-06-23T20:31:02.000Z");
  });

  it("accepts a quoted STARTED value with a GMT±offset abbreviation (IST/JST/etc.)", () => {
    // The STARTED column shows "GMT+5:30" in zones Intl renders as GMT offsets;
    // the explicit offset is parsed directly (no local-zone lookup needed).
    // 17:30:00 +05:30 = 12:00:00 UTC; 21:00:00 +09:00 = 12:00:00 UTC.
    expect(resolveTimeRange({ from: "2026-06-23 17:30:00 GMT+5:30" }).startAfter).toBe(
      "2026-06-23T12:00:00.000Z",
    );
    expect(resolveTimeRange({ to: "2026-06-23 21:00:00 GMT+9" }).endBefore).toBe(
      "2026-06-23T12:00:00.000Z",
    );
    expect(resolveTimeRange({ from: "2026-06-23 09:00:00 GMT-3" }).startAfter).toBe(
      "2026-06-23T12:00:00.000Z",
    );
  });

  it("rejects invalid GMT±offset display values (no normalization)", () => {
    expect(() => resolveTimeRange({ from: "2026-02-31 17:30:00 GMT+5:30" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "2026-06-23 25:30:00 GMT+5:30" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "2026-06-23 17:30:00 GMT+99" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "2026-06-23 17:30:00 GMT+5:99" })).toThrow(CliError);
  });

  it("accepts display timestamps for both --from and --to (Denver/MDT)", () => {
    const result = resolveTimeRange(
      {
        from: "2026-06-23 14:28:35 MDT",
        to: "2026-06-23 14:31:02 MDT",
      },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-06-23T20:28:35.000Z");
    expect(result.endBefore).toBe("2026-06-23T20:31:02.000Z");
  });

  it("rejects a display timestamp with mismatched abbreviation (PST given but Denver is MDT)", () => {
    expect(() =>
      resolveTimeRange({ from: "2026-06-23 14:31:02 PST" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("rejects a summer MST abbreviation when the local zone is MDT (Denver)", () => {
    // In June, Denver uses MDT (UTC-6), not MST (UTC-7)
    expect(() =>
      resolveTimeRange({ from: "2026-06-23 14:31:02 MST" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("accepts a quoted display timestamp for --from in winter (Denver/MST)", () => {
    // "2026-12-23 14:31:02 MST" in America/Denver = 2026-12-23T21:31:02.000Z (MST = UTC-7)
    const result = resolveTimeRange(
      { from: "2026-12-23 14:31:02 MST" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-12-23T21:31:02.000Z");
  });

  it("accepts fall-back ambiguous wall-clock with MDT abbreviation (earlier/pre-transition occurrence)", () => {
    // On 2026-11-01 in America/Denver, the clock falls back at 02:00 MDT → 01:00 MST.
    // 01:30:00 occurs twice. The implementation resolves to the EARLIER (MDT, UTC-6) instant.
    // Observed: resolveTimeRange({ from: "2026-11-01 01:30:00 MDT" }, ...) → 2026-11-01T07:30:00.000Z
    const result = resolveTimeRange(
      { from: "2026-11-01 01:30:00 MDT" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-11-01T07:30:00.000Z");
  });

  it("rejects fall-back ambiguous wall-clock with MST abbreviation (abbreviation mismatch)", () => {
    // On 2026-11-01 in America/Denver, 01:30:00 is ambiguous (falls in the DST fold).
    // The implementation resolves to the earlier (MDT) occurrence, so the zone abbreviation
    // for the resolved instant is MDT — not the typed MST. This mismatch causes rejection.
    expect(() =>
      resolveTimeRange({ from: "2026-11-01 01:30:00 MST" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("error message for mismatched abbreviation is actionable", () => {
    let message = "";
    try {
      resolveTimeRange({ from: "2026-06-23 14:31:02 PST" }, Date.now, "America/Denver");
    } catch (e) {
      message = (e as Error).message;
    }
    // Should mention the bad abbreviation, local zone, and suggest ISO 8601 with offset
    expect(message).toContain("PST");
    expect(message).toContain("America/Denver");
    expect(message).toContain("ISO 8601");
  });
});

describe("parseLimit", () => {
  it("returns undefined when absent", () => {
    expect(parseLimit(undefined)).toBeUndefined();
  });

  it("parses a positive integer", () => {
    expect(parseLimit("5")).toBe(5);
  });

  it("throws CliError on non-integer, zero, or negative", () => {
    expect(() => parseLimit("abc")).toThrow(CliError);
    expect(() => parseLimit("0")).toThrow(CliError);
    expect(() => parseLimit("-3")).toThrow(CliError);
    expect(() => parseLimit("1.5")).toThrow(CliError);
  });
});

describe("resolveTimeRange (additional cases)", () => {
  it("parses an explicit UTC offset like 2026-06-23T14:29:54-06:00", () => {
    const range = resolveTimeRange({ from: "2026-06-23T14:29:54-06:00" });
    // -06:00 means 14:29:54 local = 20:29:54 UTC
    expect(range.startAfter).toBe("2026-06-23T20:29:54.000Z");
  });
});

describe("traces list command surface", () => {
  it("registers --limit and no --status option", () => {
    const program = buildProgram();
    const traces = program.commands.find((c) => c.name() === "traces") as Command;
    const list = traces.commands.find((c) => c.name() === "list") as Command;
    const optionNames = list.options.map((o) => o.long);
    expect(optionNames).toContain("--limit");
    expect(optionNames).toContain("--since");
    expect(optionNames).toContain("--from");
    expect(optionNames).toContain("--to");
    // --wide has been removed
    expect(optionNames).not.toContain("--wide");
    expect(optionNames).not.toContain("--status");
  });

  it("rejects --status at the CLI before any network (hermetic)", () => {
    const result = runCli("traces", "list", "--status", "ok");
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("unknown option");
  });

  it("rejects --wide at the CLI (removed flag)", () => {
    const result = runCli("traces", "list", "--wide");
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("unknown option");
  });

  it("rejects stray positional args from a split local timestamp (hermetic)", () => {
    // Simulates: traceroot traces list --from 2026-06-23 14:29:54 MDT
    // Shell splits: --from=2026-06-23, then 14:29:54 and MDT become stray args
    const result = runCli("traces", "list", "--from", "2026-06-23", "14:29:54", "MDT");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpected argument(s)");
    expect(result.stderr).toContain("14:29:54");
    expect(result.stderr).toContain("MDT");
    expect(result.stderr).toContain("--from");
    expect(result.stderr).toContain("ISO 8601");
  });

  it("rejects a generic stray positional argument (hermetic)", () => {
    const result = runCli("traces", "list", "extra");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpected argument(s)");
    expect(result.stderr).toContain("extra");
    expect(result.stderr).toContain("ISO 8601");
  });

  it("still accepts a bare date --from with no stray args", () => {
    // A lone --from 2026-06-23 (deliberate bare date) should NOT be rejected.
    // Without API key it will fail on requireApiClient, not on stray-args or
    // timestamp validation — proving the bare date was accepted as valid.
    const result = runCli("traces", "list", "--from", "2026-06-23");
    expect(result.status).not.toBe(0);
    // Should NOT produce the stray-args message
    expect(result.stderr).not.toContain("unexpected argument(s)");
    // Should NOT produce the ISO 8601 rejection (i.e. the bare date was accepted)
    expect(result.stderr).not.toContain("ISO 8601");
    // Should fall through to the auth error, confirming that path was reached
    expect(result.stderr.toLowerCase()).toContain("api key");
  });
});

// ─── renderRangeSummary (pure unit tests) ──────────────────────────────────

describe("renderRangeSummary", () => {
  const TZ = "America/Denver"; // MDT in June (UTC-6)

  it("returns 'all traces' when no bounds are set", () => {
    expect(renderRangeSummary({})).toBe("all traces");
  });

  it("returns 'since <label>' when sinceLabel is set (ignores bounds)", () => {
    expect(renderRangeSummary({ sinceLabel: "2m" })).toBe("since 2m");
    expect(renderRangeSummary({ sinceLabel: "24h", startAfter: "2026-06-23T20:00:00.000Z" })).toBe(
      "since 24h",
    );
  });

  it("returns 'from <local 24h>' for startAfter-only (Denver/MDT)", () => {
    // 2026-06-23T20:29:54Z = 14:29:54 MDT
    const result = renderRangeSummary({ startAfter: "2026-06-23T20:29:54.000Z" }, TZ);
    expect(result).toBe("from 2026-06-23 14:29:54 MDT");
  });

  it("returns 'before <local 24h>' for endBefore-only (Denver/MDT)", () => {
    // 2026-06-23T20:31:02Z = 14:31:02 MDT
    const result = renderRangeSummary({ endBefore: "2026-06-23T20:31:02.000Z" }, TZ);
    expect(result).toBe("before 2026-06-23 14:31:02 MDT");
  });

  it("returns 'from … to before …' for both bounds (Denver/MDT)", () => {
    const result = renderRangeSummary(
      {
        startAfter: "2026-06-23T20:28:35.000Z", // 14:28:35 MDT
        endBefore: "2026-06-23T20:31:02.000Z", // 14:31:02 MDT
      },
      TZ,
    );
    expect(result).toBe("from 2026-06-23 14:28:35 MDT to before 2026-06-23 14:31:02 MDT");
  });
});

// ─── formatLocalDisplay (pure unit tests) ──────────────────────────────────

describe("formatLocalDisplay", () => {
  it("formats a UTC ISO string as the local 24-hour table form (YYYY-MM-DD HH:mm:ss TZ)", () => {
    // 2026-06-23T20:29:54Z = 14:29:54 MDT
    expect(formatLocalDisplay("2026-06-23T20:29:54.000Z", "America/Denver")).toBe(
      "2026-06-23 14:29:54 MDT",
    );
  });

  it("formats midnight as 00:00:00 (24-hour)", () => {
    // 2026-06-23T06:00:00Z = midnight MDT
    expect(formatLocalDisplay("2026-06-23T06:00:00.000Z", "America/Denver")).toBe(
      "2026-06-23 00:00:00 MDT",
    );
  });

  it("formats noon as 12:00:00 (24-hour)", () => {
    // 2026-06-23T18:00:00Z = noon MDT
    expect(formatLocalDisplay("2026-06-23T18:00:00.000Z", "America/Denver")).toBe(
      "2026-06-23 12:00:00 MDT",
    );
  });
});

// ─── runList compact footer (one-line stderr) ──────────────────────────────

describe("runList compact footer (one-line stderr)", () => {
  const res0: TraceList = { data: [], meta: { page: 0, limit: 50, total: 0 } };
  const res2: TraceList = {
    data: [listItem({ trace_id: "a-1" }), listItem({ trace_id: "a-2" })],
    meta: { page: 0, limit: 50, total: 2 },
  };

  it("emits '<count> trace(s) | limit <N> | all traces' (0 traces)", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res0), json: false, writers: w });
    expect(err.data).toContain("0 trace(s) | limit 50 | all traces");
  });

  it("emits '<count> trace(s) | limit <N> | all traces' (2 traces)", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res2), json: false, writers: w });
    expect(err.data).toContain("2 trace(s) | limit 50 | all traces");
  });

  it("shows '<returned> of <total>' and uses meta.limit when total exceeds the page", async () => {
    const res: TraceList = {
      data: [listItem({ trace_id: "a-1" }), listItem({ trace_id: "a-2" })],
      meta: { page: 0, limit: 50, total: 137 },
    };
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    expect(err.data).toContain("2 of 137 trace(s) | limit 50 | all traces");
  });

  it("falls back to the explicit --limit when meta.limit is absent", async () => {
    const res = { data: [], meta: { page: 0, total: 0 } } as unknown as TraceList;
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w, limit: 7 });
    expect(err.data).toContain("0 trace(s) | limit 7 | all traces");
  });

  it("does NOT emit a separate 'Range:' predicate line (old format gone)", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res0), json: false, writers: w });
    expect(err.data).not.toContain("Range: all traces");
    // The count, limit and range are a single compact line (no separate tip line).
    const lines = err.data.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
  });

  it("emits 'limit <N> | since 2m' for sinceLabel", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res0),
      json: false,
      writers: w,
      startAfter: "2026-06-23T20:28:00.000Z",
      sinceLabel: "2m",
    });
    expect(err.data).toContain("0 trace(s) | limit 50 | since 2m");
  });

  it("emits a 24-hour 'from <local>' footer for startAfter-only (Denver TZ)", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res0),
      json: false,
      writers: w,
      startAfter: "2026-06-23T20:29:54.000Z",
      timeZone: "America/Denver",
    });
    expect(err.data).toContain("0 trace(s) | limit 50 | from 2026-06-23 14:29:54 MDT");
  });

  it("emits a 24-hour 'before <local>' footer for endBefore-only (Denver TZ)", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res0),
      json: false,
      writers: w,
      endBefore: "2026-06-23T20:31:02.000Z",
      timeZone: "America/Denver",
    });
    expect(err.data).toContain("0 trace(s) | limit 50 | before 2026-06-23 14:31:02 MDT");
  });

  it("emits a 24-hour 'from … to before …' footer for both bounds (Denver TZ)", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res0),
      json: false,
      writers: w,
      startAfter: "2026-06-23T20:28:35.000Z",
      endBefore: "2026-06-23T20:31:02.000Z",
      timeZone: "America/Denver",
    });
    expect(err.data).toContain(
      "0 trace(s) | limit 50 | from 2026-06-23 14:28:35 MDT to before 2026-06-23 14:31:02 MDT",
    );
  });

  it("does NOT emit footer in --json mode", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res0), json: true, writers: w });
    expect(err.data).toBe("");
  });
});

// ─── T3: round-trip validation ────────────────────────────────────────────

describe("resolveTimeRange (round-trip validation)", () => {
  it("rejects an invalid calendar date (Feb 31)", () => {
    expect(() =>
      resolveTimeRange({ from: "2026-02-31 14:31:02 MDT" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("rejects an out-of-range hour (hour 25)", () => {
    expect(() =>
      resolveTimeRange({ from: "2026-06-23 25:31:02 MDT" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("round-trip error message is actionable", () => {
    let message = "";
    try {
      resolveTimeRange({ from: "2026-02-31 14:31:02 MDT" }, Date.now, "America/Denver");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("not a valid local time");
    expect(message).toContain("ISO 8601");
    expect(message).toContain("--from");
  });

  it("still accepts valid MDT date in Denver (round-trip passes)", () => {
    const result = resolveTimeRange(
      { from: "2026-06-23 14:31:02 MDT" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-06-23T20:31:02.000Z");
  });

  it("rejects a spring-forward gap time in Denver (2026-03-08 02:30:00 MDT)", () => {
    // America/Denver springs forward on 2026-03-08 at 02:00 MST → 03:00 MDT
    // 02:30 doesn't exist; the round-trip will produce a different time
    expect(() =>
      resolveTimeRange({ from: "2026-03-08 02:30:00 MDT" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });
});

// ─── T5: flag ordering independence ───────────────────────────────────────

describe("flag ordering independence", () => {
  it("resolveTimeRange results are identical regardless of object key order", () => {
    const tz = "America/Denver";
    const r1 = resolveTimeRange(
      { from: "2026-06-23 14:28:35 MDT", to: "2026-06-23 14:31:02 MDT" },
      Date.now,
      tz,
    );
    const r2 = resolveTimeRange(
      { to: "2026-06-23 14:31:02 MDT", from: "2026-06-23 14:28:35 MDT" },
      Date.now,
      tz,
    );
    expect(r1).toEqual(r2);
  });
});

// ─── T5: duplicate flag rejection ─────────────────────────────────────────

describe("duplicate flag rejection", () => {
  it("rejects duplicate --from", () => {
    const result = runCli(
      "traces",
      "list",
      "--from",
      "2026-06-23T14:00:00Z",
      "--from",
      "2026-06-23T15:00:00Z",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--from may only be given once");
  });

  it("rejects duplicate --to", () => {
    const result = runCli(
      "traces",
      "list",
      "--to",
      "2026-06-23T14:00:00Z",
      "--to",
      "2026-06-23T15:00:00Z",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--to may only be given once");
  });

  it("rejects duplicate --since", () => {
    const result = runCli("traces", "list", "--since", "1h", "--since", "2h");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--since may only be given once");
  });

  it("rejects duplicate --limit", () => {
    const result = runCli("traces", "list", "--limit", "5", "--limit", "10");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--limit may only be given once");
  });
});

// ─── T6: enhanced stray-args error ────────────────────────────────────────

describe("stray positional arg enhanced error (T6)", () => {
  it("reconstructs a quoted timestamp suggestion when --from is a bare date with stray time args", () => {
    const result = runCli("traces", "list", "--from", "2026-06-23", "14:31:02", "MDT");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Did you mean to quote the timestamp?");
    expect(result.stderr).toContain('--from "2026-06-23 14:31:02 MDT"');
    expect(result.stderr).toContain("Timestamps with spaces must be passed as one shell argument.");
    expect(result.stderr).toContain("ISO 8601 also works");
  });

  it("reconstructs a quoted timestamp suggestion when --to is a bare date with stray time args", () => {
    const result = runCli("traces", "list", "--to", "2026-06-23", "14:31:02", "MDT");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Did you mean to quote the timestamp?");
    expect(result.stderr).toContain('--to "2026-06-23 14:31:02 MDT"');
    expect(result.stderr).toContain("Timestamps with spaces must be passed as one shell argument.");
  });

  it("emits generic error for stray args with no bare-date flag value", () => {
    const result = runCli("traces", "list", "extra");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpected argument(s)");
    expect(result.stderr).not.toContain("Did you mean to quote the timestamp?");
  });
});

// ─── runList tip line ──────────────────────────────────────────────────────

describe("runList tip line", () => {
  const res: TraceList = { data: [], meta: META };

  it("does not print a Tip line in normal output (no time flag)", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    expect(err.data).not.toContain("Tip:");
  });

  it("does NOT show the tip when startAfter is set", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res),
      json: false,
      writers: w,
      startAfter: "2026-06-01T00:00:00.000Z",
    });
    expect(err.data).not.toContain("Tip:");
  });

  it("suppresses the tip for a --since-style lower-bound-only range", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res),
      json: false,
      writers: w,
      startAfter: "2026-06-22T00:00:00.000Z",
      sinceLabel: "1d",
    });
    expect(err.data).toContain("since 1d");
    expect(err.data).not.toContain("Tip:");
  });

  it("does NOT show the tip when endBefore is set", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res),
      json: false,
      writers: w,
      endBefore: "2026-06-15T00:00:00.000Z",
    });
    expect(err.data).not.toContain("Tip:");
  });

  it("does NOT show the tip in --json mode", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });
    expect(err.data).not.toContain("Tip:");
  });
});
