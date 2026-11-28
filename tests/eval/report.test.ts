import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { PricedUsage } from "../../src/eval/priced-cost.js";
import type { CaseLine, CaseScore, EvaluationCompletedEvent } from "../../src/eval/protocol.js";
import {
  type Report,
  type SavedEvaluation,
  formatDuration,
  renderSummary,
  toDocument,
} from "../../src/eval/report.js";
import { type UsageBucket, emptyBucket } from "../../src/eval/usage.js";
import type { Sink } from "../../src/output.js";
import { displayWidth } from "../../src/render/wrap.js";
import { makeSecret } from "../../src/setup/secret.js";

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
        upload_results: { failed: 0, unconfirmed: 0 },
        close_confirmed: true,
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
    priced: null,
  };
}

/** The runner languages a summary is checked under. */
const LANGUAGES = [{ language: "python" as const }, { language: "typescript" as const }];

/** `of` as a run of the `language` runner, whose SDK, runtime and file differ. */
function under(language: "python" | "typescript", of: Report): Report {
  if (language === "python") {
    return of;
  }
  return {
    ...of,
    file: `${CWD}/evals/x_eval.ts`,
    runner: {
      language: "typescript",
      sdkVersion: "0.8.1",
      argv: ["node"],
      runtime: { name: "Node.js", version: "24.11.0", executable: "/usr/local/bin/node" },
    },
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
    input_tokens: 3400,
    llm_calls_with_input_tokens: 10,
    output_tokens: 246,
    llm_calls_with_output_tokens: 10,
    total_tokens: 3646,
    llm_calls_with_total_tokens: 10,
    cache_read_tokens: 1024,
    llm_calls_with_cache_read_tokens: 10,
  });
  const judge = used({
    llm_calls: 3,
    input_tokens: 1020,
    llm_calls_with_input_tokens: 3,
    output_tokens: 90,
    llm_calls_with_output_tokens: 3,
    total_tokens: 1110,
    llm_calls_with_total_tokens: 3,
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

  it("says when a figure covers only some calls or some cases, and leaves out a cost no call reported", () => {
    const partial = used({
      ...task,
      llm_calls_with_input_tokens: 8,
      llm_calls_with_output_tokens: 8,
      llm_calls_with_total_tokens: 8,
    });
    const run = evaluation("agent", "run_a", [
      item("a", { usage: { task: partial, scorers: emptyBucket() } }),
      item("b", { usage: null }),
    ]);

    const text = summary(report([run]));

    expect(text).toContain(
      [
        "LLM USE            TASK",
        "calls              10",
        "input tokens       3,400 (8 of 10 calls)",
        "output tokens      246 (8 of 10 calls)",
        "total tokens       3,646 (8 of 10 calls)",
        "cached input read  1,024",
        "  A figure followed by (n of m calls) counts only those calls, so it's a lower bound.",
        "  These cover 1 of the run's 2 cases.",
      ].join("\n"),
    );
    expect(text).not.toContain("A cost is unknown");
  });

  it.each(LANGUAGES)(
    "leaves the cost row out of a local $language run whose calls reported no cost",
    ({ language }) => {
      const unpriced = used({ ...judge, cost: null, llm_calls_with_cost: 0, currency: null });
      const run = evaluation("agent", "run_a", [item("a", { usage: { task, scorers: unpriced } })]);

      const text = summary(under(language, report([run])));

      expect(text).toContain(
        [
          "LLM USE            TASK   SCORERS",
          "calls              10     3",
          "input tokens       3,400  1,020",
          "output tokens      246    90",
          "total tokens       3,646  1,110",
          "cached input read  1,024  —",
          "",
          "Run file",
        ].join("\n"),
      );
      expect(text).not.toMatch(/^ *cost /m);
      expect(text).not.toContain("A cost is unknown");
    },
  );

  it.each(LANGUAGES)(
    "prints the cost row of a local $language run when a call reported a cost, and calls the rest unknown",
    ({ language }) => {
      const priced = used({ ...task, cost: 0.0021, llm_calls_with_cost: 10, currency: "USD" });
      const unpriced = used({ ...judge, cost: null, llm_calls_with_cost: 0, currency: null });
      const run = evaluation("agent", "run_a", [
        item("a", { usage: { task: priced, scorers: unpriced } }),
      ]);

      const text = summary(under(language, report([run])));

      expect(text).toContain(
        [
          "LLM USE            TASK     SCORERS",
          "calls              10       3",
          "input tokens       3,400    1,020",
          "output tokens      246      90",
          "total tokens       3,646    1,110",
          "cached input read  1,024    —",
          "cost               $0.0021  unknown",
          "  A cost is unknown when no call reported one.",
          "",
        ].join("\n"),
      );
      expect(text).not.toContain("estimated");
    },
  );

  it("marks each partial figure on its own, so a total below the input reads as partial", () => {
    // One call reported only its input; the other reported input, output and total.
    const fields = used({
      llm_calls: 2,
      input_tokens: 120,
      llm_calls_with_input_tokens: 2,
      output_tokens: 8,
      llm_calls_with_output_tokens: 1,
      total_tokens: 28,
      llm_calls_with_total_tokens: 1,
    });
    const priced = used({
      ...judge,
      cost: 0.000234,
      llm_calls_with_cost: 2,
    });
    const run = evaluation("agent", "run_a", [
      item("a", { usage: { task: fields, scorers: priced } }),
    ]);

    const text = summary(report([run]));

    expect(text).toContain(
      [
        "LLM USE        TASK               SCORERS",
        "calls          2                  3",
        "input tokens   120                1,020",
        "output tokens  8 (1 of 2 calls)   90",
        "total tokens   28 (1 of 2 calls)  1,110",
        "cost           unknown            $0.000234 (2 of 3 calls)",
        "  A figure followed by (n of m calls) counts only those calls, so it's a lower bound.",
        "  A cost is unknown when no call reported one.",
      ].join("\n"),
    );
  });

  it("says a cost is unknown only when a role that made calls has none", () => {
    const run = evaluation("agent", "run_a", [
      item("a", { usage: { task: emptyBucket(), scorers: judge } }),
    ]);

    const text = summary(report([run]));

    expect(text).toContain("cost           —     $0.000351\n");
    expect(text).not.toContain("A cost is unknown");
  });

  it("says when no call of a role reported token counts", () => {
    const run = evaluation("agent", "run_a", [
      item("a", { usage: { task: used({ llm_calls: 2 }), scorers: emptyBucket() } }),
    ]);

    const text = summary(report([run]));

    expect(text).toContain("input tokens   —\n");
    expect(text).toContain("  No task call reported token counts.\n");
    expect(text).not.toContain("(n of m calls)");
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

  it("says when the case file's usage can't be read, rather than that none was captured", () => {
    const text = summary(
      report([evaluation("agent", "run_a", [item("a", { usage: "unreadable" })])]),
    );

    expect(text).toContain(
      "LLM use: unknown, because the case file records it in a form this CLI can't read.\n",
    );
    expect(text).not.toContain("not captured");
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

describe("renderSummary for an uploaded run", () => {
  function uploaded(failed: number, unconfirmed: number): Report {
    const run = evaluation("agent", "run_a", [item("a"), item("b"), item("c"), item("d")]);
    run.event = { ...run.event, run_id: "evr_1", status: "incomplete" };
    if (run.run !== null) {
      run.run.file = { ...run.run.file, upload_results: { failed, unconfirmed } };
    }
    return {
      ...report([run]),
      outcome: "interrupted",
      upload: {
        target: { host: "https://api.example", apiKey: makeSecret("tr-test-key") },
        projectId: "p_1",
        readFlags: [],
      },
    };
  }

  it("says when TraceRoot may be missing some of the run's results, and why", () => {
    const text = summary(uploaded(1, 2));

    expect(text).toContain(
      [
        "Uploaded   run evr_1",
        "  1 result didn't reach TraceRoot, so the uploaded run is missing that case.",
        "  TraceRoot hadn't confirmed 2 results when the run stopped, so the uploaded run may be missing those cases.",
      ].join("\n"),
    );
    expect(
      (toDocument(uploaded(1, 2)) as { runs: { upload_results: unknown }[] }).runs[0],
    ).toMatchObject({
      upload_results: { failed: 1, unconfirmed: 2 },
    });
  });

  it("says nothing more when every result reached TraceRoot, and has no counts for a local run", () => {
    const text = summary(uploaded(0, 0));

    expect(text).toContain("Uploaded   run evr_1\n\n");
    expect(text).not.toContain("reach TraceRoot");
    const local = toDocument(report([evaluation("agent", "run_a", [item("a")])])) as {
      runs: { upload_results: unknown }[];
    };
    expect(local.runs[0]?.upload_results).toBeNull();
  });
});

describe("renderSummary's priced cost for an uploaded run", () => {
  type Bucket = PricedUsage["task"];
  const bucket = (b: Partial<Bucket> = {}): Bucket => ({
    cost: 0.0035,
    llm_calls: 20,
    priced_llm_calls: 20,
    state: "complete",
    ...b,
  });
  /** A run read's usage, priced unless a bucket says otherwise. */
  function usage(over: Partial<PricedUsage> = {}): PricedUsage {
    return {
      currency: "USD",
      results_processed: 6,
      results_pending: 0,
      results_without_trace: 0,
      task: bucket(),
      scorers: bucket({ cost: 0.0012, llm_calls: 6, priced_llm_calls: 6 }),
      combined: bucket({ cost: 0.0047, llm_calls: 26, priced_llm_calls: 26 }),
      ...over,
    };
  }
  const pricing = usage({
    results_pending: 2,
    results_processed: 4,
    task: bucket({ state: "processing" }),
    scorers: bucket({ state: "processing" }),
    combined: bucket({ state: "processing" }),
  });
  const unavailable = bucket({
    cost: null,
    llm_calls: 0,
    priced_llm_calls: 0,
    state: "unavailable",
  });
  /** A run read whose cases TraceRoot has no trace for. */
  const noTrace = usage({
    results_processed: 0,
    results_without_trace: 7,
    task: unavailable,
    scorers: unavailable,
    combined: unavailable,
  });
  const NEUTRAL_ONE =
    "Once TraceRoot has processed the run's traces, that command shows the cost it derives from them.\n";

  /** One uploaded run per name, `evr_<n>` in order, with what the read found for each. */
  function uploadedRuns(names: string[], priced: Map<string, PricedUsage | null> | null): Report {
    const runs = names.map((name, n) => {
      const run = evaluation(name, `run_${n}`, [item("a")]);
      run.event = { ...run.event, run_id: `evr_${n + 1}` };
      return run;
    });
    return {
      ...report(runs),
      upload: {
        target: { host: "https://api.example", apiKey: makeSecret("tr-test-key") },
        projectId: "p_1",
        readFlags: [],
      },
      priced,
    };
  }

  const READ_ONE =
    "To read the uploaded run from the terminal:\n  traceroot evals runs get evr_1 --project p_1\n";

  it("prints the cost TraceRoot priced the run's LLM calls at", () => {
    const text = summary(uploadedRuns(["agent"], new Map([["evr_1", usage()]])));

    expect(text).toContain(
      `${READ_ONE}TraceRoot priced the run's LLM calls: task $0.0035, scorers $0.0012, total $0.0047.\n`,
    );
    expect(text).not.toContain("Once TraceRoot");
  });

  it("prints each further line of the cost as a sentence of its own", () => {
    const text = summary(
      uploadedRuns(["agent"], new Map([["evr_1", usage({ results_without_trace: 1 })]])),
    );

    expect(text).toContain(
      [
        "TraceRoot priced the run's LLM calls: task $0.0035, scorers $0.0012, total $0.0047.",
        "1 of 7 cases has no trace in TraceRoot, so its calls aren't counted.",
        "",
      ].join("\n"),
    );
  });

  it("wraps the priced cost to the terminal as the other prose", () => {
    const text = summary(
      uploadedRuns(["agent"], new Map([["evr_1", usage({ results_without_trace: 1 })]])),
      CWD,
      40,
    );

    expect(text).toContain(
      [
        "TraceRoot priced the run's LLM calls:",
        "  task $0.0035, scorers $0.0012, total",
        "  $0.0047.",
        "1 of 7 cases has no trace in TraceRoot,",
        "  so its calls aren't counted.",
        "",
      ].join("\n"),
    );
  });

  it("says TraceRoot is still pricing a run it is still processing", () => {
    const text = summary(uploadedRuns(["agent"], new Map([["evr_1", pricing]])));

    expect(text).toContain(
      `${READ_ONE}TraceRoot is still pricing the run's LLM calls; that command shows the cost once it has.\n`,
    );
    expect(text).not.toContain("TraceRoot priced");
  });

  it("says TraceRoot couldn't price a run with no priced call, never that it priced them", () => {
    const unpriced = bucket({ cost: null, priced_llm_calls: 0, state: "unpriced" });
    const read = usage({
      results_without_trace: 1,
      task: unpriced,
      scorers: bucket({ cost: null, llm_calls: 0, priced_llm_calls: 0, state: "no_calls" }),
      combined: unpriced,
    });

    const text = summary(uploadedRuns(["agent"], new Map([["evr_1", read]])));

    expect(text).toContain(
      [
        "TraceRoot couldn't price the run's LLM calls: task unknown (0 of 20 calls priced), scorers no LLM calls recorded, total unknown (0 of 20 calls priced).",
        "1 of 7 cases has no trace in TraceRoot, so its calls aren't counted.",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("TraceRoot priced");
  });

  it("says TraceRoot recorded no LLM calls for a run that made none, not that it couldn't price them", () => {
    const none = bucket({ cost: null, llm_calls: 0, priced_llm_calls: 0, state: "no_calls" });
    const read = usage({ results_without_trace: 1, task: none, scorers: none, combined: none });

    const text = summary(uploadedRuns(["agent"], new Map([["evr_1", read]])));

    expect(text).toContain(
      [
        "TraceRoot recorded no LLM calls for the run.",
        "1 of 7 cases has no trace in TraceRoot, so its calls aren't counted.",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("couldn't price");
    expect(text).not.toContain("TraceRoot priced");
  });

  it("says a run recorded no LLM calls among several, and doesn't count it as priced", () => {
    const none = bucket({ cost: null, llm_calls: 0, priced_llm_calls: 0, state: "no_calls" });
    const read = usage({ task: none, scorers: none, combined: none });

    const only = summary(
      uploadedRuns(
        ["agent", "judge"],
        new Map([
          ["evr_1", read],
          ["evr_2", noTrace],
        ]),
      ),
    );
    expect(only).toContain(
      [
        "The runs' LLM cost:",
        "  agent: no LLM calls recorded",
        "  judge: no trace, so it can't be priced",
        "",
      ].join("\n"),
    );

    const mixed = summary(
      uploadedRuns(
        ["agent", "judge"],
        new Map([
          ["evr_1", read],
          ["evr_2", usage()],
        ]),
      ),
    );
    expect(mixed).toContain(
      "TraceRoot priced the runs' LLM calls:\n  agent: no LLM calls recorded\n",
    );
    expect(mixed).not.toContain("couldn't price");
  });

  it("says TraceRoot can't price a run it has no trace for", () => {
    const text = summary(uploadedRuns(["agent"], new Map([["evr_1", noTrace]])));

    expect(text).toContain(
      `${READ_ONE}TraceRoot can't price the run's LLM calls: it has no trace for the run's cases.\n`,
    );
    expect(text).not.toContain("still pricing");
  });

  it.each([
    { found: "a read that failed or found no usage", priced: new Map([["evr_1", null]]) },
    { found: "a run that wasn't read", priced: new Map<string, PricedUsage | null>() },
  ])("says only where the cost shows for $found", ({ priced }) => {
    const text = summary(uploadedRuns(["agent"], priced));

    expect(text).toContain(`${READ_ONE}${NEUTRAL_ONE}`);
    expect(text).not.toContain("still pricing");
  });

  it("prints each run's cost, or why there is none, under one line when several were uploaded", () => {
    const text = summary(
      uploadedRuns(
        ["agent", "judge\u001b[2J", "lookup", "triage", "router"],
        new Map([
          ["evr_1", usage()],
          ["evr_2", pricing],
          ["evr_3", noTrace],
          ["evr_4", null],
        ]),
      ),
    );

    expect(text).toContain(
      [
        "  traceroot evals runs get evr_5 --project p_1",
        "TraceRoot priced the runs' LLM calls:",
        "  agent: task $0.0035, scorers $0.0012, total $0.0047",
        "  judge\\u001b[2J: still being priced",
        "  lookup: no trace, so it can't be priced",
        "  triage: cost not read; its command above shows it",
        "  router: cost not read; its command above shows it",
        "",
      ].join("\n"),
    );
  });

  it("indents a run's further lines under it when several were uploaded", () => {
    const text = summary(
      uploadedRuns(
        ["agent", "judge"],
        new Map([
          ["evr_1", usage({ results_without_trace: 1 })],
          ["evr_2", usage()],
        ]),
      ),
    );

    expect(text).toContain(
      [
        "TraceRoot priced the runs' LLM calls:",
        "  agent: task $0.0035, scorers $0.0012, total $0.0047",
        "    1 of 7 cases has no trace in TraceRoot, so its calls aren't counted.",
        "  judge: task $0.0035, scorers $0.0012, total $0.0047",
        "",
      ].join("\n"),
    );
  });

  it.each([
    {
      found: "no trace for any",
      priced: new Map([
        ["evr_1", noTrace],
        ["evr_2", noTrace],
      ]),
      lines: [
        "  agent: no trace, so it can't be priced",
        "  judge: no trace, so it can't be priced",
      ],
    },
    {
      found: "one still being priced and one not read",
      priced: new Map([
        ["evr_1", pricing],
        ["evr_2", null],
      ]),
      lines: ["  agent: still being priced", "  judge: cost not read; its command above shows it"],
    },
    {
      found: "a run with no priced call and one still being priced",
      priced: new Map([
        [
          "evr_1",
          usage({
            task: bucket({ cost: null, priced_llm_calls: 0, state: "unpriced" }),
            scorers: bucket({ cost: null, llm_calls: 6, priced_llm_calls: 0, state: "unpriced" }),
            combined: bucket({ cost: null, llm_calls: 26, priced_llm_calls: 0, state: "unpriced" }),
          }),
        ],
        ["evr_2", pricing],
      ]),
      lines: [
        "  agent: task unknown (0 of 20 calls priced), scorers unknown (0 of 6 calls priced), total unknown (0 of 26 calls priced)",
        "  judge: still being priced",
      ],
    },
  ])(
    "heads the runs' lines neutrally when none of them was priced: $found",
    ({ priced, lines }) => {
      const text = summary(uploadedRuns(["agent", "judge"], priced));

      expect(text).toContain(
        [
          "  traceroot evals runs get evr_2 --project p_1",
          "The runs' LLM cost:",
          ...lines,
          "",
        ].join("\n"),
      );
      expect(text).not.toContain("TraceRoot priced");
    },
  );

  it("says TraceRoot is still pricing the runs when it is processing every one of several", () => {
    const text = summary(
      uploadedRuns(
        ["agent", "judge"],
        new Map([
          ["evr_1", pricing],
          ["evr_2", pricing],
        ]),
      ),
    );

    expect(text).toContain(
      "  traceroot evals runs get evr_2 --project p_1\nTraceRoot is still pricing the runs' LLM calls; those commands show the cost once it has.\n",
    );
  });

  it.each([
    {
      found: "reads that found nothing",
      priced: new Map([
        ["evr_1", null],
        ["evr_2", null],
      ]),
    },
    { found: "runs that weren't read", priced: null },
  ])("says only where the costs show when several runs have $found", ({ priced }) => {
    const text = summary(uploadedRuns(["agent", "judge"], priced));

    expect(text).toContain(
      "  traceroot evals runs get evr_2 --project p_1\nOnce TraceRoot has processed the runs' traces, those commands show the cost it derives from them.\n",
    );
    expect(text).not.toContain("TraceRoot priced");
    expect(text).not.toContain("still pricing");
  });

  it("keeps saying where the cost shows when the runs weren't read", () => {
    const text = summary(uploadedRuns(["agent"], null));

    expect(text).toContain(`${READ_ONE}${NEUTRAL_ONE}`);
  });

  it("puts each run's usage in the --json document as TraceRoot gave it, or null", () => {
    const doc = (of: Report) =>
      (toDocument(of) as { runs: { priced_usage: unknown }[] }).runs.map((run) => run.priced_usage);

    expect(
      doc(
        uploadedRuns(
          ["agent", "judge"],
          new Map([
            ["evr_1", usage()],
            ["evr_2", null],
          ]),
        ),
      ),
    ).toEqual([usage(), null]);
    expect(doc(uploadedRuns(["agent"], null))).toEqual([null]);
    expect(doc(report([evaluation("agent", "run_a", [item("a")])]))).toEqual([null]);
  });
});

describe.each(LANGUAGES)(
  "renderSummary's estimated cost for an uploaded $language run",
  ({ language }) => {
    type Bucket = PricedUsage["task"];
    function used(changes: Partial<UsageBucket>): UsageBucket {
      return { ...emptyBucket(), ...changes };
    }
    /** What the SDK counted, with no cost reported. */
    const SDK_TASK = used({
      llm_calls: 20,
      input_tokens: 6800,
      llm_calls_with_input_tokens: 20,
      output_tokens: 492,
      llm_calls_with_output_tokens: 20,
      total_tokens: 7292,
      llm_calls_with_total_tokens: 20,
    });
    const SDK_SCORERS = used({
      llm_calls: 6,
      input_tokens: 1020,
      llm_calls_with_input_tokens: 6,
      output_tokens: 90,
      llm_calls_with_output_tokens: 6,
      total_tokens: 1110,
      llm_calls_with_total_tokens: 6,
    });
    const SDK_USAGE = { task: SDK_TASK, scorers: SDK_SCORERS };

    const TASK: Bucket = { cost: 0.003514, llm_calls: 20, priced_llm_calls: 20, state: "complete" };
    const SCORERS: Bucket = {
      cost: 0.000463,
      llm_calls: 6,
      priced_llm_calls: 6,
      state: "complete",
    };
    const COMBINED: Bucket = {
      cost: 0.003977,
      llm_calls: 26,
      priced_llm_calls: 26,
      state: "complete",
    };
    /** A run read's usage, every call priced unless `over` says otherwise. */
    function read(over: Partial<PricedUsage> = {}): PricedUsage {
      return {
        currency: "USD",
        results_processed: 6,
        results_pending: 0,
        results_without_trace: 0,
        task: TASK,
        scorers: SCORERS,
        combined: COMBINED,
        ...over,
      };
    }

    /** One uploaded run per name, `evr_<n>` in order, each case with `usage`. */
    function uploaded(
      names: string[],
      priced: Map<string, PricedUsage | null> | null,
      usage: CaseLine["usage"] = SDK_USAGE,
    ): Report {
      const runs = names.map((name, n) => {
        const run = evaluation(name, `run_${n}`, [item("a", { usage })]);
        run.event = { ...run.event, run_id: `evr_${n + 1}` };
        return run;
      });
      return under(language, {
        ...report(runs),
        upload: {
          target: { host: "https://api.example", apiKey: makeSecret("tr-test-key") },
          projectId: "p_1",
          readFlags: [],
        },
        priced,
      });
    }

    const READ_ONE =
      "To read the uploaded run from the terminal:\n  traceroot evals runs get evr_1 --project p_1\n";
    const NEUTRAL_ONE =
      "Once TraceRoot has processed the run's traces, that command shows the cost it derives from them.\n";
    const LOWER_BOUND =
      "  A figure followed by (n of m calls) counts only those calls, so it's a lower bound.\n";

    it("puts TraceRoot's priced cost in the table, with the total under it, and no line after the command", () => {
      const text = summary(uploaded(["agent"], new Map([["evr_1", read()]])));

      expect(text).toContain(
        [
          "LLM USE         TASK      SCORERS",
          "calls           20        6",
          "input tokens    6,800     1,020",
          "output tokens   492       90",
          "total tokens    7,292     1,110",
          "estimated cost  $0.00351  $0.000463",
          "  estimated total: $0.00398",
          "",
          "Run file",
        ].join("\n"),
      );
      expect(text).not.toMatch(/^ *cost /m);
      expect(text).not.toContain("A cost is unknown");
      expect(text).not.toContain("TraceRoot priced the run's LLM calls");
      expect(text.endsWith(READ_ONE)).toBe(true);
    });

    it("follows a partly priced cost with how many calls it covers, and says it's a lower bound", () => {
      const partial = read({
        task: { ...TASK, priced_llm_calls: 18, state: "partial" },
        combined: { ...COMBINED, priced_llm_calls: 24, state: "partial" },
      });

      const text = summary(uploaded(["agent"], new Map([["evr_1", partial]])));

      expect(text).toContain(
        [
          "estimated cost  $0.00351 (18 of 20 calls)  $0.000463",
          "  estimated total: $0.00398 (24 of 26 calls)",
          LOWER_BOUND,
        ].join("\n"),
      );
      expect(text.endsWith(READ_ONE)).toBe(true);
    });

    it("calls unpriced scorers unknown with how many calls weren't priced, never $0", () => {
      const unpriced = read({
        scorers: { cost: null, llm_calls: 6, priced_llm_calls: 0, state: "unpriced" },
        combined: { cost: 0.003514, llm_calls: 26, priced_llm_calls: 20, state: "partial" },
      });

      const text = summary(uploaded(["agent"], new Map([["evr_1", unpriced]])));

      expect(text).toContain(
        [
          "estimated cost  $0.00351  unknown (0 of 6 calls)",
          "  estimated total: $0.00351 (20 of 26 calls)",
          LOWER_BOUND,
        ].join("\n"),
      );
      expect(text).not.toMatch(/\$0(?![.\d])/);
      expect(text).not.toContain("couldn't price");
    });

    it("says a cost TraceRoot is still pricing is pending, and where it will show", () => {
      const processing = (b: Bucket): Bucket => ({ ...b, state: "processing" });
      const pricing = read({
        results_processed: 4,
        results_pending: 2,
        task: processing({ ...TASK, cost: 0.0021, priced_llm_calls: 12 }),
        scorers: processing(SCORERS),
        combined: processing(COMBINED),
      });

      const text = summary(uploaded(["agent"], new Map([["evr_1", pricing]])));

      expect(text).toContain(
        [
          "estimated cost  pending  pending",
          "  estimated total: pending",
          "  Pending costs show in evals runs get once TraceRoot has priced the run.",
          "",
        ].join("\n"),
      );
      expect(text).not.toContain("0.0021");
      expect(text).not.toContain("still pricing");
      expect(text.endsWith(READ_ONE)).toBe(true);
    });

    it("says no trace for a run TraceRoot has no trace for", () => {
      const unavailable: Bucket = {
        cost: null,
        llm_calls: 0,
        priced_llm_calls: 0,
        state: "unavailable",
      };
      const noTrace = read({
        results_processed: 0,
        results_without_trace: 6,
        task: unavailable,
        scorers: unavailable,
        combined: unavailable,
      });

      const text = summary(uploaded(["agent"], new Map([["evr_1", noTrace]])));

      expect(text).toContain(
        [
          "estimated cost  no trace  no trace",
          "  estimated total: no trace",
          "  6 of 6 cases have no trace in TraceRoot, so their calls aren't counted.",
          "",
        ].join("\n"),
      );
      expect(text).not.toContain("can't price");
      expect(text.endsWith(READ_ONE)).toBe(true);
    });

    it("says when some cases have no trace, so their calls aren't counted", () => {
      const partial = (b: Bucket): Bucket => ({ ...b, state: "partial" });
      const without = read({
        results_without_trace: 1,
        task: partial(TASK),
        scorers: partial(SCORERS),
        combined: partial(COMBINED),
      });

      const text = summary(uploaded(["agent"], new Map([["evr_1", without]])));

      expect(text).toContain(
        "  1 of 7 cases has no trace in TraceRoot, so its calls aren't counted.\n",
      );
      expect(text.endsWith(READ_ONE)).toBe(true);
    });

    it.each([
      { found: "a read that failed or found no usage", priced: new Map([["evr_1", null]]) },
      { found: "a run that wasn't read", priced: new Map<string, PricedUsage | null>() },
      { found: "no read at all", priced: null },
    ])("has no estimated cost for $found, and says where the cost shows", ({ priced }) => {
      const text = summary(uploaded(["agent"], priced));

      expect(text).toContain("LLM USE");
      expect(text).not.toContain("estimated");
      expect(text).toContain(`${READ_ONE}${NEUTRAL_ONE}`);
    });

    it("keeps the priced line after the command when the SDK captured no usage, so there is no table", () => {
      const text = summary(uploaded(["agent"], new Map([["evr_1", read()]]), null));

      const setup =
        language === "python"
          ? "traceroot.initialize(integrations=[...])"
          : "initialize({ instrumentModules })";
      expect(text).toContain(
        `LLM use: not captured, because the evaluation instrumented no LLM client. Call ${setup} with the evaluation's LLM clients to count their calls.\n`,
      );
      expect(text).not.toContain("estimated");
      expect(text).toContain(
        `${READ_ONE}TraceRoot priced the run's LLM calls: task $0.00351, scorers $0.000463, total $0.00398.\n`,
      );
    });

    it("gives each evaluation its own estimated cost, and names after the commands only the run without one", () => {
      const text = summary(uploaded(["agent", "second"], new Map([["evr_1", read()]])));

      const [, agent = ""] = text.split("\nagent\n");
      const [, second = ""] = text.split("\nsecond\n");
      expect(agent).toMatch(/^ {2}LLM USE /);
      expect(agent.split("\n\n")[0]).toContain(
        ["  estimated cost  $0.00351  $0.000463", "    estimated total: $0.00398"].join("\n"),
      );
      expect(second).toMatch(/^ {2}LLM USE /);
      expect(second.split("\n\n")[0]).not.toContain("estimated");
      expect(
        text.endsWith(
          [
            "  traceroot evals runs get evr_2 --project p_1",
            "The runs' LLM cost:",
            "  second: cost not read; its command above shows it",
            "",
          ].join("\n"),
        ),
      ).toBe(true);
      expect(text).not.toContain("  agent:");
    });

    it("shows a SCORERS column TraceRoot counted calls for, with — where the SDK counted none", () => {
      const text = summary(
        uploaded(["agent"], new Map([["evr_1", read()]]), {
          task: SDK_TASK,
          scorers: emptyBucket(),
        }),
      );

      expect(text).toContain(
        [
          "LLM USE         TASK      SCORERS",
          "calls           20        —",
          "input tokens    6,800     —",
          "output tokens   492       —",
          "total tokens    7,292     —",
          "estimated cost  $0.00351  $0.000463",
          "  estimated total: $0.00398",
          "",
        ].join("\n"),
      );
    });

    it("calls a role's cost unknown when TraceRoot recorded none of the calls the SDK counted", () => {
      const noCalls: Bucket = { cost: null, llm_calls: 0, priced_llm_calls: 0, state: "no_calls" };
      const text = summary(
        uploaded(["agent"], new Map([["evr_1", read({ scorers: noCalls, combined: TASK })]])),
      );

      expect(text).toContain(
        ["estimated cost  $0.00351  unknown", "  estimated total: $0.00351", ""].join("\n"),
      );
    });

    it("prints no total when the table has only a TASK column, and $0 only for calls that cost 0", () => {
      const free: Bucket = { cost: 0, llm_calls: 20, priced_llm_calls: 20, state: "complete" };
      const noCalls: Bucket = { cost: null, llm_calls: 0, priced_llm_calls: 0, state: "no_calls" };
      const text = summary(
        uploaded(
          ["agent"],
          new Map([["evr_1", read({ task: free, scorers: noCalls, combined: free })]]),
          { task: SDK_TASK, scorers: emptyBucket() },
        ),
      );

      expect(text).toContain(
        [
          "LLM USE         TASK",
          "calls           20",
          "input tokens    6,800",
          "output tokens   492",
          "total tokens    7,292",
          "estimated cost  $0",
          "",
          "Run file",
        ].join("\n"),
      );
      expect(text).not.toContain("estimated total");
    });

    it("puts the SDK's usage and the run read's usage in the --json document as each gave it", () => {
      const document = toDocument(uploaded(["agent"], new Map([["evr_1", read()]]))) as {
        runs: { usage: unknown; priced_usage: unknown }[];
      };
      const [run] = document.runs;

      expect(JSON.stringify(run?.usage)).toBe(
        JSON.stringify({
          status: "reported",
          task: SDK_TASK,
          scorers: SDK_SCORERS,
          cases: 1,
          cases_with_usage: 1,
        }),
      );
      expect(JSON.stringify(run?.priced_usage)).toBe(
        JSON.stringify({
          currency: "USD",
          results_processed: 6,
          results_pending: 0,
          results_without_trace: 0,
          task: { cost: 0.003514, llm_calls: 20, priced_llm_calls: 20, state: "complete" },
          scorers: { cost: 0.000463, llm_calls: 6, priced_llm_calls: 6, state: "complete" },
          combined: { cost: 0.003977, llm_calls: 26, priced_llm_calls: 26, state: "complete" },
        }),
      );
    });
  },
);

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
