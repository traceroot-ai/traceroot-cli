import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInstrument } from "../../src/commands/instrument.js";
import { CliError, type Writers } from "../../src/output.js";
import type { RepoDetection } from "../../src/repo/detect.js";
import { StringSink } from "../helpers/stringSink.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tr-instrument-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const tsDetection: RepoDetection = {
  root: "/repo",
  hasPackageJson: true,
  hasPyprojectToml: false,
  hasRequirementsTxt: false,
  hasTsconfigJson: true,
  likelyLanguages: ["typescript", "javascript"],
  packageManager: "pnpm",
};

const base = { agentId: "claude", cwd: "", force: false, json: false } as const;

describe("runInstrument (--print)", () => {
  it("prints the prompt to stdout and writes no file", () => {
    const { writers, out } = makeWriters();
    runInstrument({ ...base, cwd, print: true, writers, detection: tsDetection });
    expect(out.data).toContain("Instrument this repository with TraceRoot");
    expect(existsSync(join(cwd, ".traceroot"))).toBe(false);
  });

  it("includes the detected repo facts", () => {
    const { writers, out } = makeWriters();
    runInstrument({ ...base, cwd, print: true, writers, detection: tsDetection });
    expect(out.data).toContain("Detected repository facts:");
    expect(out.data).toContain("package.json: present");
    expect(out.data).toContain("pyproject.toml: absent");
    expect(out.data).toContain("package manager: pnpm");
  });

  it("never embeds an API key value in the prompt", () => {
    const { writers, out } = makeWriters();
    runInstrument({ ...base, cwd, print: true, writers, detection: tsDetection });
    expect(out.data).not.toMatch(/tr_[A-Za-z0-9]/);
    // It references the env var name as guidance, but assigns no value.
    expect(out.data).toContain("TRACEROOT_API_KEY");
    expect(out.data).not.toMatch(/TRACEROOT_API_KEY\s*=/);
  });

  it("emits valid JSON carrying the prompt under data when --print --json", () => {
    const { writers, out } = makeWriters();
    runInstrument({ ...base, cwd, print: true, json: true, writers, detection: tsDetection });
    const parsed = JSON.parse(out.data) as { data: { printed: boolean; prompt: string } };
    expect(parsed.data.printed).toBe(true);
    expect(parsed.data.prompt).toContain("Instrument this repository");
  });
});

describe("runInstrument (file write)", () => {
  it("writes the default .traceroot/prompts/instrument-repo.md", () => {
    const { writers } = makeWriters();
    runInstrument({ ...base, cwd, print: false, writers, detection: tsDetection });
    const target = join(cwd, ".traceroot", "prompts", "instrument-repo.md");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("Instrument this repository");
  });

  it("refuses to overwrite an existing prompt without --force", () => {
    const { writers } = makeWriters();
    const args = { ...base, cwd, print: false, writers, detection: tsDetection };
    runInstrument(args);
    expect(() => runInstrument(args)).toThrow(CliError);
  });

  it("overwrites with --force", () => {
    const { writers } = makeWriters();
    const args = { ...base, cwd, print: false, writers, detection: tsDetection };
    runInstrument(args);
    expect(() => runInstrument({ ...args, force: true })).not.toThrow();
  });

  it("honors a custom --output path and reports it in JSON", () => {
    const { writers, out } = makeWriters();
    runInstrument({
      ...base,
      cwd,
      print: false,
      json: true,
      outputPath: "docs/prompt.md",
      writers,
      detection: tsDetection,
    });
    const parsed = JSON.parse(out.data) as { data: { output: string; bytes: number } };
    expect(parsed.data.output).toBe("docs/prompt.md");
    expect(parsed.data.bytes).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "docs", "prompt.md"))).toBe(true);
  });

  it("derives repo facts from cwd when no detection is injected", () => {
    writeFileSync(join(cwd, "pyproject.toml"), "", "utf8");
    const { writers } = makeWriters();
    runInstrument({ ...base, cwd, print: false, writers });
    const target = join(cwd, ".traceroot", "prompts", "instrument-repo.md");
    expect(readFileSync(target, "utf8")).toContain("pyproject.toml: present");
  });
});
