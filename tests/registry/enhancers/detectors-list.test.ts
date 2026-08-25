import { describe, expect, it } from "vitest";
import type { DetectorList } from "../../../src/api/client.js";
import type { Writers } from "../../../src/output.js";
import { detectorsList, renderDetectors } from "../../../src/registry/enhancers/detectors-list.js";
import { StringSink } from "../../helpers/stringSink.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
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

describe("renderDetectors", () => {
  it("renders a human table with detector columns and a footer", () => {
    const { writers: w, out, err } = writers();
    renderDetectors(listResult({ data: [detectorItem({ enabled: false })] }), {
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

  it("shows the resolved range in the footer", () => {
    const { writers: w, err } = writers();
    renderDetectors(listResult(), {
      json: false,
      writers: w,
      sinceLabel: "7d",
    });
    expect(err.data).toContain("since 7d");
  });

  it("emits a machine-readable object under --json", () => {
    const { writers: w, out } = writers();
    renderDetectors(listResult(), {
      json: true,
      writers: w,
    });
    const parsed = JSON.parse(out.data) as { data: unknown[]; count: number };
    expect(parsed.count).toBe(1);
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  it("renders an empty table with a footer for zero detectors", () => {
    const { writers: w, out, err } = writers();
    renderDetectors(listResult({ data: [], meta: { page: 0, limit: 50, total: 0 } }), {
      json: false,
      writers: w,
    });
    expect(out.data).toContain("DETECTOR ID");
    expect(err.data).toContain("0 detector(s)");
  });
});

describe("detectorsList.resolveArgs (forwarding)", () => {
  it("forwards --limit and the time window as args", () => {
    const resolved = detectorsList.resolveArgs?.({
      opts: {
        limit: "5",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-02-01T00:00:00.000Z",
      },
      positionals: {},
      extras: [],
    });
    expect(resolved?.args).toEqual({
      limit: 5,
      start_after: "2024-01-01T00:00:00.000Z",
      end_before: "2024-02-01T00:00:00.000Z",
    });
  });

  it("omits args when no filters are given", () => {
    const resolved = detectorsList.resolveArgs?.({ opts: {}, positionals: {}, extras: [] });
    expect(resolved?.args).toEqual({});
  });
});
