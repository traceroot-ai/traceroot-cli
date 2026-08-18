import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FindingDetail, TraceExport } from "../../../src/api/client.js";
import { CliError, type Writers } from "../../../src/output.js";
import { runExport, tracesExport } from "../../../src/registry/enhancers/traces-export.js";
import { StringSink } from "../../helpers/stringSink.js";

function makeFinding(over: Partial<FindingDetail> = {}): FindingDetail {
  return {
    finding_id: "fnd-1",
    project_id: "proj-1",
    trace_id: "abc123",
    summary: "a finding summary",
    timestamp: "2026-06-05T12:00:00Z",
    detectors: ["hallucination"],
    results: [],
    rca: { status: "done", result: "root cause text" },
    ...over,
  };
}

function makeResponse(): TraceExport {
  return {
    trace: {
      git_ref: "main",
      git_repo: "https://github.com/example/repo",
      input: "hello",
      metadata: null,
      name: "root-trace",
      output: "world",
      project_id: "proj-1",
      session_id: null,
      spans: [],
      trace_id: "abc123",
      trace_start_time: "2026-06-05T12:00:00Z",
      trace_url: "https://app.example.com/traces/abc123",
      user_id: null,
    },
    spans: [
      {
        cost: null,
        input: null,
        input_tokens: null,
        metadata: null,
        model_name: null,
        name: "span-1",
        output: null,
        output_tokens: null,
        parent_span_id: null,
        span_end_time: null,
        span_id: "s1",
        span_kind: "internal",
        span_start_time: "2026-06-05T12:00:00Z",
        status: "ok",
        status_message: null,
        total_tokens: null,
        trace_id: "abc123",
      },
    ],
    git_context: {
      git_ref: "main",
      git_repo: "https://github.com/example/repo",
      sources: [{ file: "main.py", function: "run", line: 10, span_id: "s1" }],
    },
    manifest: {
      bundle_version: "1",
      files: ["trace.json", "spans.json", "git_context.json", "manifest.json"],
      project_id: "proj-1",
      trace_id: "abc123",
    },
  };
}

/** Best-effort finding lookup fake: mirrors what the enhancer's render wires up
 * from `ctx.dispatchTool("get_finding_by_trace", ...)`. */
function fakeGetFinding(
  finding: FindingDetail | null = null,
): (traceId: string) => Promise<FindingDetail | null> {
  return () => Promise.resolve(finding);
}

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tr-export-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runExport", () => {
  it("writes exactly the four bundle files and none of the deferred ones", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(),
    });

    const listing = readdirSync(outputDir).sort();
    expect(listing).toEqual(
      ["git_context.json", "manifest.json", "spans.json", "trace.json"].sort(),
    );
    expect(listing).not.toContain("logs.json");
    expect(listing).not.toContain("metrics.json");
    expect(listing).not.toContain("related_context.json");
  });

  it("writes trace.json whose parsed content deep-equals response.trace", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(),
    });

    const parsed = JSON.parse(readFileSync(join(outputDir, "trace.json"), "utf8"));
    expect(parsed).toEqual(response.trace);
  });

  it("writes spans.json, git_context.json, manifest.json that parse-equal the response fields", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(),
    });

    expect(JSON.parse(readFileSync(join(outputDir, "spans.json"), "utf8"))).toEqual(response.spans);
    expect(JSON.parse(readFileSync(join(outputDir, "git_context.json"), "utf8"))).toEqual(
      response.git_context,
    );
    expect(JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"))).toEqual(
      response.manifest,
    );
  });

  it("writes pretty JSON with 2-space indent and a trailing newline", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(),
    });

    const raw = readFileSync(join(outputDir, "trace.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "trace_id"');
  });

  it("uses a default trace_<id>_<timestamp> directory when no outputDir is given", async () => {
    const response = makeResponse();
    const { writers } = makeWriters();
    const cwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      await runExport(response, {
        traceId: "abc123",
        force: false,
        json: false,
        writers,
        getFinding: fakeGetFinding(),
        now: () => "2026-06-05T12-00-00Z",
      });
    } finally {
      process.chdir(cwd);
    }

    const expectedDir = join(tmpRoot, "trace_abc123_2026-06-05T12-00-00Z");
    expect(existsSync(join(expectedDir, "trace.json"))).toBe(true);
  });

  it("sanitizes unsafe characters in the trace id for the default directory name", async () => {
    const response = makeResponse();
    const { writers } = makeWriters();
    const cwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      await runExport(response, {
        traceId: "a/b\\c:d",
        force: false,
        json: false,
        writers,
        getFinding: fakeGetFinding(),
        now: () => "2026-06-05T12-00-00Z",
      });
    } finally {
      process.chdir(cwd);
    }

    const listing = readdirSync(tmpRoot);
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatch(/^trace_[A-Za-z0-9._-]+_2026-06-05T12-00-00Z$/);
  });

  it("contains a traversal-style trace id within a single directory under CWD", async () => {
    const response = makeResponse();
    const { writers } = makeWriters();
    const cwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      await runExport(response, {
        traceId: "../../evil",
        force: false,
        json: false,
        writers,
        getFinding: fakeGetFinding(),
        now: () => "2026-06-05T12-00-00Z",
      });
    } finally {
      process.chdir(cwd);
    }

    // Nothing escapes tmpRoot: exactly one bundle dir is created directly under it.
    const listing = readdirSync(tmpRoot);
    expect(listing).toHaveLength(1);
    expect(existsSync(join(tmpRoot, listing[0] as string, "trace.json"))).toBe(true);
  });

  it("produces a default directory name with no ':' (Windows-safe)", async () => {
    const response = makeResponse();
    const { writers } = makeWriters();
    const cwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      // No injected clock: exercises the real defaultTimestamp().
      await runExport(response, {
        traceId: "abc",
        force: false,
        json: false,
        writers,
        getFinding: fakeGetFinding(),
      });
    } finally {
      process.chdir(cwd);
    }

    const listing = readdirSync(tmpRoot);
    expect(listing).toHaveLength(1);
    expect(listing[0]).not.toContain(":");
  });

  it("refuses to clobber a non-empty output dir without --force and leaves it untouched", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "existing");
    const { writers } = makeWriters();
    const sentinel = join(outputDir, "sentinel.txt");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(sentinel, "keep me", "utf8");

    await expect(
      runExport(response, {
        traceId: "abc123",
        outputDir,
        force: false,
        json: false,
        writers,
        getFinding: fakeGetFinding(),
      }),
    ).rejects.toBeInstanceOf(CliError);

    expect(readFileSync(sentinel, "utf8")).toBe("keep me");
    expect(existsSync(join(outputDir, "trace.json"))).toBe(false);
  });

  it("overwrites a non-empty output dir when --force is given", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "existing");
    const { writers } = makeWriters();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "sentinel.txt"), "old", "utf8");

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: true,
      json: false,
      writers,
      getFinding: fakeGetFinding(),
    });

    expect(existsSync(join(outputDir, "trace.json"))).toBe(true);
  });

  it("allows an existing empty output dir without --force", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "empty");
    const { writers } = makeWriters();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outputDir, { recursive: true });

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(),
    });

    expect(existsSync(join(outputDir, "trace.json"))).toBe(true);
  });

  it("writes the final directory path to stdout and progress to stderr", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, out, err } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(),
    });

    expect(out.data.trim()).toBe(outputDir);
    expect(err.data.length).toBeGreaterThan(0);
    expect(err.data).toContain(outputDir);
  });

  it("emits exactly one JSON doc to stdout when json is true", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, out, err } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: true,
      writers,
      getFinding: fakeGetFinding(),
    });

    const lines = out.data.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(out.data);
    expect(parsed).toEqual({
      output_dir: outputDir,
      files: ["trace.json", "spans.json", "git_context.json", "manifest.json"],
      finding_id: null,
    });
    expect(err.data.length).toBeGreaterThan(0);
  });

  it("writes finding.json and reports the finding when the trace is flagged", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, out, err } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: true,
      writers,
      getFinding: fakeGetFinding(makeFinding()),
    });

    // finding.json is written with the full FindingDetail (finding id + rca).
    const finding = JSON.parse(readFileSync(join(outputDir, "finding.json"), "utf8"));
    expect(finding).toEqual(makeFinding());
    // reported in the bundle listing and the --json summary.
    expect(readdirSync(outputDir)).toContain("finding.json");
    const parsed = JSON.parse(out.data);
    expect(parsed.files).toContain("finding.json");
    expect(parsed.finding_id).toBe("fnd-1");
    expect(err.data).toContain("fnd-1"); // flag echoed to stderr
  });

  it("reports a file summary and a flagged line naming the detector", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, err } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(makeFinding()),
    });

    expect(err.data).toContain(
      "Wrote 5 files: trace.json, spans.json, git_context.json, manifest.json, finding.json",
    );
    expect(err.data).toContain("Flagged by hallucination — finding fnd-1 in finding.json");
  });

  it("reports a 4-file summary and no flagged line for an unflagged trace", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, err } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(null),
    });

    expect(err.data).toContain(
      "Wrote 4 files: trace.json, spans.json, git_context.json, manifest.json",
    );
    expect(err.data).not.toContain("Flagged");
  });

  it("patches manifest.json's files to include finding.json for a flagged trace, matching the --json summary", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, out } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: true,
      writers,
      getFinding: fakeGetFinding(makeFinding()),
    });

    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    const expectedFiles = [
      "trace.json",
      "spans.json",
      "git_context.json",
      "manifest.json",
      "finding.json",
    ];
    expect(manifest.files).toEqual(expectedFiles);
    const parsed = JSON.parse(out.data);
    expect(manifest.files).toEqual(parsed.files);
    // Everything else passes through untouched.
    expect(manifest.bundle_version).toBe(response.manifest.bundle_version);
    expect(manifest.project_id).toBe(response.manifest.project_id);
    expect(manifest.trace_id).toBe(response.manifest.trace_id);
  });

  it("writes manifest.json byte-identical to the server's manifest for an unflagged trace", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(null),
    });

    const raw = readFileSync(join(outputDir, "manifest.json"), "utf8");
    expect(raw).toBe(`${JSON.stringify(response.manifest, null, 2)}\n`);
    expect(JSON.parse(raw)).toEqual(response.manifest);
  });

  it("writes no finding.json when the finding lookup resolves null (best-effort)", async () => {
    // API failures resolve to null upstream (ctx.dispatchToolOptional), so a
    // null finding is the "lookup failed / not flagged" contract here.
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();
    const getFinding = () => Promise.resolve(null);

    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding,
    });

    // Bundle still written; the finding is simply omitted.
    expect(existsSync(join(outputDir, "trace.json"))).toBe(true);
    expect(existsSync(join(outputDir, "finding.json"))).toBe(false);
  });

  it("propagates a rejecting getFinding and writes no bundle directory", async () => {
    // Only API failures degrade to null (handled upstream); a rejection here is
    // a programming bug and must surface — and since the lookup precedes mkdir,
    // it must leave nothing on disk.
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();
    const getFinding = () => Promise.reject(new CliError("Failed to read finding"));

    await expect(
      runExport(response, {
        traceId: "abc123",
        outputDir,
        force: false,
        json: false,
        writers,
        getFinding,
      }),
    ).rejects.toThrow("Failed to read finding");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("removes a stale finding.json when re-exporting an unflagged trace with --force", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outputDir, { recursive: true });
    // A previous flagged export into this dir left a finding.json for a *different* trace.
    writeFileSync(join(outputDir, "finding.json"), '{"finding_id":"stale"}\n', "utf8");

    // The current trace is unflagged (finding lookup → null).
    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: true,
      json: false,
      writers,
      getFinding: fakeGetFinding(null),
    });

    // The stale finding.json must not survive — the bundle would otherwise carry a
    // detector finding that doesn't match trace.json.
    expect(existsSync(join(outputDir, "finding.json"))).toBe(false);
    expect(existsSync(join(outputDir, "trace.json"))).toBe(true);
  });

  it("--force re-export from flagged to unflagged drops finding.json and shrinks manifest.files back to 4", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    // Seed the directory as a prior *flagged* export would have left it: a
    // finding.json plus a 5-entry manifest.
    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
      getFinding: fakeGetFinding(makeFinding()),
    });
    expect(existsSync(join(outputDir, "finding.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8")).files).toContain(
      "finding.json",
    );

    // Re-export the same trace, now unflagged, with --force.
    await runExport(response, {
      traceId: "abc123",
      outputDir,
      force: true,
      json: false,
      writers,
      getFinding: fakeGetFinding(null),
    });

    expect(existsSync(join(outputDir, "finding.json"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest.files).toEqual([
      "trace.json",
      "spans.json",
      "git_context.json",
      "manifest.json",
    ]);
  });

  // The legacy suite also had "propagates a fetch failure and creates no bundle
  // dir or files" here. Under the factory, fetching export_trace happens before
  // `render` is ever invoked (see src/registry/factory.ts's `registerOne`:
  // `executeTool` is awaited, then only on success is `enhancer.render` called) —
  // so that guarantee is now inherent to the factory and there is no fetch step
  // left inside `runExport` to fail.
});

describe("tracesExport.resolveArgs (--fields)", () => {
  it("threads --fields through into the dispatched args", () => {
    const resolved = tracesExport.resolveArgs?.({
      opts: { fields: "io,metadata" },
      positionals: { trace_id: "abc123" },
      extras: [],
    });

    expect(resolved?.args).toEqual({ trace_id: "abc123", fields: "io,metadata" });
  });

  it("omits fields from the dispatched args when --fields is not given", () => {
    const resolved = tracesExport.resolveArgs?.({
      opts: {},
      positionals: { trace_id: "abc123" },
      extras: [],
    });

    expect(resolved?.args).toEqual({ trace_id: "abc123" });
  });
});
