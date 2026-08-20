import { describe, expect, it } from "vitest";
import type { FindingDetail } from "../../../src/api/client.js";
import { CliError, type Writers } from "../../../src/output.js";
import {
  categoryLabel,
  findingsGet,
  renderFinding,
} from "../../../src/registry/enhancers/findings-get.js";
import { runCli } from "../../helpers/runCli.js";
import { StringSink } from "../../helpers/stringSink.js";

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

describe("renderFinding", () => {
  it("renders Finding / Detectors / RCA blocks for a finding id", () => {
    const { writers: w } = writers();
    const out = renderFinding(detail(), w, "UTC");
    expect(out).toContain("Finding ID:");
    expect(out).toContain("fnd-1");
    expect(out).toContain("Trace ID:");
    expect(out).toContain("tr-1");
    expect(out).toContain("Detector:");
    expect(out).toContain("hallucination"); // detector name (precedence)
    expect(out).toContain("ID:");
    expect(out).toContain("d1"); // detector id
    expect(out).toContain("Category:");
    expect(out).toContain("Hallucination"); // human category label
    expect(out).toContain("RCA:");
    expect(out).not.toContain("RCA: done"); // status dropped when a result is present
    expect(out).toContain("the root cause"); // rca result printed verbatim
    // no per-section RCA header now that there's no structured packet
    expect(out).not.toContain("Root cause:");
    // per-detector summary + data and the "Identified" field are JSON-only now
    expect(out).not.toContain("unsupported claims");
    expect(out).not.toContain('"k": "v"');
    expect(out).not.toContain("Identified");
  });

  it("shows 'RCA: none' and no Root cause line when rca is null", () => {
    const { writers: w } = writers();
    const out = renderFinding(detail({ rca: null }), w);
    expect(out).toContain("RCA: none");
    expect(out).not.toContain("Root cause");
  });

  it("keeps the RCA status when it is still in progress (no result yet)", () => {
    const { writers: w } = writers();
    const out = renderFinding(detail({ rca: { status: "processing", result: null } }), w);
    expect(out).toContain("RCA: processing");
  });

  it("prints an RCA result that is already a list without doubling the bullets", () => {
    const { writers: w } = writers();
    const out = renderFinding(
      detail({ rca: { status: "done", result: "- root cause one\n- root cause two" } }),
      w,
    );
    expect(out).toContain("- root cause one");
    expect(out).not.toContain("- - root cause one"); // no doubled list markers
  });
});

describe("findingsGet.render (--json)", () => {
  it("emits a bare FindingDetail object under --json", async () => {
    const { writers: w, out } = writers();
    await findingsGet.render?.(detail(), {
      json: true,
      writers: w,
      args: {},
      state: undefined,
      dispatchTool: () => Promise.reject(new Error("unused")),
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
});

describe("findingsGet.resolveArgs", () => {
  it("resolves a finding id to args.finding_id (no retargeting)", () => {
    const resolved = findingsGet.resolveArgs?.({
      opts: {},
      positionals: { finding_id: "fnd-1" },
      extras: [],
    });
    expect(resolved).toEqual({ args: { finding_id: "fnd-1" } });
  });

  it("retargets to get_finding_by_trace for --trace", () => {
    const resolved = findingsGet.resolveArgs?.({
      opts: { trace: "tr-9" },
      positionals: { finding_id: undefined },
      extras: [],
    });
    expect(resolved).toEqual({ tool: "get_finding_by_trace", args: { trace_id: "tr-9" } });
  });

  it("errors when neither a finding id nor --trace is given", () => {
    expect(() =>
      findingsGet.resolveArgs?.({
        opts: {},
        positionals: { finding_id: undefined },
        extras: [],
      }),
    ).toThrow(CliError);
  });

  it("errors when both a finding id and --trace are given", () => {
    expect(() =>
      findingsGet.resolveArgs?.({
        opts: { trace: "t" },
        positionals: { finding_id: "f" },
        extras: [],
      }),
    ).toThrow(CliError);
  });

  it("treats a blank finding id as missing (clear error, no malformed request)", () => {
    expect(() =>
      findingsGet.resolveArgs?.({
        opts: {},
        positionals: { finding_id: "" },
        extras: [],
      }),
    ).toThrow(CliError);
  });

  it("treats a blank --trace value as missing", () => {
    expect(() =>
      findingsGet.resolveArgs?.({
        opts: { trace: "  " },
        positionals: { finding_id: undefined },
        extras: [],
      }),
    ).toThrow(CliError);
  });
});

// Action-level guards (parsed by commander) — exercised end-to-end via the built
// CLI, since stray-operand rejection and duplicate-flag rejection depend on
// commander's own parsing (registeredArguments count, onceOption), not just
// resolveArgs in isolation.
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

describe("categoryLabel", () => {
  it("pins the multi-word product labels the title-case fallback cannot produce", () => {
    // If a CATEGORY_LABELS entry is removed or its slug renamed, the fallback
    // would silently show a title-cased slug ("Logic") — these assertions make
    // that drift a test failure instead of a silent UI divergence.
    expect(categoryLabel("logic")).toBe("Logic Error");
    expect(categoryLabel("task")).toBe("Task Completion");
  });

  it("title-cases unknown templates and maps missing ones to Unknown", () => {
    expect(categoryLabel("prompt-injection")).toBe("Prompt-injection");
    expect(categoryLabel(null)).toBe("Unknown");
    expect(categoryLabel(undefined)).toBe("Unknown");
  });

  it("does not leak inherited Object.prototype members for hostile template names", () => {
    expect(categoryLabel("toString")).toBe("ToString");
    expect(categoryLabel("constructor")).toBe("Constructor");
  });
});
