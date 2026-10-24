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

describe("what the report says the check ran with", () => {
  it("says it ran with TraceRoot switched off, and claims no run with it on", () => {
    // The check runs once, with the key absent and `TRACEROOT_ENABLED=false`.
    // "Passed both with and without" described a run with the key that setup
    // no longer makes, and that was the one run that could send traces.
    const text = renderSetupReport(
      ctx({ application: { command: "pytest", passed: true, skippedReason: null } }),
      NOW,
    );

    expect(text).toContain(
      "**Your checks.** Passed with TraceRoot switched off (`TRACEROOT_API_KEY` unset, `TRACEROOT_ENABLED=false`), so the application does not depend on TraceRoot being configured.",
    );
    expect(text).not.toContain("with and without");
  });
});

describe("the report as Markdown", () => {
  /**
   * The report's blocks as Markdown reads them: runs of lines between blank
   * lines. A paragraph or a table ends only at a blank line, so the blank lines
   * are the report's structure rather than its spacing.
   */
  function blocks(text: string): string[][] {
    return text
      .trimEnd()
      .split(/\n{2,}/)
      .map((block) => block.split("\n"));
  }

  const CLOSING = [
    "Application files changed by the agent are not listed here — `git diff` is the",
    "authority on those, and duplicating it would only go stale.",
  ];

  // Both ends of what the report can hold, because each optional entry is a
  // place a blank line can be lost or doubled.
  describe.each([
    ["with nothing optional", ctx(), "TraceRoot is configured, but no trace has been seen yet."],
    [
      "with every optional entry",
      ctx({
        method: "agent",
        agent: { id: "claude" },
        application: { command: "pytest", passed: true },
        trace: { traceId: "t_1", traceUrl: "https://app.example.test/trace/t_1" },
      }),
      "TraceRoot is connected and a trace has been received.",
    ],
  ])("%s", (_name, context, verdict) => {
    it("keeps every table whole", () => {
      // GFM continues a table until a blank line: without the one above it, the
      // closing note rendered as a row of the last table. A blank line inside a
      // table ends it instead, and the rows below it render as bare text.
      const tables = blocks(renderSetupReport(context, NOW)).filter((block) =>
        block.some((l) => l.startsWith("|")),
      );

      expect(tables).toHaveLength(3);
      for (const table of tables) {
        expect(table.every((l) => l.startsWith("|"))).toBe(true);
        expect(table[1]).toBe("|---|---|");
      }
    });

    it("sets each paragraph apart by exactly one blank line", () => {
      // The verdict is the line a reader skims and the one pasted into a pull
      // request; it ran into the "Generated" line below it as one paragraph, and
      // the checks, the command and the first trace read as one sentence.
      const text = renderSetupReport(context, NOW);
      const paragraphs = blocks(text).filter((block) => !block[0]?.startsWith("|"));

      expect(paragraphs.slice(0, 3)).toEqual([
        ["# TraceRoot setup report"],
        [verdict],
        ["Generated 2026-07-26T12:00:00.000Z by traceroot-cli 0.6.0."],
      ]);
      // Every heading and finding is one line of its own; only the closing note wraps.
      expect(paragraphs.at(-1)).toEqual(CLOSING);
      for (const paragraph of paragraphs.slice(0, -1)) {
        expect(paragraph).toHaveLength(1);
      }
      expect(text).not.toContain("\n\n\n");
      expect(text.endsWith(`${CLOSING[1]}\n`)).toBe(true);
    });
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
