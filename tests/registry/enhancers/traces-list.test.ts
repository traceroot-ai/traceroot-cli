import type { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceList } from "../../../src/api/client.js";
import { buildProgram } from "../../../src/cli.js";
import type { Writers } from "../../../src/output.js";
import { renderList, tracesList } from "../../../src/registry/enhancers/traces-list.js";
import { runCli } from "../../helpers/runCli.js";
import { StringSink } from "../../helpers/stringSink.js";

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

describe("renderList (human)", () => {
  it("renders ERRORS/SPANS columns in order with no STATUS column", () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "ok-1", span_count: 4, error_count: 0 }),
        listItem({ trace_id: "err-1", span_count: 7, error_count: 2 }),
      ],
      meta: META,
    };
    const { writers: w, out, err } = writers();
    renderList(res, { json: false, writers: w });

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

  it("emits no ANSI escapes when the sink is not a TTY", () => {
    const res: TraceList = { data: [listItem({})], meta: META };
    const { writers: w, out } = writers();
    renderList(res, { json: false, writers: w });
    expect(out.data).not.toContain("\x1b[");
  });

  it("renders an unfinished trace (duration_ms null) with no STATUS column", () => {
    const res: TraceList = {
      data: [listItem({ trace_id: "unfin-1", duration_ms: null, error_count: 0 })],
      meta: META,
    };
    const { writers: w, out } = writers();
    renderList(res, { json: false, writers: w });
    const headerLine = out.data.split("\n").find((l) => l.includes("STARTED")) as string;
    // The row renders; liveness is no longer expressed as a STATUS label.
    expect(out.data).toContain("unfin-1");
    expect(headerLine).not.toContain("STATUS");
  });

  it("bolds the header row on a TTY", () => {
    const res: TraceList = { data: [listItem({})], meta: META };
    const out = new StringSink(true);
    const err = new StringSink(true);
    renderList(res, { json: false, writers: { out, err } });
    // The header line is wrapped in the ANSI bold code; data rows are not.
    expect(out.data).toContain("\x1b[1m");
    expect(out.data).toContain("STARTED");
  });

  it("reds the whole row for an errored trace on a TTY", () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "ok-1", error_count: 0 }),
        listItem({ trace_id: "err-1", error_count: 3 }),
      ],
      meta: META,
    };
    const out = new StringSink(true);
    const err = new StringSink(true);
    renderList(res, { json: false, writers: { out, err } });
    const errLine = out.data.split("\n").find((l) => l.includes("err-1")) as string;
    const okLine = out.data.split("\n").find((l) => l.includes("ok-1")) as string;
    expect(errLine).toContain("\x1b[91m"); // bright red
    expect(okLine).not.toContain("\x1b[91m");
  });

  it("does not red an unfinished trace row (error_count 0) on a TTY", () => {
    const res: TraceList = {
      data: [listItem({ trace_id: "unfin-1", duration_ms: null, error_count: 0 })],
      meta: META,
    };
    const out = new StringSink(true);
    const err = new StringSink(true);
    renderList(res, { json: false, writers: { out, err } });
    const row = out.data.split("\n").find((l) => l.includes("unfin-1")) as string;
    // Red is keyed on error_count, not liveness, so a live row stays uncolored.
    expect(row).not.toContain("\x1b[91m");
  });

  it("does NOT have a STARTED ISO column (no --wide mode exists)", () => {
    const res: TraceList = {
      data: [listItem({ trace_start_time: "2026-06-23T20:31:02.000000" })],
      meta: META,
    };
    const { writers: w, out } = writers();
    renderList(res, { json: false, writers: w });
    expect(out.data).not.toContain("STARTED ISO");
  });
});

describe("renderList live DURATION under a non-UTC timezone", () => {
  // Backend timestamps are zone-less UTC. A bare `new Date(...)` reads them as
  // LOCAL, which blanks the elapsed DURATION west of UTC and inflates it east.
  // These tests run under real non-UTC zones to prove the elapsed math is
  // computed in UTC regardless of the host timezone.
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  /** Extracts the DURATION cell (seconds) for the sole live row. */
  function liveDurationSeconds(out: StringSink): number {
    const lines = out.data.split("\n");
    const headerLine = lines.find((l) => l.includes("STARTED")) as string;
    const dataLine = lines.find((l) => l.includes("live-1")) as string;
    const cell = cellAt(dataLine, headerLine, "DURATION", "NAME");
    expect(cell).not.toBe("");
    const match = /^([\d.]+)s$/.exec(cell);
    expect(match).not.toBeNull();
    return Number.parseFloat((match as RegExpExecArray)[1] as string);
  }

  for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
    it(`renders elapsed ~10m for a live trace (TZ=${tz})`, () => {
      process.env.TZ = tz;
      // A zone-less UTC start ~10 minutes ago (drop the trailing Z the backend omits).
      const startedZoneless = new Date(Date.now() - 10 * 60_000).toISOString().slice(0, -1);
      const res: TraceList = {
        data: [
          listItem({ trace_id: "live-1", duration_ms: null, trace_start_time: startedZoneless }),
        ],
        meta: META,
      };
      const { writers: w, out } = writers();
      renderList(res, { json: false, writers: w });
      // 10 minutes = 600s; allow a small tolerance for elapsed test time.
      expect(liveDurationSeconds(out)).toBeGreaterThanOrEqual(600);
      expect(liveDurationSeconds(out)).toBeLessThan(605);
    });
  }
});

describe("renderList (--json)", () => {
  it("writes exactly one JSON doc with data, meta, count, and range keys", () => {
    const res: TraceList = { data: [listItem({ trace_id: "j-1" })], meta: META };
    const { writers: w, out, err } = writers();
    renderList(res, { json: true, writers: w });

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

  it("JSON range.label is 'all traces' when no bounds are given", () => {
    const res: TraceList = { data: [listItem({ trace_id: "j-2" })], meta: META };
    const { writers: w, out } = writers();
    renderList(res, { json: true, writers: w });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    const range = parsed.range as Record<string, unknown>;
    expect(range.label).toBe("all traces");
    expect(range.startAfter).toBeNull();
    expect(range.endBefore).toBeNull();
  });

  it("JSON range.label is 'since 2m' when sinceLabel is set", () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    renderList(res, {
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

  it("JSON range.label is 'from <ISO> to before <ISO>' for both bounds", () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    renderList(res, {
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

  it("JSON range.label is 'from <ISO>' for startAfter-only", () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    renderList(res, {
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

  it("JSON range.label is 'before <ISO>' for endBefore-only", () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out } = writers();
    renderList(res, {
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

  it("JSON count equals res.data.length", () => {
    const res: TraceList = {
      data: [
        listItem({ trace_id: "c-1" }),
        listItem({ trace_id: "c-2" }),
        listItem({ trace_id: "c-3" }),
      ],
      meta: META,
    };
    const { writers: w, out } = writers();
    renderList(res, { json: true, writers: w });
    const parsed = JSON.parse(out.data.trim()) as Record<string, unknown>;
    expect(parsed.count).toBe(3);
  });

  it("exposes trace_start_time as a copyable ISO field in each trace", () => {
    // Confirm --json exposes the backend canonical field (no footer/tip on stdout).
    const trace = listItem({ trace_id: "j-ts", trace_start_time: "2026-06-23T20:31:02.000000" });
    const res: TraceList = { data: [trace], meta: META };
    const { writers: w, out, err } = writers();
    renderList(res, { json: true, writers: w });

    const parsed = JSON.parse(out.data.trim()) as TraceList & { count: number; range: unknown };
    expect(parsed.data[0]).toHaveProperty("trace_start_time");
    // No footer on stderr in JSON mode
    expect(err.data).toBe("");
    // stdout is ONLY the JSON, no extra lines
    expect(out.data.trim().split("\n")).toHaveLength(1);
  });

  it("JSON does NOT include footer or tip text in stdout", () => {
    const res: TraceList = { data: [], meta: META };
    const { writers: w, out, err } = writers();
    renderList(res, { json: true, writers: w });
    expect(out.data).not.toContain("Tip:");
    expect(out.data).not.toContain("trace(s)");
    expect(err.data).toBe("");
  });
});

describe("tracesList.resolveArgs (--limit forwarding)", () => {
  it("rejects a --limit above the schema maximum as a usage error (parity with generated commands)", () => {
    expect(() =>
      tracesList.resolveArgs?.({ opts: { limit: "999999" }, positionals: {}, extras: [] }),
    ).toThrow("--limit must be at most 200");
  });

  it("forwards the limit as args.limit", () => {
    const resolved = tracesList.resolveArgs?.({
      opts: { limit: "5" },
      positionals: {},
      extras: [],
    });
    expect(resolved?.args).toEqual({ limit: 5 });
  });

  it("omits args.limit when no limit is given", () => {
    const resolved = tracesList.resolveArgs?.({ opts: {}, positionals: {}, extras: [] });
    expect(resolved?.args).toEqual({});
  });
});

describe("tracesList.resolveArgs (time-range forwarding)", () => {
  it("forwards start_after and end_before as args", () => {
    const resolved = tracesList.resolveArgs?.({
      opts: { from: "2024-01-01T00:00:00.000Z", to: "2024-02-01T00:00:00.000Z" },
      positionals: {},
      extras: [],
    });
    expect(resolved?.args).toEqual({
      start_after: "2024-01-01T00:00:00.000Z",
      end_before: "2024-02-01T00:00:00.000Z",
    });
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
    // Without a credential it will fail on the auth guard, not on stray-args or
    // timestamp validation — proving the bare date was accepted as valid.
    const result = runCli("traces", "list", "--from", "2026-06-23");
    expect(result.status).not.toBe(0);
    // Should NOT produce the stray-args message
    expect(result.stderr).not.toContain("unexpected argument(s)");
    // Should NOT produce the ISO 8601 rejection (i.e. the bare date was accepted)
    expect(result.stderr).not.toContain("ISO 8601");
    // Should fall through to the auth error, confirming that path was reached
    expect(result.stderr.toLowerCase()).toContain("no credentials found");
  });
});

// ─── renderList compact footer (one-line stderr) ───────────────────────────

describe("renderList compact footer (one-line stderr)", () => {
  const res0: TraceList = { data: [], meta: { page: 0, limit: 50, total: 0 } };
  const res2: TraceList = {
    data: [listItem({ trace_id: "a-1" }), listItem({ trace_id: "a-2" })],
    meta: { page: 0, limit: 50, total: 2 },
  };

  it("emits '<count> trace(s) | limit <N> | all traces' (0 traces)", () => {
    const { writers: w, err } = writers();
    renderList(res0, { json: false, writers: w });
    expect(err.data).toContain("0 trace(s) | limit 50 | all traces");
  });

  it("emits '<count> trace(s) | limit <N> | all traces' (2 traces)", () => {
    const { writers: w, err } = writers();
    renderList(res2, { json: false, writers: w });
    expect(err.data).toContain("2 trace(s) | limit 50 | all traces");
  });

  it("shows '<returned> of <total>' and uses meta.limit when total exceeds the page", () => {
    const res: TraceList = {
      data: [listItem({ trace_id: "a-1" }), listItem({ trace_id: "a-2" })],
      meta: { page: 0, limit: 50, total: 137 },
    };
    const { writers: w, err } = writers();
    renderList(res, { json: false, writers: w });
    expect(err.data).toContain("2 of 137 trace(s) | limit 50 | all traces");
  });

  it("falls back to the explicit --limit when meta.limit is absent", () => {
    const res = { data: [], meta: { page: 0, total: 0 } } as unknown as TraceList;
    const { writers: w, err } = writers();
    renderList(res, { json: false, writers: w, limit: 7 });
    expect(err.data).toContain("0 trace(s) | limit 7 | all traces");
  });

  it("does NOT emit a separate 'Range:' predicate line (old format gone)", () => {
    const { writers: w, err } = writers();
    renderList(res0, { json: false, writers: w });
    expect(err.data).not.toContain("Range: all traces");
    // The count, limit and range are a single compact line (no separate tip line).
    const lines = err.data.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
  });

  it("emits 'limit <N> | since 2m' for sinceLabel", () => {
    const { writers: w, err } = writers();
    renderList(res0, {
      json: false,
      writers: w,
      startAfter: "2026-06-23T20:28:00.000Z",
      sinceLabel: "2m",
    });
    expect(err.data).toContain("0 trace(s) | limit 50 | since 2m");
  });

  it("emits a 24-hour 'from <local>' footer for startAfter-only (Denver TZ)", () => {
    const { writers: w, err } = writers();
    renderList(res0, {
      json: false,
      writers: w,
      startAfter: "2026-06-23T20:29:54.000Z",
      timeZone: "America/Denver",
    });
    expect(err.data).toContain("0 trace(s) | limit 50 | from 2026-06-23 14:29:54 MDT");
  });

  it("emits a 24-hour 'before <local>' footer for endBefore-only (Denver TZ)", () => {
    const { writers: w, err } = writers();
    renderList(res0, {
      json: false,
      writers: w,
      endBefore: "2026-06-23T20:31:02.000Z",
      timeZone: "America/Denver",
    });
    expect(err.data).toContain("0 trace(s) | limit 50 | before 2026-06-23 14:31:02 MDT");
  });

  it("emits a 24-hour 'from … to before …' footer for both bounds (Denver TZ)", () => {
    const { writers: w, err } = writers();
    renderList(res0, {
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

  it("does NOT emit footer in --json mode", () => {
    const { writers: w, err } = writers();
    renderList(res0, { json: true, writers: w });
    expect(err.data).toBe("");
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

// ─── renderList tip line ────────────────────────────────────────────────────

describe("renderList tip line", () => {
  const res: TraceList = { data: [], meta: META };

  it("does not print a Tip line in normal output (no time flag)", () => {
    const { writers: w, err } = writers();
    renderList(res, { json: false, writers: w });
    expect(err.data).not.toContain("Tip:");
  });

  it("does NOT show the tip when startAfter is set", () => {
    const { writers: w, err } = writers();
    renderList(res, {
      json: false,
      writers: w,
      startAfter: "2026-06-01T00:00:00.000Z",
    });
    expect(err.data).not.toContain("Tip:");
  });

  it("suppresses the tip for a --since-style lower-bound-only range", () => {
    const { writers: w, err } = writers();
    renderList(res, {
      json: false,
      writers: w,
      startAfter: "2026-06-22T00:00:00.000Z",
      sinceLabel: "1d",
    });
    expect(err.data).toContain("since 1d");
    expect(err.data).not.toContain("Tip:");
  });

  it("does NOT show the tip when endBefore is set", () => {
    const { writers: w, err } = writers();
    renderList(res, {
      json: false,
      writers: w,
      endBefore: "2026-06-15T00:00:00.000Z",
    });
    expect(err.data).not.toContain("Tip:");
  });

  it("does NOT show the tip in --json mode", () => {
    const { writers: w, err } = writers();
    renderList(res, { json: true, writers: w });
    expect(err.data).not.toContain("Tip:");
  });
});
