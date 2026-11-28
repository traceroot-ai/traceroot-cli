import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { Sink } from "../../src/output.js";
import type { CaseLine, CaseScore, EvaluationCompletedEvent } from "../../src/eval/protocol.js";
import { type Report, type SavedEvaluation, renderSummary } from "../../src/eval/report.js";

/**
 * The summary's edge cases, from runs built here rather than recorded: what the recorded runs
 * can't show, such as a run with many errors, values that aren't numbers, or several evaluations.
 */

const CWD = "/work/project";

function sink(): Sink & { text: string } {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
      return true;
    },
  };
}

function score(scorer_name: string, value: unknown, passed: boolean | null): CaseScore {
  return { scorer_name, scorer_version: null, value, passed };
}

function item(case_id: string, changes: Partial<CaseLine> = {}): CaseLine {
  return {
    case_id,
    status: "not_scored",
    input: null,
    expected: null,
    task_error: null,
    scorer_errors: [],
    scores: [],
    duration_ms: null,
    ...changes,
  };
}

function evaluation(name: string, id: string, cases: CaseLine[]): SavedEvaluation {
  const errored = cases.filter((c) => c.task_error !== null || c.scorer_errors.length > 0);
  const event: EvaluationCompletedEvent = {
    type: "evaluation_completed",
    name,
    status: errored.length === 0 ? "completed" : "completed_with_errors",
    local_run_id: id,
    run_id: null,
    counts: {
      cases: cases.length,
      errored: errored.length,
      task_errors: cases.filter((c) => c.task_error !== null).length,
      scorer_errors: cases.filter((c) => c.scorer_errors.length > 0).length,
      not_scored: cases.length,
    },
  };
  return {
    event,
    path: `${CWD}/.traceroot/eval/runs/${id}.json`,
    run: {
      file: {
        evaluation_name: name,
        status: event.status,
        run_mode: "full",
        is_final: true,
        dataset: null,
        scorers: [],
        artifact: { payloads: "complete" },
        dashboard_url: null,
      },
      cases,
    },
  };
}

function report(runs: SavedEvaluation[], file = `${CWD}/evals/x_eval.py`): Report {
  return {
    outcome: "ok",
    file,
    runner: { language: "python", sdkVersion: "0.5.1", argv: ["python"] },
    runs,
    baseline: null,
    upload: null,
    verdict: null,
    signal: null,
    failure: null,
  };
}

/** The summary as written, styled when FORCE_COLOR is set. */
function rawSummary(of: Report, cwd = CWD): string {
  const out = sink();
  renderSummary(of, { out, err: sink() }, { env: {}, cwd });
  return out.text;
}

/** The summary without its styling. */
function summary(of: Report, cwd = CWD): string {
  return stripVTControlCharacters(rawSummary(of, cwd));
}

describe("renderSummary", () => {
  it("lists the first ten errored cases and counts the rest, leaving them to the case file", () => {
    const cases = Array.from({ length: 13 }, (_, n) =>
      item(`case-${n}`, { task_error: `RuntimeError: provider rejected the key (${n})` }),
    );

    const text = summary(report([evaluation("agent", "run_a", cases)]));

    expect(text).toContain("    case-9  task: RuntimeError: provider rejected the key (9)\n");
    expect(text).not.toContain("case-10 ");
    expect(text).toContain("    and 3 more cases; the case file has each one's error.\n");
    expect(text).toContain("  Case file  .traceroot/eval/runs/run_a.cases.jsonl\n");
  });

  it("says which values the mean leaves out, and never reads them as 0", () => {
    const cases = [
      item("a", { scores: [score("tone", "warm", null), score("rating", 4, true)] }),
      item("b", { scores: [score("tone", "cold", null), score("rating", "n/a", null)] }),
      item("c", { scores: [score("tone", "warm", null), score("rating", null, null)] }),
    ];

    const text = summary(report([evaluation("agent", "run_a", cases)]));

    expect(text).toContain(
      [
        "  SCORE   MEAN  SCORED  PASSED  FAILED",
        "  tone    —     0 of 3  —       —",
        "  rating  4     1 of 3  1       0",
        "  tone: no value is a number or true/false, so it has no mean.",
        "  rating: 2 values aren't a number or true/false, so the mean leaves them out.",
        "  rating: 2 values neither pass nor fail.",
      ].join("\n"),
    );
  });

  it("counts a case once among the scored cases when it gives a score twice", () => {
    const cases = [
      item("a", { scores: [score("judge", true, true), score("judge", false, false)] }),
      item("b", { scores: [score("exact", true, true)] }),
    ];

    const text = summary(report([evaluation("agent", "run_a", cases)]));

    expect(text).toMatch(/\n {2}judge +0\.5 +1 of 2 +1 +1\n/);
  });

  it("names a score missing from a case that raised nothing", () => {
    const cases = [
      item("a", { scores: [score("judge", true, true), score("exact", true, true)] }),
      item("b", { scores: [score("exact", false, false)] }),
    ];

    const text = summary(report([evaluation("agent", "run_a", cases)]));

    expect(text).toContain("  judge  1     1 of 2  1       0\n");
    expect(text).toContain("  judge: missing from 1 case that raised no error.\n");
    expect(text).not.toContain("exact: missing");
  });

  it("escapes an error message, a scorer name and a case id", () => {
    const controls = "\u001b]0;pwned\u0007\u001b[2J";
    const cases = [
      item(`id${controls}`, {
        scorer_errors: [
          { scorer_name: `judge${controls}`, scorer_version: null, message: `boom${controls}` },
        ],
      }),
    ];

    const text = rawSummary(report([evaluation("agent", "run_a", cases)]));

    expect(text).not.toContain(controls);
    expect(text).toContain("judge\\u001b]0;pwned\\u0007\\u001b[2J: boom\\u001b]0;pwned");
  });

  it("prints a path outside the directory the CLI ran in as it is, and quotes a file a shell would split", () => {
    const text = summary(
      report([evaluation("agent", "run_a", [item("a")])], "/elsewhere/my evals/x_eval.py"),
    );

    expect(text).toContain(
      "  traceroot evals run '/elsewhere/my evals/x_eval.py' --baseline run_a\n",
    );
    expect(summary(report([evaluation("agent", "run_a", [item("a")])]), "/other")).toContain(
      "  Run file   /work/project/.traceroot/eval/runs/run_a.json\n",
    );
  });

  it("asks for a run id when the file ran several evaluations, since a baseline is one evaluation's run", () => {
    const text = summary(
      report([
        evaluation("first", "run_a", [item("a")]),
        evaluation("second", "run_b", [item("b")]),
      ]),
    );

    expect(text).toContain(
      [
        "No baseline given, so regressions weren't checked.",
        "To compare the next run with one of these, give its run id:",
        "  traceroot evals run evals/x_eval.py --baseline <run id>",
      ].join("\n"),
    );
  });
});
