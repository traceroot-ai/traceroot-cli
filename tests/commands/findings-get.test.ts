import { describe, expect, it } from "vitest";
import type { ApiClient, FindingDetail } from "../../src/api/client.js";
import { runGet } from "../../src/commands/findings/get.js";
import { CliError, type Writers } from "../../src/output.js";
import { runCli } from "../helpers/runCli.js";
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
    listDetectors: reject,
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

describe("runGet", () => {
  it("renders Finding / Detectors / RCA blocks for a finding id", async () => {
    const state: FakeState = {};
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ finding: detail() }, state),
      json: false,
      writers: w,
      findingId: "fnd-1",
      timeZone: "UTC",
    });
    expect(state.lastGet).toBe("fnd-1");
    expect(out.data).toContain("Finding ID:");
    expect(out.data).toContain("fnd-1");
    expect(out.data).toContain("Trace ID:");
    expect(out.data).toContain("tr-1");
    expect(out.data).toContain("Detector:");
    expect(out.data).toContain("hallucination"); // detector name (precedence)
    expect(out.data).toContain("ID:");
    expect(out.data).toContain("d1"); // detector id
    expect(out.data).toContain("Category:");
    expect(out.data).toContain("Hallucination"); // human category label (no data.category to prefer)
    expect(out.data).toContain("Identified:");
    expect(out.data).toContain("yes"); // result.identified surfaced
    expect(out.data).toContain("RCA:");
    expect(out.data).not.toContain("RCA: done"); // status dropped when a result is present
    expect(out.data).toContain("the root cause"); // rca result printed verbatim
    // no per-section RCA header now that there's no structured packet
    expect(out.data).not.toContain("Root cause:");
    // per-detector summary + raw data payload stay JSON-only
    expect(out.data).not.toContain("unsupported claims");
    expect(out.data).not.toContain('"k": "v"');
  });

  it("dispatches to getFindingByTrace for --trace", async () => {
    const state: FakeState = {};
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ byTrace: detail({ trace_id: "tr-9" }) }, state),
      json: false,
      writers: w,
      traceId: "tr-9",
      timeZone: "UTC",
    });
    expect(state.lastByTrace).toBe("tr-9");
    expect(out.data).toContain("tr-9");
  });

  it("prefers the detector's own data.category, noting the raw template in parens", async () => {
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({
        finding: detail({
          results: [resultItem({ template: "failure", data: { category: "Tool call error" } })],
        }),
      }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    expect(out.data).toContain("Category:");
    expect(out.data).toContain("Tool call error (template: failure)");
  });

  it("falls back to the template label when data has no usable category", async () => {
    const { writers: w, out } = writers();
    for (const data of [{ k: "v" }, { category: 42 }, { category: "" }, null, "oops", [1, 2]]) {
      const localOut = out.data;
      await runGet({
        client: fakeClient({
          finding: detail({ results: [resultItem({ template: "logic", data })] }),
        }),
        json: false,
        writers: w,
        findingId: "fnd-1",
      });
      const added = out.data.slice(localOut.length);
      expect(added).toContain("Category:");
      expect(added).toContain("Logic Error");
      expect(added).not.toContain("(template:"); // fallback form has no parenthetical
    }
  });

  it("shows an Identified: no line when a result has identified: false", async () => {
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({
        finding: detail({ results: [resultItem({ identified: false })] }),
      }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    expect(out.data).toContain("Identified:");
    expect(out.data).toContain("no");
  });

  it("wraps a long RCA paragraph instead of printing raw hundreds-wide lines", async () => {
    const longWord = () => "word";
    const longParagraph = Array.from({ length: 40 }, longWord).join(" ");
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ finding: detail({ rca: { status: "done", result: longParagraph } }) }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    const rcaLines = out.data.split("\n").filter((line) => line.length > 0 && !line.includes(":"));
    for (const line of rcaLines) {
      expect(line.length).toBeLessThanOrEqual(80); // default fallback width
    }
  });

  it("styles-or-strips markdown headings and bold instead of printing them literally", async () => {
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({
        finding: detail({
          rca: { status: "done", result: "## Root Cause\n\nThe **tool call** failed." },
        }),
      }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    expect(out.data).not.toContain("##");
    expect(out.data).not.toContain("**");
    expect(out.data).toContain("Root Cause");
    expect(out.data).toContain("tool call");
  });

  it("shows 'RCA: none' and no Root cause line when rca is null", async () => {
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ finding: detail({ rca: null }) }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    expect(out.data).toContain("RCA: none");
    expect(out.data).not.toContain("Root cause");
  });

  it("keeps the RCA status when it is still in progress (no result yet)", async () => {
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ finding: detail({ rca: { status: "processing", result: null } }) }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    expect(out.data).toContain("RCA: processing");
  });

  it("prints an RCA result that is already a list without doubling the bullets", async () => {
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({
        finding: detail({ rca: { status: "done", result: "- root cause one\n- root cause two" } }),
      }),
      json: false,
      writers: w,
      findingId: "fnd-1",
    });
    expect(out.data).toContain("- root cause one");
    expect(out.data).not.toContain("- - root cause one"); // no doubled list markers
  });

  it("emits a bare FindingDetail object under --json", async () => {
    const { writers: w, out } = writers();
    await runGet({
      client: fakeClient({ finding: detail() }),
      json: true,
      writers: w,
      findingId: "fnd-1",
    });
    const parsed = JSON.parse(out.data) as Record<string, unknown>;
    expect(parsed.finding_id).toBe("fnd-1");
    expect(parsed.data).toBeUndefined(); // bare object, not a {data,meta} envelope
    expect((parsed.rca as { status: string }).status).toBe("done");
    // per-detector summary + data are dropped from the human view but kept here
    const result = (parsed.results as Array<Record<string, unknown>>)[0];
    expect(result?.summary).toBe("unsupported claims");
    expect(result?.data).toEqual({ k: "v" });
  });

  it("errors when neither a finding id nor --trace is given", async () => {
    const { writers: w } = writers();
    await expect(
      runGet({ client: fakeClient({}), json: false, writers: w }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("errors when both a finding id and --trace are given", async () => {
    const { writers: w } = writers();
    await expect(
      runGet({ client: fakeClient({}), json: false, writers: w, findingId: "f", traceId: "t" }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("treats a blank finding id as missing (clear error, no malformed request)", async () => {
    const { writers: w } = writers();
    await expect(
      runGet({ client: fakeClient({}), json: false, writers: w, findingId: "" }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("treats a blank --trace value as missing", async () => {
    const { writers: w } = writers();
    await expect(
      runGet({ client: fakeClient({}), json: false, writers: w, traceId: "  " }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

// Action-level guards (parsed by commander) — exercised end-to-end via the built
// CLI, since they live in the command action, not runGet.
describe("findings get argument guards (CLI)", () => {
  it("rejects extra positional arguments", () => {
    const r = runCli("findings", "get", "abc", "def");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unexpected argument(s)");
  });

  it("rejects a repeated --trace flag", () => {
    const r = runCli("findings", "get", "--trace", "t1", "--trace", "t2");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--trace may only be given once");
  });
});
