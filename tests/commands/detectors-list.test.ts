import { describe, expect, it } from "vitest";
import type { ApiClient, DetectorList, ListDetectorsParams } from "../../src/api/client.js";
import { runDetectors } from "../../src/commands/detectors/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

interface FakeState {
  lastParams?: ListDetectorsParams;
}

function fakeClient(res: DetectorList, state: FakeState = {}): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("unused")),
    listTraces: () => Promise.reject(new Error("unused")),
    getTrace: () => Promise.reject(new Error("unused")),
    exportTrace: () => Promise.reject(new Error("unused")),
    listDetectors: (params?: ListDetectorsParams) => {
      state.lastParams = params;
      return Promise.resolve(res);
    },
    listFindings: () => Promise.reject(new Error("unused")),
    getFinding: () => Promise.reject(new Error("unused")),
    getFindingByTrace: () => Promise.reject(new Error("unused")),
  };
}

function detectorItem(
  over: Partial<DetectorList["data"][number]> = {},
): DetectorList["data"][number] {
  return {
    detector_id: "det-1",
    name: "My Hallucination Detector",
    template: "hallucination",
    enabled: true,
    created_at: "2024-01-01T00:00:00Z",
    ...over,
  };
}

function listResult(over: Partial<DetectorList> = {}): DetectorList {
  return { data: [detectorItem()], meta: { page: 0, limit: 50, total: 1 }, ...over };
}

describe("runDetectors", () => {
  it("renders a human table with detector columns and a footer", async () => {
    const { writers: w, out, err } = writers();
    await runDetectors({
      client: fakeClient(listResult({ data: [detectorItem({ enabled: false })] })),
      json: false,
      writers: w,
      timeZone: "UTC",
    });
    for (const header of ["CREATED", "NAME", "TEMPLATE", "ENABLED", "DETECTOR ID"]) {
      expect(out.data).toContain(header);
    }
    expect(out.data).toContain("det-1");
    expect(out.data).toContain("My Hallucination Detector");
    expect(out.data).toContain("hallucination");
    expect(out.data).toContain("no"); // enabled:false renders as "no"
    expect(err.data).toContain("1 detector(s)");
  });

  it("forwards --limit and the time window to the client", async () => {
    const { writers: w } = writers();
    const state: FakeState = {};
    await runDetectors({
      client: fakeClient(listResult(), state),
      json: false,
      writers: w,
      limit: 5,
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
    expect(state.lastParams).toEqual({
      limit: 5,
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
  });

  it("shows the resolved range in the footer", async () => {
    const { writers: w, err } = writers();
    await runDetectors({
      client: fakeClient(listResult()),
      json: false,
      writers: w,
      sinceLabel: "7d",
    });
    expect(err.data).toContain("since 7d");
  });

  it("emits a machine-readable object under --json", async () => {
    const { writers: w, out } = writers();
    await runDetectors({
      client: fakeClient(listResult()),
      json: true,
      writers: w,
    });
    const parsed = JSON.parse(out.data) as { data: unknown[]; count: number };
    expect(parsed.count).toBe(1);
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  it("renders an empty table with a footer for zero detectors", async () => {
    const { writers: w, out, err } = writers();
    await runDetectors({
      client: fakeClient(listResult({ data: [], meta: { page: 0, limit: 50, total: 0 } })),
      json: false,
      writers: w,
    });
    expect(out.data).toContain("DETECTOR ID");
    expect(err.data).toContain("0 detector(s)");
  });
});
