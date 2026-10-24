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
import {
  REPORT_PATH,
  renderSetupReport,
  slashPath,
  writeSetupReport,
} from "../../src/setup/report.js";
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

  it("writes a path with forward slashes whatever the platform separator is", () => {
    // On Windows `relative()` separates with a backslash, and the cell escaper
    // doubles every backslash so Markdown prints it rather than eating it — so
    // the code span rendered two separators per directory and the reader could
    // not paste the path. Splitting on the platform's separator, rather than on
    // every backslash, is also what keeps a POSIX filename that genuinely
    // contains one intact.
    expect(slashPath("apps\\api\\.env", "\\")).toBe("apps/api/.env");
    expect(slashPath("weird\\name.env", "/")).toBe("weird\\name.env");
  });
});

describe("what the report says the checks established", () => {
  /** An application verification in one of its four outcomes. */
  function verification(over: Record<string, unknown>) {
    return {
      command: "pytest",
      baseline: null,
      run: { ran: true, exitCode: 0, durationMs: 1 },
      outcome: "passed",
      passed: true,
      skippedReason: null,
      ...over,
    };
  }

  it("does not call a suite that was already red a failure", () => {
    // A real run ended on "pytest failed after instrumentation" for a suite
    // that was failing before setup started, which sent the user looking for a
    // fault in work that had just been done correctly.
    const text = renderSetupReport(
      ctx({
        application: verification({
          outcome: "inconclusive",
          passed: false,
          baseline: { ran: true, exitCode: 1, durationMs: 9 },
          run: { ran: true, exitCode: 1, durationMs: 9 },
        }),
      }),
      NOW,
    );

    expect(text).toContain("Inconclusive.");
    expect(text).toContain("already failing before anything was instrumented (exit 1)");
    expect(text).not.toContain("Did not pass.");
  });

  it("does not claim a prior failure nobody observed", () => {
    // The other way to be inconclusive: no baseline at all, which is what the
    // routes that hand the instrumentation task over leave behind. Printing the
    // measured wording here would assert a prior failure nothing ever saw.
    const text = renderSetupReport(
      ctx({
        application: verification({
          outcome: "inconclusive",
          passed: false,
          baseline: null,
          run: { ran: true, exitCode: 1, durationMs: 9 },
        }),
      }),
      NOW,
    );

    expect(text).toContain("Inconclusive.");
    expect(text).toContain("nothing ran it before the code was instrumented");
    expect(text).not.toContain("already failing before anything was instrumented");
    expect(text).not.toContain("Did not pass.");
  });

  it("still says so plainly when instrumentation broke a passing suite", () => {
    const text = renderSetupReport(
      ctx({
        application: verification({
          outcome: "failed",
          passed: false,
          baseline: { ran: true, exitCode: 0, durationMs: 9 },
        }),
      }),
      NOW,
    );

    expect(text).toContain("Did not pass.");
    expect(text).not.toContain("Inconclusive.");
  });

  it("does not credit instrumentation the check never saw", () => {
    // A run that hands the task over edits nothing and takes no baseline, and
    // its check ran on code setup had not touched. Anything said about
    // TraceRoot there reads as a verdict on instrumentation nobody had written
    // yet, so the sentence says nothing about it.
    const text = renderSetupReport(ctx({ application: verification({ baseline: null }) }), NOW);

    expect(text).toContain(
      "**Your checks.** Passed. Setup made no edits itself, so this checked your code as it was when the check ran.",
    );
    expect(text).not.toMatch(/\*\*Your checks\.\*\*[^\n]*TraceRoot/);
  });

  it("names the reason when there was no command to run", () => {
    const text = renderSetupReport(
      ctx({
        application: verification({
          command: null,
          outcome: "skipped",
          passed: false,
          skippedReason: "no test or health command was detected",
          run: { ran: false, exitCode: null, durationMs: 0 },
        }),
      }),
      NOW,
    );

    expect(text).toContain("Not run — no test or health command was detected.");
    expect(text).not.toContain("Did not pass.");
  });
});

describe("what the report says about the trace it found", () => {
  /** The trace record the run writes, as the checkpoint carries it. */
  function trace(over: Record<string, unknown> = {}) {
    return {
      traceId: "t_1",
      traceUrl: "https://app.example.test/trace/t_1",
      observedAt: "2026-07-26T12:00:30.000Z",
      waitedMs: 4000,
      ...over,
    };
  }

  /**
   * The headline, read off the line it occupies rather than searched for.
   *
   * A `toContain` over the whole report would pass on a verdict that had the
   * sentence buried in a longer one, qualified or not.
   */
  function verdict(text: string): string {
    const lines = text.split("\n");
    // The title, the blank line that ends it, then the verdict.
    return lines[lines.indexOf("# TraceRoot setup report") + 2] as string;
  }

  function firstTrace(text: string): string {
    return text.split("\n").find((l) => l.startsWith("**First trace.")) as string;
  }

  const RECEIVED = "TraceRoot is connected and a trace has been received.";

  it("reports a one-span trace's size without passing judgement on it", () => {
    // The verdict used to be qualified over a single span, and the one run that
    // qualified it had opened a unit test's trace by mistake. One span is the
    // whole truth for a single-function script, and nothing the report knows
    // says which case it is in, so it prints the count and leaves it there.
    const text = renderSetupReport(ctx({ trace: trace({ spanCount: 1 }) }), NOW);

    expect(verdict(text)).toBe(RECEIVED);
    expect(firstTrace(text)).toBe("**First trace.** `t_1` — a single span");
  });

  it("reports the size of a trace with more than one span", () => {
    const text = renderSetupReport(ctx({ trace: trace({ spanCount: 7 }) }), NOW);

    expect(verdict(text)).toBe(RECEIVED);
    expect(firstTrace(text)).toBe("**First trace.** `t_1` — 7 spans");
  });

  it("claims no size at all when the deployment did not report one", () => {
    // Silence is not evidence of anything, so nothing is said about the size.
    const text = renderSetupReport(ctx({ trace: trace() }), NOW);

    expect(verdict(text)).toBe(RECEIVED);
    expect(firstTrace(text)).toBe("**First trace.** `t_1`");
  });

  it("still says plainly that no trace has arrived", () => {
    const text = renderSetupReport(ctx(), NOW);

    expect(verdict(text)).toBe("TraceRoot is configured, but no trace has been seen yet.");
    expect(firstTrace(text)).toBe(
      "**First trace.** None yet. Run the application, then `traceroot setup --resume`.",
    );
  });
});

describe("what the report says the check ran with", () => {
  it("says it ran with TraceRoot switched off, and claims no run with it on", () => {
    // The check runs once, with the key absent and `TRACEROOT_ENABLED=false`.
    // "Passed both with and without" described a run with the key that setup
    // no longer makes, and that was the one run that could send traces.
    const text = renderSetupReport(
      ctx({
        application: {
          command: "pytest",
          baseline: { ran: true, exitCode: 0, durationMs: 1 },
          run: { ran: true, exitCode: 0, durationMs: 1 },
          outcome: "passed",
          passed: true,
          skippedReason: null,
        },
      }),
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
  it("names the credential file this run actually used", () => {
    // The row used to be a constant naming `.env.traceroot`. The file is one of
    // the project's own now, so its name varies — `.env.local` as readily as
    // `.env` — and a run in a monorepo wrote it beside the service.
    const text = renderSetupReport(ctx({ credentialEnvFile: "/repo/apps/api/.env.local" }), NOW);

    expect(text).toContain("| `apps/api/.env.local` | `TRACEROOT_API_KEY` for the application. |");
  });

  it("omits the credential row when no credential file was written", () => {
    // `configure_repository` refuses a file git tracks, and does not run at all
    // when the application already resolves the key from its own environment.
    // The old constant row claimed a file this run never touched.
    const text = renderSetupReport(ctx(), NOW);

    expect(text).not.toContain("TRACEROOT_API_KEY` for the application");
  });

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
