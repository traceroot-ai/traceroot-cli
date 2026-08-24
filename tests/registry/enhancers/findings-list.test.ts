import { describe, expect, it } from "vitest";
import type { FindingList } from "../../../src/api/client.js";
import type { Writers } from "../../../src/output.js";
import { findingsList, renderFindings } from "../../../src/registry/enhancers/findings-list.js";
import { StringSink } from "../../helpers/stringSink.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

function findingItem(over: Partial<FindingList["data"][number]> = {}): FindingList["data"][number] {
  return {
    finding_id: "fnd-1",
    project_id: "p-1",
    run_ids: ["run-1", "run-2"],
    trace_id: "tr-1",
    summary: "a finding summary",
    timestamp: "2024-01-01T00:00:00Z",
    detectors: ["hallucination"],
    ...over,
  };
}

function listResult(over: Partial<FindingList> = {}): FindingList {
  return { data: [findingItem()], meta: { page: 0, limit: 50, total: 1 }, ...over };
}

describe("renderFindings", () => {
  it("renders an empty RUN IDS cell when the finding has no runs or the server predates the field", () => {
    const { writers: w, out } = writers();
    renderFindings(
      listResult({
        data: [
          findingItem({ run_ids: [] }),
          findingItem({ run_ids: undefined as unknown as string[], finding_id: "fnd-2" }),
        ],
        meta: { page: 0, limit: 50, total: 2 },
      }),
      { json: false, writers: w, timeZone: "UTC" },
    );
    expect(out.data).toContain("fnd-1");
    expect(out.data).toContain("fnd-2");
    expect(out.data).not.toContain("undefined");
  });

  it("renders legacy hyphenated (UUID-form) finding ids stripped of hyphens", () => {
    const { writers: w, out } = writers();
    renderFindings(
      listResult({ data: [findingItem({ finding_id: "9402640d-c949-4150-ac84-458ea7b95190" })] }),
      { json: false, writers: w, timeZone: "UTC" },
    );
    expect(out.data).toContain("9402640dc9494150ac84458ea7b95190");
    expect(out.data).not.toContain("9402640d-c949");
  });

  it("renders a human table with finding columns and a footer", () => {
    const { writers: w, out, err } = writers();
    renderFindings(listResult({ data: [findingItem({ detectors: ["failure", "logic"] })] }), {
      json: false,
      writers: w,
      timeZone: "UTC",
    });
    // Mirrors the UI's detector-runs ordering: run id -> trace id -> finding id.
    for (const header of ["TIME", "RUN IDS", "TRACE ID", "FINDING ID", "DETECTOR NAME"]) {
      expect(out.data).toContain(header);
    }
    expect(out.data.indexOf("RUN IDS")).toBeLessThan(out.data.indexOf("TRACE ID"));
    expect(out.data.indexOf("TRACE ID")).toBeLessThan(out.data.indexOf("FINDING ID"));
    expect(out.data).toContain("run-1,run-2");
    // summary is intentionally not a column (kept out of the list table)
    expect(out.data).not.toContain("SUMMARY");
    expect(out.data).toContain("fnd-1");
    expect(out.data).toContain("failure,logic");
    expect(err.data).toContain("1 finding(s)");
    expect(err.data).toContain("limit 50");
    // no-filter footer uses the findings-specific label, not traces' "all traces"
    expect(err.data).toContain("all findings");
    expect(err.data).not.toContain("all traces");
  });

  it("labels the range 'all findings' with no filters under --json", () => {
    const { writers: w, out } = writers();
    renderFindings(listResult(), { json: true, writers: w });
    const parsed = JSON.parse(out.data) as { range: { label: string } };
    expect(parsed.range.label).toBe("all findings");
  });

  it("emits a JSON envelope with count and range under --json", () => {
    const { writers: w, out } = writers();
    renderFindings(listResult(), { json: true, writers: w, sinceLabel: "24h" });
    const parsed = JSON.parse(out.data) as {
      data: { finding_id: string }[];
      meta: { total: number };
      count: number;
      range: { label: string };
    };
    expect(parsed.data[0]?.finding_id).toBe("fnd-1");
    expect(parsed.meta.total).toBe(1);
    expect(parsed.count).toBe(1);
    expect(parsed.range.label).toBe("since 24h");
  });

  it("prints only the header and footer when there are no findings", () => {
    const { writers: w, out, err } = writers();
    renderFindings(listResult({ data: [], meta: { page: 0, limit: 50, total: 0 } }), {
      json: false,
      writers: w,
      timeZone: "UTC",
    });
    expect(out.data).toContain("FINDING ID");
    expect(out.data).not.toContain("fnd-1");
    expect(err.data).toContain("0 finding(s)");
  });
});

describe("findingsList.resolveArgs (forwarding)", () => {
  it("forwards --limit, the time window, --detector, and --trace as args", () => {
    const resolved = findingsList.resolveArgs?.({
      opts: {
        limit: "10",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-02-01T00:00:00.000Z",
        detector: "hallucination",
        trace: "tr-9",
      },
      positionals: {},
      extras: [],
    });
    expect(resolved?.args).toEqual({
      limit: 10,
      start_after: "2024-01-01T00:00:00.000Z",
      end_before: "2024-02-01T00:00:00.000Z",
      detector: "hallucination",
      trace_id: "tr-9",
    });
  });

  it("omits args when no filters are given", () => {
    const resolved = findingsList.resolveArgs?.({ opts: {}, positionals: {}, extras: [] });
    expect(resolved?.args).toEqual({});
  });
});
