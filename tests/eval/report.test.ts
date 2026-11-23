import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { Sink } from "../../src/output.js";
import type { CaseLine, CaseScore, EvaluationCompletedEvent } from "../../src/eval/protocol.js";
import {
  type Report,
  type SavedEvaluation,
  formatDuration,
  renderSummary,
  toDocument,
} from "../../src/eval/report.js";
import { type UsageBucket, emptyBucket } from "../../src/eval/usage.js";
import { displayWidth } from "../../src/render/wrap.js";

/**
 * The summary's edge cases, from runs built here rather than recorded: what the recorded runs
 * can't show, such as a run with many errors, values that aren't numbers, or several evaluations.
 */

const CWD = "/work/project";

/** A sink that keeps what is written: a terminal `columns` wide when given, else a pipe. */
function sink(columns?: number): Sink & { text: string; columns?: number } {
  return {
    text: "",
    isTTY: columns !== undefined,
    columns,
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
    runner: {
      language: "python",
      sdkVersion: "0.5.1",
      argv: ["python"],
      runtime: { name: "Python", version: "3.12.13", executable: "/work/project/.venv/bin/python" },
    },
    runs,
    baseline: null,
    upload: null,
    verdict: null,
    signal: null,
    failure: null,
    elapsedMs: null,
  };
}

/** The summary as written, styled when FORCE_COLOR is set, to a terminal `columns` wide if given. */
function rawSummary(of: Report, cwd = CWD, columns?: number): string {
  const out = sink(columns);
  renderSummary(of, { out, err: sink() }, { env: {}, cwd });
  return out.text;
}

/** The summary without its styling. */
function summary(of: Report, cwd = CWD, columns?: number): string {
  return stripVTControlCharacters(rawSummary(of, cwd, columns));
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
    expect(text).toContain("\nCase file  .traceroot/eval/runs/run_a.cases.jsonl\n");
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
      "\nRun file   /work/project/.traceroot/eval/runs/run_a.json\n",
    );
  });

  it("asks for a run id when the file ran several evaluations, since a baseline is one evaluation's run", () => {
    const text = summary(
      report([
        evaluation("first", "run_a", [item("a")]),
        evaluation("second", "run_b", [item("b")]),
      ]),
    );

    expect(text).toBe(
      [
        "first · run_a · completed",
        "  1 case · 0 errored",
        "  no scores",
        "",
        "second · run_b · completed",
        "  1 case · 0 errored",
        "  no scores",
        "",
        "Regression check: skipped, because no baseline was given.",
        "",
        "LLM use: not recorded; traceroot 0.5.1 doesn't count a run's LLM calls.",
        "",
        "first",
        "  Run file   .traceroot/eval/runs/run_a.json",
        "  Case file  .traceroot/eval/runs/run_a.cases.jsonl",
        "second",
        "  Run file   .traceroot/eval/runs/run_b.json",
        "  Case file  .traceroot/eval/runs/run_b.cases.jsonl",
        "",
        "To compare the next run with one of these, give its run id:",
        "  traceroot evals run evals/x_eval.py --baseline <run id>",
        "",
      ].join("\n"),
    );
  });
});

describe("renderSummary on a narrow terminal", () => {
  const cases = [
    item("tc_d2682fce6e8c00532e62", {
      scores: [score("exact_match", true, true)],
      scorer_errors: [
        {
          scorer_name: "judge",
          scorer_version: null,
          message: "KeyError: 'rubric' was missing from the judge's template variables",
        },
      ],
    }),
    item("tc_c9ee6cb242cade5547b7", { scores: [score("exact_match", false, false)] }),
  ];
  const run = evaluation("uppercase", "run_01M7S5GKT91KS2B33EGQHDK7PJ", cases);
  const id = "run_01M7S5GKT91KS2B33EGQHDK7PJ";

  it("stacks a score table that doesn't fit, wraps prose with a hanging indent, and keeps the command whole", () => {
    const text = summary(report([run]), CWD, 40);

    expect(text).toBe(
      [
        "uppercase",
        `  ${id}`,
        "  completed with errors",
        "  2 cases",
        "    1 errored (0 task errors, 1 scorer",
        "    error)",
        "  exact_match",
        "    mean 0.5 · scored 2 of 2 · passed 1",
        "      failed 1",
        "  Errors",
        "    tc_d2682fce6e8c00532e62",
        "      judge: KeyError: 'rubric' was",
        "        missing from the judge's",
        "        template variables",
        "",
        "Regression check: skipped, because no",
        "  baseline was given.",
        "",
        "LLM use: not recorded; traceroot 0.5.1",
        "  doesn't count a run's LLM calls.",
        "",
        "Run file",
        `  .traceroot/eval/runs/${id}.json`,
        "Case file",
        `  .traceroot/eval/runs/${id}.cases.jsonl`,
        "",
        "To compare the next run with this one:",
        `  traceroot evals run evals/x_eval.py --baseline ${id}`,
        "",
      ].join("\n"),
    );
    // Only a command or a path that is wider than the terminal on its own runs past it.
    const over = text.split("\n").filter((line) => displayWidth(line) > 40);
    expect(over).toEqual([
      `  .traceroot/eval/runs/${id}.json`,
      `  .traceroot/eval/runs/${id}.cases.jsonl`,
      `  traceroot evals run evals/x_eval.py --baseline ${id}`,
    ]);
  });

  it("keeps the table and wraps only the error column when the other columns fit", () => {
    const text = summary(report([run]), CWD, 60);

    expect(text).toContain(
      [
        "  SCORE        MEAN  SCORED  PASSED  FAILED",
        "  exact_match  0.5   2 of 2  1       1",
        "  Errors",
        "    CASE                     ERROR",
        "    tc_d2682fce6e8c00532e62  judge: KeyError: 'rubric' was",
        "                             missing from the judge's",
        "                             template variables",
      ].join("\n"),
    );
    const over = text.split("\n").filter((line) => displayWidth(line) > 60);
    expect(over).toEqual([
      `  .traceroot/eval/runs/${id}.cases.jsonl`,
      `  traceroot evals run evals/x_eval.py --baseline ${id}`,
    ]);
  });

  it("prints every line whole to a pipe, however long", () => {
    const text = summary(report([run]));

    expect(text).toContain(
      "    tc_d2682fce6e8c00532e62  judge: KeyError: 'rubric' was missing from the judge's template variables\n",
    );
    expect(text).toContain(`\nCase file  .traceroot/eval/runs/${id}.cases.jsonl\n`);
  });

  it("lines up a table on display width when a name has wide characters", () => {
    const text = summary(
      report([
        evaluation("agent", "run_a", [
          item("a", { scores: [score("正确性", true, true), score("tone", 0.5, null)] }),
        ]),
      ]),
      CWD,
      80,
    );

    expect(text).toContain(
      ["  SCORE   MEAN  SCORED  PASSED  FAILED", "  正确性  1     1 of 1  1       0"].join("\n"),
    );
  });
});

describe("renderSummary's LLM use", () => {
  function used(changes: Partial<UsageBucket>): UsageBucket {
    return { ...emptyBucket(), ...changes };
  }
  const task = used({
    llm_calls: 10,
    llm_calls_with_usage: 10,
    input_tokens: 3400,
    output_tokens: 246,
    total_tokens: 3646,
    cache_read_tokens: 1024,
  });
  const judge = used({
    llm_calls: 3,
    llm_calls_with_usage: 3,
    input_tokens: 1020,
    output_tokens: 90,
    total_tokens: 1110,
    cost: 0.000351,
    llm_calls_with_cost: 3,
    currency: "USD",
  });

  it("puts the run's elapsed time and the task's calls apart from the scorers'", () => {
    const run = evaluation("agent", "run_a", [
      item("a", { usage: { task, scorers: judge } }),
      item("b", { usage: { task, scorers: emptyBucket() } }),
    ]);

    const text = summary({ ...report([run]), elapsedMs: 14_230 });

    expect(text).toContain(
      [
        "The run took 14.2 s in all.",
        "LLM USE            TASK     SCORERS",
        "calls              20       3",
        "input tokens       6,800    1,020",
        "output tokens      492      90",
        "total tokens       7,292    1,110",
        "cached input read  2,048    —",
        "cost               unknown  $0.000351",
      ].join("\n"),
    );
  });

  it("says when a figure covers only some calls or some cases, and why a cost is unknown", () => {
    const partial = used({ ...task, llm_calls_with_usage: 8 });
    const run = evaluation("agent", "run_a", [
      item("a", { usage: { task: partial, scorers: emptyBucket() } }),
      item("b", { usage: null }),
    ]);

    const text = summary(report([run]));

    expect(text).toContain(
      "  2 of 10 task calls reported no token counts, so the task figures are lower bounds.\n",
    );
    expect(text).toContain(
      "  A cost is unknown when no call reported one; TraceRoot prices an uploaded run's calls from its traces.\n",
    );
    expect(text).toContain("  These cover 1 of the run's 2 cases.\n");
  });

  it("says why there is no usage, never printing it as 0", () => {
    const none = summary(report([evaluation("agent", "run_a", [item("a", { usage: null })])]));
    const idle = summary(
      report([
        evaluation("agent", "run_a", [
          item("a", { usage: { task: emptyBucket(), scorers: emptyBucket() } }),
        ]),
      ]),
    );

    expect(none).toContain(
      "LLM use: not captured, because the evaluation instrumented no LLM client. Call traceroot.initialize(integrations=[...]) with the evaluation's LLM clients to count their calls.\n",
    );
    expect(idle).toContain("LLM use: no call through an instrumented LLM client.\n");
    expect(idle).not.toContain("LLM USE");
  });

  it("puts each evaluation's usage under its name, and the sums in the --json document", () => {
    const of = report([
      evaluation("first", "run_a", [item("a", { usage: { task, scorers: emptyBucket() } })]),
      evaluation("second", "run_b", [
        item("b", { usage: { task: judge, scorers: emptyBucket() } }),
      ]),
    ]);

    const text = summary(of);
    const document = toDocument(of) as { runs: { usage: unknown }[] };

    expect(text).toContain("first\n  LLM USE            TASK\n  calls              10\n");
    expect(text).toContain("second\n  LLM USE        TASK\n  calls          3\n");
    expect(document.runs[1]?.usage).toEqual({
      status: "reported",
      task: judge,
      scorers: emptyBucket(),
      cases: 1,
      cases_with_usage: 1,
    });
  });
});

describe("formatDuration", () => {
  it("reads in milliseconds, seconds, then minutes", () => {
    expect(formatDuration(1.5)).toBe("1.5 ms");
    expect(formatDuration(403.22)).toBe("403.22 ms");
    expect(formatDuration(2746)).toBe("2.75 s");
    expect(formatDuration(14_230)).toBe("14.2 s");
    expect(formatDuration(59_990)).toBe("1m 0s");
    expect(formatDuration(184_000)).toBe("3m 4s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });
});
