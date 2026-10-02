import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_PATH, renderSetupReport, writeSetupReport } from "../../src/setup/report.js";
import type { SetupContext } from "../../src/setup/types.js";

/** Only the fields the report reads; everything else is unreachable from here. */
function ctx(overrides: Record<string, unknown> = {}): SetupContext {
  return {
    root: "/repo",
    checkpoint: {
      cliVersion: "0.6.0",
      projectId: "p_1",
      projectName: "demo",
      workspaceId: "w_1",
      host: "https://api.example.test",
      service: { path: ".", language: "python", framework: null },
      sdkVersion: "1.2.3",
      agentId: "claude",
    },
    ...overrides,
  } as unknown as SetupContext;
}

const NOW = new Date("2026-07-26T12:00:00.000Z");

/** Every root this file makes, so none is left in the system tmpdir. */
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("the report table", () => {
  it("keeps a value containing a pipe inside its own cell", () => {
    // Values here are detected, not authored: a framework string or a command
    // with a pipe in it would otherwise split the row and shift every later
    // column, and a newline would end the table outright.
    const text = renderSetupReport(ctx({ method: "run | tee log" }), NOW);
    const row = text.split("\n").find((l) => l.startsWith("| Method |"));
    expect(row).toBe("| Method | run \\| tee log |");
  });

  it("keeps a multi-line value on one row", () => {
    const text = renderSetupReport(ctx({ method: "first\nsecond" }), NOW);
    expect(text).toContain("| Method | first second |");
  });
});

describe("writing the report", () => {
  it("replaces a symlink at its path instead of writing through it", () => {
    // `.traceroot/` is the run's own directory, but the report is the last thing
    // a run writes and the only file here written after an agent has been let
    // loose in the repository.
    const dir = mkdtempSync(join(tmpdir(), "traceroot-report-"));
    roots.push(dir);
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "untouched", "utf8");
    const target = join(dir, REPORT_PATH);
    mkdirSync(join(dir, ".traceroot"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, target);

    expect(writeSetupReport(ctx({ root: dir }), NOW)).toBe(REPORT_PATH);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(statSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("| Project | demo |");
  });
});
