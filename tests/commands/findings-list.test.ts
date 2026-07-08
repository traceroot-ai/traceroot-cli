import { describe, expect, it } from "vitest";
import type { ApiClient, FindingList, ListFindingsParams } from "../../src/api/client.js";
import { runFindings } from "../../src/commands/findings/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

interface FakeState {
  lastParams?: ListFindingsParams;
}

function fakeClient(res: FindingList, state: FakeState = {}): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("unused")),
    listTraces: () => Promise.reject(new Error("unused")),
    getTrace: () => Promise.reject(new Error("unused")),
    exportTrace: () => Promise.reject(new Error("unused")),
    listDetectors: () => Promise.reject(new Error("unused")),
    listFindings: (params?: ListFindingsParams) => {
      state.lastParams = params;
      return Promise.resolve(res);
    },
    getFinding: () => Promise.reject(new Error("unused")),
    getFindingByTrace: () => Promise.reject(new Error("unused")),
  };
}

function findingItem(over: Partial<FindingList["data"][number]> = {}): FindingList["data"][number] {
  return {
    finding_id: "fnd-1",
    project_id: "p-1",
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

describe("runFindings", () => {
  it("renders a human table with finding columns and a footer", async () => {
    const { writers: w, out, err } = writers();
    await runFindings({
      client: fakeClient(listResult({ data: [findingItem({ detectors: ["failure", "logic"] })] })),
      json: false,
      writers: w,
      timeZone: "UTC",
    });
    for (const header of ["TIME", "FINDING ID", "TRACE ID", "DETECTOR NAME"]) {
      expect(out.data).toContain(header);
    }
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

  it("labels the range 'all findings' with no filters under --json", async () => {
    const { writers: w, out } = writers();
    await runFindings({ client: fakeClient(listResult()), json: true, writers: w });
    const parsed = JSON.parse(out.data) as { range: { label: string } };
    expect(parsed.range.label).toBe("all findings");
  });

  it("emits a JSON envelope with count and range under --json", async () => {
    const { writers: w, out } = writers();
    await runFindings({
      client: fakeClient(listResult()),
      json: true,
      writers: w,
      sinceLabel: "24h",
    });
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

  it("forwards filters to listFindings", async () => {
    const state: FakeState = {};
    const { writers: w } = writers();
    await runFindings({
      client: fakeClient(listResult({ data: [], meta: { page: 0, limit: 10, total: 0 } }), state),
      json: false,
      writers: w,
      limit: 10,
      startAfter: "2024-01-01T00:00:00Z",
      endBefore: "2024-02-01T00:00:00Z",
      detector: "hallucination",
      traceId: "tr-9",
    });
    expect(state.lastParams).toEqual({
      limit: 10,
      startAfter: "2024-01-01T00:00:00Z",
      endBefore: "2024-02-01T00:00:00Z",
      detector: "hallucination",
      traceId: "tr-9",
    });
  });

  it("prints only the header and footer when there are no findings", async () => {
    const { writers: w, out, err } = writers();
    await runFindings({
      client: fakeClient(listResult({ data: [], meta: { page: 0, limit: 50, total: 0 } })),
      json: false,
      writers: w,
      timeZone: "UTC",
    });
    expect(out.data).toContain("FINDING ID");
    expect(out.data).not.toContain("fnd-1");
    expect(err.data).toContain("0 finding(s)");
  });
});
