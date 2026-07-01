import { describe, expect, it } from "vitest";
import type { ApiClient, FindingDetail } from "../../src/api/client.js";
import { runShow } from "../../src/commands/detectors/show.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

function resultItem(
  over: Partial<FindingDetail["results"][number]> = {},
): FindingDetail["results"][number] {
  return {
    detector_id: "d1",
    detector_name: "hallucination",
    template: "hallucination",
    summary: "unsupported claims",
    identified: true,
    data: { k: "v" },
    ...over,
  };
}

function detail(over: Partial<FindingDetail> = {}): FindingDetail {
  return {
    finding_id: "fnd-1",
    project_id: "p-1",
    trace_id: "tr-1",
    summary: "a finding summary",
    timestamp: "2024-01-01T00:00:00Z",
    detectors: ["hallucination"],
    results: [resultItem()],
    rca: { status: "done", result: "the root cause" },
    ...over,
  };
}

interface FakeState {
  lastGet?: string;
  lastByTrace?: string;
}

function fakeClient(
  over: { finding?: FindingDetail; byTrace?: FindingDetail; error?: Error },
  state: FakeState = {},
): ApiClient {
  const reject = () => Promise.reject(new Error("unused"));
  return {
    whoami: reject,
    listTraces: reject,
    getTrace: reject,
    exportTrace: reject,
    listFindings: reject,
    getFinding: (id: string) => {
      state.lastGet = id;
      return over.error
        ? Promise.reject(over.error)
        : Promise.resolve(over.finding as FindingDetail);
    },
    getFindingByTrace: (id: string) => {
      state.lastByTrace = id;
      return over.error
        ? Promise.reject(over.error)
        : Promise.resolve(over.byTrace as FindingDetail);
    },
  };
}

describe("runShow", () => {
  it("renders Finding / Detector Results / RCA blocks for a finding id", async () => {
    const state: FakeState = {};
    const { writers: w, out } = writers();
    await runShow({
      client: fakeClient({ finding: detail() }, state),
      json: false,
      writers: w,
      findingId: "fnd-1",
      timeZone: "UTC",
    });
    expect(state.lastGet).toBe("fnd-1");
    expect(out.data).toContain("Finding");
    expect(out.data).toContain("fnd-1");
    expect(out.data).toContain("tr-1");
    expect(out.data).toContain("Detector Results");
    expect(out.data).toContain("hallucination");
    expect(out.data).toContain("Identified: true");
    expect(out.data).toContain("unsupported claims");
    expect(out.data).toContain('"k": "v"');
    expect(out.data).toContain("RCA");
    expect(out.data).toContain("Status: done");
    expect(out.data).toContain("the root cause");
  });

  it("dispatches to getFindingByTrace for --trace", async () => {
    const state: FakeState = {};
    const { writers: w, out } = writers();
    await runShow({
      client: fakeClient({ byTrace: detail({ trace_id: "tr-9" }) }, state),
      json: false,
      writers: w,
      traceId: "tr-9",
      timeZone: "UTC",
    });
    expect(state.lastByTrace).toBe("tr-9");
    expect(out.data).toContain("tr-9");
  });

  it("shows 'Status: none' and no Result line when rca is null", async () => {
    const { writers: w, out } = writers();
    await runShow({
      client: fakeClient({ finding: detail({ rca: null }) }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    expect(out.data).toContain("Status: none");
    expect(out.data).not.toContain("Result:");
  });

  it("emits a bare FindingDetail object under --json", async () => {
    const { writers: w, out } = writers();
    await runShow({
      client: fakeClient({ finding: detail() }),
      json: true,
      writers: w,
      findingId: "fnd-1",
    });
    const parsed = JSON.parse(out.data) as Record<string, unknown>;
    expect(parsed.finding_id).toBe("fnd-1");
    expect(parsed.data).toBeUndefined(); // bare object, not a {data,meta} envelope
    expect((parsed.rca as { status: string }).status).toBe("done");
  });

  it("errors when neither a finding id nor --trace is given", async () => {
    const { writers: w } = writers();
    await expect(
      runShow({ client: fakeClient({}), json: false, writers: w }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("errors when both a finding id and --trace are given", async () => {
    const { writers: w } = writers();
    await expect(
      runShow({ client: fakeClient({}), json: false, writers: w, findingId: "f", traceId: "t" }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("treats a blank finding id as missing (clear error, no malformed request)", async () => {
    const { writers: w } = writers();
    await expect(
      runShow({ client: fakeClient({}), json: false, writers: w, findingId: "" }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("treats a blank --trace value as missing", async () => {
    const { writers: w } = writers();
    await expect(
      runShow({ client: fakeClient({}), json: false, writers: w, traceId: "  " }),
    ).rejects.toBeInstanceOf(CliError);
  });
});
