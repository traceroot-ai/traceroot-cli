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
});

describe("runList (--json)", () => {
  it("writes exactly one JSON doc equal to the response", async () => {
    const res: TraceList = { data: [listItem({ trace_id: "j-1" })], meta: META };
    const { writers: w, out, err } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });

    const docs = out.data.trim().split("\n");
    expect(docs).toHaveLength(1);
    expect(JSON.parse(docs[0] as string)).toEqual(res);
    expect(err.data).not.toContain("{");
  });

  it("exposes trace_start_time as a copyable ISO field in each trace", async () => {
    // Confirm --json exposes the backend canonical field (no footer/tip on stdout).
    const trace = listItem({ trace_id: "j-ts", trace_start_time: "2026-06-23T20:31:02.000000" });
    const res: TraceList = { data: [trace], meta: META };
    const { writers: w, out, err } = writers();
    await runList({ client: fakeClient(res), json: true, writers: w });

    const parsed = JSON.parse(out.data.trim()) as TraceList;
    expect(parsed.data[0]).toHaveProperty("trace_start_time");
    // No footer on stderr in JSON mode
    expect(err.data).toBe("");
    // stdout is ONLY the JSON, no extra lines
    expect(out.data.trim().split("\n")).toHaveLength(1);
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

  it("rejects --from at or after --to", () => {
    expect(() =>
      resolveTimeRange({ from: "2024-02-01T00:00:00Z", to: "2024-01-01T00:00:00Z" }),
    ).toThrow(CliError);
    expect(() =>
      resolveTimeRange({ from: "2024-01-01T00:00:00Z", to: "2024-01-01T00:00:00Z" }),
    ).toThrow(CliError);
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
    expect(optionNames).toContain("--wide");
    expect(optionNames).not.toContain("--status");
  });

  it("rejects --status at the CLI before any network (hermetic)", () => {
    const result = runCli("traces", "list", "--status", "ok");
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

  it("returns 'from <human-local>' for startAfter-only (Denver/MDT)", () => {
    // 2026-06-23T20:29:54Z = 2:29:54 PM MDT
    const result = renderRangeSummary({ startAfter: "2026-06-23T20:29:54.000Z" }, TZ);
    expect(result).toBe("from Jun 23, 2026 2:29:54 PM MDT");
  });

  it("returns 'before <human-local>' for endBefore-only (Denver/MDT)", () => {
    // 2026-06-23T20:31:02Z = 2:31:02 PM MDT
    const result = renderRangeSummary({ endBefore: "2026-06-23T20:31:02.000Z" }, TZ);
    expect(result).toBe("before Jun 23, 2026 2:31:02 PM MDT");
  });

  it("returns 'from … to before …' for both bounds (Denver/MDT)", () => {
    const result = renderRangeSummary(
      {
        startAfter: "2026-06-23T20:28:35.000Z", // 2:28:35 PM MDT
        endBefore: "2026-06-23T20:31:02.000Z", // 2:31:02 PM MDT
      },
      TZ,
    );
    expect(result).toBe("from Jun 23, 2026 2:28:35 PM MDT to before Jun 23, 2026 2:31:02 PM MDT");
  });
});

// ─── formatLocalDisplay (pure unit tests) ──────────────────────────────────

describe("formatLocalDisplay", () => {
  it("formats a UTC ISO string as local Mon DD, YYYY h:MM:SS AM/PM TZ", () => {
    // 2026-06-23T20:29:54Z = 2:29:54 PM MDT
    expect(formatLocalDisplay("2026-06-23T20:29:54.000Z", "America/Denver")).toBe(
      "Jun 23, 2026 2:29:54 PM MDT",
    );
  });

  it("formats midnight correctly (AM)", () => {
    // 2026-06-23T06:00:00Z = midnight MDT
    expect(formatLocalDisplay("2026-06-23T06:00:00.000Z", "America/Denver")).toBe(
      "Jun 23, 2026 12:00:00 AM MDT",
    );
  });

  it("formats noon correctly (PM)", () => {
    // 2026-06-23T18:00:00Z = noon MDT
    expect(formatLocalDisplay("2026-06-23T18:00:00.000Z", "America/Denver")).toBe(
      "Jun 23, 2026 12:00:00 PM MDT",
    );
  });
});

// ─── runList compact footer (one-line stderr) ──────────────────────────────

describe("runList compact footer (one-line stderr)", () => {
  const res0: TraceList = { data: [], meta: META };
  const res2: TraceList = {
    data: [listItem({ trace_id: "a-1" }), listItem({ trace_id: "a-2" })],
    meta: META,
  };

  it("emits '<n> trace(s) | all traces' when no bounds (0 traces)", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res0), json: false, writers: w });
    expect(err.data).toContain("0 trace(s) | all traces");
  });

  it("emits '<n> trace(s) | all traces' when no bounds (2 traces)", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res2), json: false, writers: w });
    expect(err.data).toContain("2 trace(s) | all traces");
  });

  it("does NOT emit two separate lines (old format gone)", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res0), json: false, writers: w });
    // Old format had "Range:" on a separate line — should not appear
    expect(err.data).not.toContain("Range: all traces");
    // The count and range should be on the SAME line
    const lines = err.data.split("\n").filter((l) => l.trim() !== "");
    // At most 2 lines: footer + optional tip (no time flags → tip shown)
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("emits '<n> trace(s) | since 2m' for sinceLabel", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res0),
      json: false,
      writers: w,
      startAfter: "2026-06-23T20:28:00.000Z",
      sinceLabel: "2m",
    });
    expect(err.data).toContain("0 trace(s) | since 2m");
  });

  it("emits 'from <human-local>' footer for startAfter-only (Denver TZ)", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res0),
      json: false,
      writers: w,
      startAfter: "2026-06-23T20:29:54.000Z",
      timeZone: "America/Denver",
    });
    expect(err.data).toContain("0 trace(s) | from Jun 23, 2026 2:29:54 PM MDT");
  });

  it("emits 'before <human-local>' footer for endBefore-only (Denver TZ)", async () => {
    const { writers: w, err } = writers();
    await runList({
      client: fakeClient(res0),
      json: false,
      writers: w,
      endBefore: "2026-06-23T20:31:02.000Z",
      timeZone: "America/Denver",
    });
    expect(err.data).toContain("0 trace(s) | before Jun 23, 2026 2:31:02 PM MDT");
  });

  it("emits 'from … to before …' footer for both bounds (Denver TZ)", async () => {
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
      "0 trace(s) | from Jun 23, 2026 2:28:35 PM MDT to before Jun 23, 2026 2:31:02 PM MDT",
    );
  });

  it("does NOT emit footer in --json mode", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res0), json: true, writers: w });
    expect(err.data).toBe("");
  });
});

// ─── runList tip line ──────────────────────────────────────────────────────

describe("runList tip line", () => {
  const res: TraceList = { data: [], meta: META };

  it("shows a tip mentioning --wide and ISO 8601 when no time flag is set", async () => {
    const { writers: w, err } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    expect(err.data).toContain("Tip:");
    expect(err.data).toContain("--wide");
    expect(err.data).toContain("ISO 8601");
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

// ─── runList --wide flag ───────────────────────────────────────────────────

describe("runList --wide flag", () => {
  it("default (no --wide) does NOT include STARTED ISO column", async () => {
    const res: TraceList = {
      data: [listItem({ trace_start_time: "2026-06-23T20:31:02.000000" })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    expect(out.data).not.toContain("STARTED ISO");
  });

  it("--wide adds STARTED ISO column with UTC Z value", async () => {
    const res: TraceList = {
      data: [listItem({ trace_start_time: "2026-06-23T20:31:02.000000" })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w, wide: true });
    expect(out.data).toContain("STARTED ISO");
    expect(out.data).toContain("2026-06-23T20:31:02.000Z");
  });

  it("--wide STARTED ISO column appears after STARTED column in header", async () => {
    const res: TraceList = {
      data: [listItem({ trace_start_time: "2026-06-23T20:31:02.000000" })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w, wide: true });
    const headerLine = out.data.split("\n")[0] as string;
    const cols = headerLine.trim().split(/\s{2,}/);
    expect(cols).toEqual(["STARTED", "STARTED ISO", "STATUS", "DURATION", "NAME", "TRACE ID"]);
  });

  it("reds the whole row for an errored trace on a TTY in --wide mode", async () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "ok-1", error_count: 0 }),
        listItem({ trace_id: "err-1", error_count: 3 }),
      ],
      meta: META,
    };
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runList({ client: fakeClient(res), json: false, writers: { out, err }, wide: true });
    const errLine = out.data.split("\n").find((l) => l.includes("err-1")) as string;
    const okLine = out.data.split("\n").find((l) => l.includes("ok-1")) as string;
    expect(errLine).toContain("\x1b[91m"); // bright red
    expect(okLine).not.toContain("\x1b[91m");
  });

  it("--wide shows Z-suffixed ISO for a naive backend timestamp", async () => {
    const res: TraceList = {
      data: [listItem({ trace_start_time: "2026-06-23T20:31:02.500000" })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w, wide: true });
    expect(out.data).toContain("2026-06-23T20:31:02.500Z");
  });

  it("--wide shows Z-suffixed ISO for an already-Z timestamp", async () => {
    const res: TraceList = {
      data: [listItem({ trace_start_time: "2026-06-23T20:31:02.000Z" })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w, wide: true });
    expect(out.data).toContain("2026-06-23T20:31:02.000Z");
  });
});
