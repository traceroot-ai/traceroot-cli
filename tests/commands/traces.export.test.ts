import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient, TraceExport } from "../../src/api/client.js";
import { runExport } from "../../src/commands/traces/export.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

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

function fakeClient(response: TraceExport): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("not used")),
    listTraces: () => Promise.reject(new Error("not used")),
    getTrace: () => Promise.reject(new Error("not used")),
    exportTrace: () => Promise.resolve(response),
  };
}

function throwingClient(error: unknown): ApiClient {
  return {
    whoami: () => Promise.reject(new Error("not used")),
    listTraces: () => Promise.reject(new Error("not used")),
    getTrace: () => Promise.reject(new Error("not used")),
    exportTrace: () => Promise.reject(error),
  };
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

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
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

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
    });

    const parsed = JSON.parse(readFileSync(join(outputDir, "trace.json"), "utf8"));
    expect(parsed).toEqual(response.trace);
  });

  it("writes spans.json, git_context.json, manifest.json that parse-equal the response fields", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
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

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
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
      await runExport({
        client: fakeClient(response),
        traceId: "abc123",
        force: false,
        json: false,
        writers,
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
      await runExport({
        client: fakeClient(response),
        traceId: "a/b\\c:d",
        force: false,
        json: false,
        writers,
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
      await runExport({
        client: fakeClient(response),
        traceId: "../../evil",
        force: false,
        json: false,
        writers,
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
      await runExport({
        client: fakeClient(response),
        traceId: "abc",
        force: false,
        json: false,
        writers,
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
      runExport({
        client: fakeClient(response),
        traceId: "abc123",
        outputDir,
        force: false,
        json: false,
        writers,
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

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: true,
      json: false,
      writers,
    });

    expect(existsSync(join(outputDir, "trace.json"))).toBe(true);
  });

  it("allows an existing empty output dir without --force", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "empty");
    const { writers } = makeWriters();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outputDir, { recursive: true });

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
    });

    expect(existsSync(join(outputDir, "trace.json"))).toBe(true);
  });

  it("writes the final directory path to stdout and progress to stderr", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, out, err } = makeWriters();

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: false,
      json: false,
      writers,
    });

    expect(out.data.trim()).toBe(outputDir);
    expect(err.data.length).toBeGreaterThan(0);
    expect(err.data).toContain(outputDir);
  });

  it("emits exactly one JSON doc to stdout when json is true", async () => {
    const response = makeResponse();
    const outputDir = join(tmpRoot, "bundle");
    const { writers, out, err } = makeWriters();

    await runExport({
      client: fakeClient(response),
      traceId: "abc123",
      outputDir,
      force: false,
      json: true,
      writers,
    });

    const lines = out.data.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(out.data);
    expect(parsed).toEqual({
      output_dir: outputDir,
      files: ["trace.json", "spans.json", "git_context.json", "manifest.json"],
    });
    expect(err.data.length).toBeGreaterThan(0);
  });

  it("propagates a fetch failure and creates no bundle dir or files", async () => {
    const outputDir = join(tmpRoot, "bundle");
    const { writers } = makeWriters();

    await expect(
      runExport({
        client: throwingClient(new CliError("trace not found")),
        traceId: "missing",
        outputDir,
        force: false,
        json: false,
        writers,
      }),
    ).rejects.toBeInstanceOf(CliError);

    expect(existsSync(outputDir)).toBe(false);
  });
});
