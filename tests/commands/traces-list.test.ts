import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { ApiClient, TraceList } from "../../src/api/client.js";
import { buildProgram } from "../../src/cli.js";
import { parseLimit, resolveTimeRange, runList } from "../../src/commands/traces/list.js";
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
    expect(optionNames).not.toContain("--status");
  });

  it("rejects --status at the CLI before any network (hermetic)", () => {
    const result = runCli("traces", "list", "--status", "ok");
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("unknown option");
  });
});
