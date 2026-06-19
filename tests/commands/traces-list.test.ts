import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { ApiClient, TraceList } from "../../src/api/client.js";
import { buildProgram } from "../../src/cli.js";
import { parseLimit, runList } from "../../src/commands/traces/list.js";
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
  lastListParams?: { limit?: number };
}

function fakeClient(res: TraceList, state: FakeState = {}): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("unused")),
    listTraces: (params?: { limit?: number }) => {
      state.lastListParams = params;
      return Promise.resolve(res);
    },
    getTrace: () => Promise.reject(new Error("unused")),
    exportTrace: () => Promise.reject(new Error("unused")),
  };
}

const META: TraceList["meta"] = { page: 1, limit: 50, total: 2 };

describe("runList (human)", () => {
  it("renders a table with SPANS/ERRORS counts and trace ids present", async () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "ok-1", span_count: 4, error_count: 0 }),
        listItem({ trace_id: "err-1", span_count: 7, error_count: 2 }),
      ],
      meta: META,
    };
    const { writers: w, out, err } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });

    expect(out.data).toContain("TRACE ID");
    expect(out.data).toContain("SPANS");
    expect(out.data).toContain("ERRORS");
    expect(out.data).toContain("ok-1");
    expect(out.data).toContain("err-1");
    // No STATUS column: errors surface via the ERRORS count and red row, not a
    // status string. No lowercase "error"/"ok" status text is rendered.
    expect(out.data).not.toContain("STATUS");
    expect(out.data).not.toMatch(/\berror\b/);
    // Error counts surface as their own column.
    const errLine = out.data.split("\n").find((l) => l.includes("err-1")) as string;
    expect(errLine).toContain("2");
    const okLine = out.data.split("\n").find((l) => l.includes("ok-1")) as string;
    expect(okLine).toContain("4");
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

  it("renders an unfinished trace (duration_ms null) with no status label", async () => {
    const res: TraceList = {
      data: [listItem({ trace_id: "unfin-1", duration_ms: null, error_count: 0 })],
      meta: META,
    };
    const { writers: w, out } = writers();
    await runList({ client: fakeClient(res), json: false, writers: w });
    expect(out.data).toContain("unfin-1");
    // STATUS column removed: no "live"/"ok" status text is rendered.
    expect(out.data).not.toContain("live");
    expect(out.data).not.toMatch(/\bok\b/);
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
    expect(optionNames).not.toContain("--status");
  });

  it("rejects --status at the CLI before any network (hermetic)", () => {
    const result = runCli("traces", "list", "--status", "ok");
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("unknown option");
  });
});
