/**
 * What an `evals run` came to, as the command prints it: the `--json` document, or the summary on
 * stdout. The summary prints everything that comes from the run through `clean()`, so an escape
 * sequence in an evaluation name, a case id or a runner's message can't act on the terminal.
 */

import { isAbsolute, relative } from "node:path";
import type { Writers } from "../output.js";
import { clean, compact, formatMean, plural } from "../registry/enhancers/eval-reads.js";
import { createStyler } from "../render/style.js";
import { fitTable } from "../render/table.js";
import { displayWidth, terminalColumns, wrapItems, wrapLine, wrapLines } from "../render/wrap.js";
import { cliCommand, shellWord } from "../setup/invocation.js";
import type { StackLanguage } from "../setup/types.js";
import type { InterruptSignal } from "./events.js";
import type { EvalRunner } from "./lookup.js";
import { type PricedUsage, isPriced, pricedCostLines } from "./priced-cost.js";
import type { CaseLine, EvaluationCompletedEvent } from "./protocol.js";
import type { UploadTarget } from "./spawn.js";
import {
  type RunUsage,
  type SumField,
  TOKEN_FIELDS,
  type TokenField,
  type UsageBucket,
  coverageOf,
  runUsage,
} from "./usage.js";
import {
  type ChangedPair,
  type NewlyFailingPair,
  type SavedRun,
  type Verdict,
  casesPathOf,
  partialRunReason,
} from "./verdict.js";

/** The package each language's runner comes from. */
export const SDK_NAMES: Readonly<Record<StackLanguage, string>> = {
  python: "traceroot",
  typescript: "@traceroot-ai/traceroot",
  javascript: "@traceroot-ai/traceroot",
};

/** The version of the `--json` document. A change that breaks a reader of it bumps it. */
const SCHEMA_VERSION = 1;

/** How wide a score value or an error message may print in the summary. */
const VALUE_WIDTH = 60;
const ERROR_WIDTH = 100;

/**
 * How many of a run's errored cases the summary lists. A run whose every case raised, as when a
 * model provider rejects the key, would otherwise bury the rest of the summary; the case file has
 * them all.
 */
const LISTED_ERRORS = 10;

/** An upload whose key TraceRoot accepted. */
export interface Upload {
  target: UploadTarget;
  /** The project the key belongs to, which the command that opens an uploaded run names. */
  projectId: string;
  /** The flags that gave the key or the host, which the command that opens an uploaded run repeats. */
  readFlags: string[];
}

/** A baseline run, read and checked. */
export interface Baseline {
  /** The run file's name without `.json`, which is the run id for a run the runner saved. */
  id: string;
  path: string;
  run: SavedRun;
}

/** One score's mean over a run, and what it is a mean of. */
export interface ScoreMean {
  name: string;
  /** null when no case gave the score a number or a boolean. */
  mean: number | null;
  /** How many cases produced the score. */
  count: number;
  /**
   * How many of those values the mean is over: the finite numbers and the booleans. A string, a
   * NaN or any other value is left out of the mean, never read as 0.
   */
  mean_count: number;
  /** How many of the values passed, as each value's `passed` says. */
  passed: number;
  /** How many of the values failed. */
  failed: number;
  /** How many of the values neither passed nor failed, such as a number with no threshold. */
  unjudged: number;
}

/** How long a run's cases took on average, each case its task and its scorers. */
export interface DurationMean {
  /** In milliseconds. null when the runner timed no case. */
  mean: number | null;
  /** How many cases were timed. */
  count: number;
}

/** An evaluation the runner ran, and the run it saved. */
export interface SavedEvaluation {
  event: EvaluationCompletedEvent;
  path: string;
  /** null for a run that couldn't be read, which only an interrupted run is printed with. */
  run: SavedRun | null;
}

/** What stopped a runner that failed after some of the file's evaluations finished. */
export interface Failure {
  /** The runner's `fatal` kind, or `crashed` for a runner that stopped without one. */
  kind: string;
  /**
   * The message of the error that reports the failure, as human mode's `error:` line says it but
   * without its escaping: the runner's kind and message, or what the crash was.
   */
  message: string;
}

/** What a run that the runner saved came to, for the summary and the `--json` document. */
export interface Report {
  /**
   * The verdict's outcome, `interrupted`, or `failed` for a runner that failed after some
   * evaluations finished, unless one of those regressed: `regressed` outranks the failure.
   * `not_uploaded`: an uploaded run's evaluation finished without a TraceRoot run id, and no case
   * regressed.
   */
  outcome: Verdict["outcome"] | "interrupted" | "failed" | "not_uploaded";
  file: string;
  runner: EvalRunner;
  runs: SavedEvaluation[];
  baseline: Baseline | null;
  upload: Upload | null;
  /** null without a baseline, and for an interrupted run, which is never compared. */
  verdict: Verdict | null;
  /** For an interrupted run: the signal the CLI received, or null when only the runner saw one. */
  signal: InterruptSignal | null;
  /** What stopped a runner that failed after some evaluations finished, otherwise null. */
  failure: Failure | null;
  /**
   * How long the runner ran, start to finish, in milliseconds: the whole run, as against the mean
   * time a case took. null when it wasn't timed.
   */
  elapsedMs: number | null;
  /**
   * What TraceRoot priced each uploaded run's LLM calls at, by TraceRoot run id, read once after the
   * runner exited: the run read's `usage`, or null for a run whose read failed, timed out or found
   * none. null when no run was read, as for a local or an interrupted run.
   */
  priced: Map<string, PricedUsage | null> | null;
}

/** The evaluations that finished without a TraceRoot run id. */
export function notUploaded(runs: SavedEvaluation[]): SavedEvaluation[] {
  return runs.filter((saved) => saved.event.run_id === null);
}

/**
 * Each score's mean over a run's cases, computed the way both SDKs compute the means they report:
 * a finite number or a boolean counts toward the mean, a boolean as 1 or 0, and any other value
 * only toward how many cases produced the score. Whether a value passed is read from its `passed`,
 * never from the value, so a number from a scorer with no threshold neither passes nor fails. In
 * the order the scores first appear.
 */
export function scoreMeans(cases: CaseLine[]): ScoreMean[] {
  const totals = new Map<string, { sum: number } & Omit<ScoreMean, "name" | "mean">>();
  for (const item of cases) {
    for (const score of item.scores) {
      const total = totals.get(score.scorer_name) ?? {
        sum: 0,
        count: 0,
        mean_count: 0,
        passed: 0,
        failed: 0,
        unjudged: 0,
      };
      totals.set(score.scorer_name, total);
      total.count += 1;
      const value = typeof score.value === "boolean" ? Number(score.value) : score.value;
      if (typeof value === "number" && Number.isFinite(value)) {
        total.sum += value;
        total.mean_count += 1;
      }
      if (score.passed === true) {
        total.passed += 1;
      } else if (score.passed === false) {
        total.failed += 1;
      } else {
        total.unjudged += 1;
      }
    }
  }
  return [...totals].map(([name, { sum, ...total }]) => ({
    name,
    mean: total.mean_count === 0 ? null : sum / total.mean_count,
    ...total,
  }));
}

/**
 * How long a run's cases took on average, over the cases the runner timed. A mean per case, as
 * `evals runs get` labels the duration it reads back, never a total.
 */
export function meanDuration(cases: CaseLine[]): DurationMean {
  const timed = cases.flatMap((item) => (item.duration_ms === null ? [] : [item.duration_ms]));
  return {
    mean: timed.length === 0 ? null : timed.reduce((sum, ms) => sum + ms, 0) / timed.length,
    count: timed.length,
  };
}

/**
 * The `--json` document. Text from the run is kept as the runner wrote it: JSON escapes control
 * characters itself.
 */
export function toDocument(report: Report): Record<string, unknown> {
  const { runner, baseline, verdict } = report;
  return {
    schema_version: SCHEMA_VERSION,
    outcome: report.outcome,
    file: report.file,
    sdk: {
      language: runner.language,
      name: SDK_NAMES[runner.language],
      version: runner.sdkVersion,
    },
    runtime: {
      name: runner.runtime.name,
      version: runner.runtime.version,
      executable: runner.runtime.executable,
    },
    project_id: report.upload?.projectId ?? null,
    runs: report.runs.map(({ event, path, run }) => ({
      evaluation_name: event.name,
      local_run_id: event.local_run_id,
      uploaded_run_id: event.run_id,
      uploaded_run_url: uploadedRunUrl(event, run),
      status: event.status,
      path,
      cases_path: casesPathOf(path),
      counts: event.counts,
      duration_ms: run === null ? null : meanDuration(run.cases),
      scores: run === null ? null : scoreMeans(run.cases),
      usage: run === null ? null : runUsage(run.cases.map((item) => item.usage)),
      upload_results:
        report.upload === null || event.run_id === null || run === null
          ? null
          : run.file.upload_results,
      priced_usage: event.run_id === null ? null : (report.priced?.get(event.run_id) ?? null),
    })),
    baseline:
      baseline === null
        ? null
        : {
            local_run_id: baseline.id,
            path: baseline.path,
            evaluation_name: baseline.run.file.evaluation_name,
          },
    verdict:
      verdict === null
        ? null
        : {
            newly_failing: verdict.newly_failing,
            newly_errored: verdict.newly_errored,
            changed: verdict.changed,
            not_comparable_reason: verdict.not_comparable_reason,
            payloads: verdict.payloads,
          },
    failure: report.failure,
    elapsed_ms: report.elapsedMs,
    ...(report.outcome === "interrupted" ? { signal: report.signal } : {}),
  };
}

/** Where the summary is printed from, which the paths and the commands it prints depend on. */
export interface SummaryContext {
  /** The CLI's environment, which says how to spell a command the summary prints. */
  env: NodeJS.ProcessEnv;
  /** The directory the CLI ran in, which the paths the summary prints are relative to. */
  cwd: string;
}

/** What the summary is fitted to. */
interface View extends SummaryContext {
  /** The terminal's columns, or undefined for a pipe or a file, which get every line whole. */
  width: number | undefined;
  bold: (text: string) => string;
}

/** How wide the label column of the saved files is: `Case file` and two spaces. */
const LABEL_WIDTH = 11;

/**
 * The summary on stdout, results first:
 * 1. each evaluation: its run id and status, its cases and their mean time, each score's mean and
 *    what it is a mean of, and the cases that raised;
 * 2. the regression check: the verdict, or that no baseline was given;
 * 3. what the run took: how long it ran, and each evaluation's LLM use (see {@link usageLines});
 * 4. what was saved: each run's run file and case file, and where an uploaded run went;
 * 5. what to do next: the command that compares the next run with this one, and the command that
 *    reads an uploaded run, with the cost TraceRoot priced the run at (see {@link pricedLines}).
 *
 * On a terminal it is fitted to the width: prose wraps at word boundaries with a hanging indent, a
 * table that doesn't fit is stacked, and a command, a link or a path is never broken, so each copies
 * whole (see render/wrap.ts).
 */
export function renderSummary(report: Report, writers: Writers, context: SummaryContext): void {
  const view: View = {
    ...context,
    width: terminalColumns(writers.out),
    bold: createStyler(writers.out).bold,
  };
  const blocks = [
    ...report.runs.map((saved) => evaluationLines(saved, report, view)),
    verdictLines(report, view),
    usageLines(report, view),
    savedLines(report, view),
    nextLines(report, view),
  ].filter((block) => block.length > 0);
  if (blocks.length === 0) {
    return;
  }
  writers.out.write(`${blocks.map((block) => block.join("\n")).join("\n\n")}\n`);
}

function evaluationLines(saved: SavedEvaluation, report: Report, view: View): string[] {
  const { event, run } = saved;
  const { counts } = event;
  const errors =
    counts.errored === 0
      ? ""
      : ` (${counts.task_errors} ${plural(counts.task_errors, "task error")}, ${counts.scorer_errors} ${plural(counts.scorer_errors, "scorer error")})`;
  const duration = run === null ? null : meanDuration(run.cases).mean;
  const lines = [
    ...wrapItems(
      [view.bold(clean(event.name)), clean(event.local_run_id), event.status.replaceAll("_", " ")],
      view.width,
    ),
    ...wrapItems(
      [
        `${counts.cases} ${plural(counts.cases, "case")}`,
        `${counts.errored} errored${errors}`,
        ...(duration === null ? [] : [`mean ${formatDuration(duration)} per case`]),
      ],
      view.width,
      { indent: "  " },
    ),
  ];
  if (run === null) {
    lines.push(...wrapLine("  the saved run can't be read, so its scores are unknown", view.width));
  } else {
    lines.push(
      ...scoreLines(run.cases, counts.cases, view),
      ...errorLines(run.cases, shownAsNewlyErrored(saved, report), view),
    );
  }
  return lines;
}

/**
 * Each score's mean, and what it is a mean of. `SCORED` says how many of the run's cases gave the
 * score a value the mean is over, so a mean of 1 over 2 of 3 cases doesn't read as every case
 * passing. `PASSED` and `FAILED` come from each value's `passed`, and are `—` for a score nothing
 * passes or fails, such as a number from a scorer with no threshold: its mean is a measurement in
 * the scorer's own units, not a share of cases that passed. A note under the table names a score
 * whose values the mean leaves out, or that is missing from a case without an error saying why.
 */
function scoreLines(cases: CaseLine[], caseCount: number, view: View): string[] {
  const means = scoreMeans(cases);
  if (means.length === 0) {
    return ["  no scores"];
  }
  const table = fitTable(
    ["SCORE", "MEAN", "SCORED", "PASSED", "FAILED"],
    means.map((score) => {
      const judged = score.passed + score.failed > 0;
      return [
        clean(score.name),
        formatMean(score.mean),
        `${scoredCases(cases, score.name)} of ${caseCount}`,
        judged ? String(score.passed) : "—",
        judged ? String(score.failed) : "—",
      ];
    }),
    { width: view.width, indent: "  ", headerStyle: view.bold },
  );
  return [
    ...table,
    ...wrapLines(
      means.flatMap((score) => scoreNotes(score, cases)),
      view.width,
    ),
  ];
}

/**
 * How many cases gave a score a value its mean is over, a finite number or a boolean. Each case
 * counts once: a case can give one score name twice, and `mean_count` counts values.
 */
function scoredCases(cases: CaseLine[], name: string): number {
  return cases.filter((item) =>
    item.scores.some(
      ({ scorer_name, value }) =>
        scorer_name === name &&
        (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))),
    ),
  ).length;
}

function scoreNotes(score: ScoreMean, cases: CaseLine[]): string[] {
  const name = clean(score.name);
  const notes: string[] = [];
  const left = score.count - score.mean_count;
  if (score.mean_count === 0) {
    notes.push(`  ${name}: no value is a number or true/false, so it has no mean.`);
  } else if (left > 0) {
    notes.push(
      `  ${name}: ${left} ${plural(left, "value")} ${left === 1 ? "isn't" : "aren't"} a number or true/false, so the mean leaves ${left === 1 ? "it" : "them"} out.`,
    );
  }
  if (score.unjudged > 0 && score.passed + score.failed > 0) {
    notes.push(
      `  ${name}: ${score.unjudged} ${plural(score.unjudged, "value")} neither ${score.unjudged === 1 ? "passes nor fails" : "pass nor fail"}.`,
    );
  }
  // A case whose task raised has no scores, and one whose scorer raised has none from it; the
  // errors below say why. A score missing from a case that raised nothing is named here.
  const unexplained = cases.filter(
    (item) =>
      item.task_error === null &&
      item.scorer_errors.length === 0 &&
      !item.scores.some((value) => value.scorer_name === score.name),
  ).length;
  if (unexplained > 0) {
    notes.push(
      `  ${name}: missing from ${unexplained} ${plural(unexplained, "case")} that raised no error.`,
    );
  }
  return notes;
}

/**
 * The run's errored cases, each with what raised, so a run with errors says which cases and why
 * without a baseline. A case that the verdict lists as newly errored is left to that list, and
 * after {@link LISTED_ERRORS} cases the rest are counted and left to the case file.
 */
function errorLines(cases: CaseLine[], newlyErrored: ReadonlySet<string>, view: View): string[] {
  const errored = cases.filter(
    (item) =>
      (item.task_error !== null || item.scorer_errors.length > 0) &&
      !newlyErrored.has(item.case_id),
  );
  if (errored.length === 0) {
    return [];
  }
  const listed = errored.slice(0, LISTED_ERRORS);
  const more = errored.length - listed.length;
  return [
    `  ${view.bold("Errors")}`,
    ...erroredTable(listed, view, "    "),
    ...(more === 0
      ? []
      : wrapLine(
          `    and ${more} more ${plural(more, "case")}; the case file has each one's error.`,
          view.width,
        )),
  ];
}

/** The cases the verdict lists as newly errored when it compared this evaluation's run. */
function shownAsNewlyErrored(saved: SavedEvaluation, report: Report): ReadonlySet<string> {
  const { baseline, verdict } = report;
  if (
    baseline === null ||
    verdict === null ||
    baseline.run.file.evaluation_name !== saved.event.name
  ) {
    return new Set();
  }
  return new Set(verdict.newly_errored.map((item) => item.case_id));
}

/** A path as the CLI prints it: relative to where the CLI ran, when it is under there. */
export function displayPath(path: string, cwd: string): string {
  const under = relative(cwd, path);
  return under !== "" && !under.startsWith("..") && !isAbsolute(under) ? under : path;
}

/**
 * The regression check, under its own label so it reads apart from the results: what comparing the
 * run with its baseline found, or why nothing was compared.
 */
function verdictLines(report: Report, view: View): string[] {
  const { baseline, verdict } = report;
  const prose = (text: string): string[] => wrapLine(text, view.width);
  const check = view.bold("Regression check:");
  if (report.outcome === "interrupted") {
    const what =
      report.signal === null ? "The runner was interrupted" : `Interrupted by ${report.signal}`;
    const saved = report.runs.length === 0 ? "; the runner saved no run" : "";
    const compared = baseline === null ? "" : ", so nothing was compared";
    return prose(`${what}${saved}${compared}.`);
  }
  if (baseline === null) {
    return prose(`${check} skipped, because no baseline was given.`);
  }
  if (verdict === null) {
    return [];
  }
  const against = `baseline ${clean(baseline.id)}`;
  if (verdict.outcome === "not_comparable") {
    return prose(
      `${check} not run, because the run can't be compared with ${against}: ${clean(verdict.not_comparable_reason ?? "")}.`,
    );
  }
  const lines: string[] = [];
  if (verdict.outcome === "ok") {
    lines.push(
      ...prose(`${check} passed against ${against}. Nothing newly fails or newly errors.`),
    );
  } else {
    const failing = verdict.newly_failing.length;
    const errored = verdict.newly_errored.length;
    const what: string[] = [];
    const tables: string[] = [];
    if (failing > 0) {
      what.push(
        `${failing} ${plural(failing, "case and scorer pair")} newly ${failing === 1 ? "fails" : "fail"}`,
      );
      tables.push("", view.bold("Newly failing"), ...failingTable(verdict.newly_failing, view));
    }
    if (errored > 0) {
      what.push(
        `${errored} ${plural(errored, "case")} newly ${errored === 1 ? "errors" : "error"}`,
      );
      tables.push("", view.bold("Newly errored"), ...erroredTable(verdict.newly_errored, view));
    }
    const found = what.join(", and ");
    lines.push(
      ...prose(
        `${check} failed against ${against}. ${found.charAt(0).toUpperCase()}${found.slice(1)}.`,
      ),
      ...tables,
    );
  }
  const rescored = failingUnderNewVersion(verdict.changed);
  if (rescored.length > 0) {
    const count = rescored.length;
    lines.push(
      "",
      ...prose(
        `${count} ${plural(count, "case and scorer pair")} that passed there ${count === 1 ? "doesn't" : "don't"} pass under a new scorer version, which isn't a regression:`,
      ),
      ...failingTable(rescored, view),
    );
  }
  const changed = verdict.changed.length;
  if (changed > 0) {
    lines.push(
      "",
      ...prose(
        `${changed} ${plural(changed, "score")} changed without regressing; --json lists ${changed === 1 ? "it" : "them"}.`,
      ),
    );
  }
  if (verdict.payloads === "truncated") {
    lines.push(
      "",
      ...prose(
        "A run stores truncated payloads, so each case's input and expected were matched as stored.",
      ),
    );
  }
  return lines;
}

/**
 * Where each run was saved, its run file and case file relative to where the CLI ran, and for an
 * uploaded run, its TraceRoot run id and the link TraceRoot gave it. The link is the one the run
 * file saved, as TraceRoot gave it to the runner; the CLI never builds one from an id and a host.
 * Then the evaluations an upload left behind. A file of several evaluations names each one.
 */
function savedLines(report: Report, view: View): string[] {
  const { upload, runs, outcome, runner } = report;
  const many = runs.length > 1;
  const indent = many ? "  " : "";
  const lines: string[] = [];
  for (const { event, path, run } of runs) {
    if (many) {
      lines.push(view.bold(clean(event.name)));
    }
    lines.push(
      ...labelled("Run file", [clean(displayPath(path, view.cwd))], indent, view.width),
      ...labelled(
        "Case file",
        [clean(displayPath(casesPathOf(path), view.cwd))],
        indent,
        view.width,
      ),
    );
    if (upload !== null && event.run_id !== null) {
      const url = uploadedRunUrl(event, run);
      lines.push(
        ...labelled(
          "Uploaded",
          [`run ${clean(event.run_id)}`, ...(url === null ? [] : [clean(url)])],
          indent,
          view.width,
        ),
        ...wrapLines(
          missingResults(run).map((note) => `${indent}${note}`),
          view.width,
        ),
      );
    }
  }
  // An interrupted run's evaluations stopped short, which says why they have no TraceRoot run id.
  const missing = upload === null || outcome === "interrupted" ? [] : notUploaded(runs);
  if (missing.length > 0) {
    const names = missing.map(({ event }) => clean(JSON.stringify(event.name))).join(", ");
    const local =
      runner.language === "python"
        ? "`local=True` or `report_to=`"
        : "`local: true` or `transport`";
    lines.push(
      ...wrapLine(
        `Not uploaded: ${names} finished without a TraceRoot run id. An evaluation defined with ${local} runs without uploading.`,
        view.width,
      ),
    );
  }
  return lines;
}

/**
 * A label and its values, each value whole on its own line: beside the label when the first fits
 * there, with the rest under it, and otherwise each on a line under the label.
 */
function labelled(
  label: string,
  values: readonly string[],
  indent: string,
  width: number | undefined,
): string[] {
  const beside = `${indent}${label.padEnd(LABEL_WIDTH)}`;
  const fits = values.every(
    (value) => width === undefined || beside.length + displayWidth(value) <= width,
  );
  if (fits) {
    return values.map((value, i) => `${i === 0 ? beside : " ".repeat(beside.length)}${value}`);
  }
  return [`${indent}${label}`, ...values.map((value) => `${indent}  ${value}`)];
}

/**
 * What to run next, each command on a line of its own and spelled the way the CLI was started:
 * - without a baseline, the command that compares the next run with this one. A run that can't be
 *   a baseline, such as a sampled one, gets none. A file of several evaluations gets the command
 *   with a placeholder, because a baseline is one evaluation's run: the next run's evaluation of
 *   the same name is compared with it;
 * - for an uploaded run, the command that reads it. It names the project, which a read needs under
 *   a browser login; the key check said which project the run went to. It repeats the flags that
 *   gave the key or the host, so it reads from the same host with the same key.
 */
function nextLines(report: Report, view: View): string[] {
  const { env, cwd } = view;
  const prose = (text: string): string[] => wrapLine(text, view.width);
  const lines: string[] = [];
  const usable =
    report.baseline === null && report.outcome !== "interrupted"
      ? report.runs.filter(
          ({ run }) => run !== null && partialRunReason(run.file, "baseline") === null,
        )
      : [];
  const [only] = usable;
  if (only !== undefined) {
    const file = clean(shellWord(displayPath(report.file, cwd)));
    if (report.runs.length === 1) {
      const id = clean(shellWord(only.event.local_run_id));
      lines.push(
        ...prose("To compare the next run with this one:"),
        `  ${cliCommand(`evals run ${file} --baseline ${id}`, env)}`,
      );
    } else {
      lines.push(
        ...prose("To compare the next run with one of these, give its run id:"),
        `  ${cliCommand(`evals run ${file} --baseline <run id>`, env)}`,
      );
    }
  }
  const { upload } = report;
  const uploaded = upload === null ? [] : report.runs.filter(({ event }) => event.run_id !== null);
  if (upload !== null && uploaded.length > 0) {
    lines.push(
      ...prose(
        uploaded.length === 1
          ? "To read the uploaded run from the terminal:"
          : "To read the uploaded runs from the terminal:",
      ),
      ...uploaded.map(({ event }) => {
        const read = [
          `evals runs get ${clean(event.run_id ?? "")} --project ${clean(upload.projectId)}`,
          ...upload.readFlags.map(clean),
        ];
        return `  ${cliCommand(read.join(" "), env)}`;
      }),
      ...pricedLines(uploaded, report.priced, view),
    );
  }
  return lines;
}

/**
 * What TraceRoot priced the uploaded runs' LLM calls at, from the read made once the runner exited.
 * TraceRoot prices them from the runs' traces, which it processes after the runner ends, so a run it
 * hasn't finished pricing is said to be still pricing, never given the cost of the traces processed
 * so far. Without a read, as for an interrupted run, the summary says where the cost will show.
 */
function pricedLines(
  uploaded: SavedEvaluation[],
  priced: Map<string, PricedUsage | null> | null,
  view: View,
): string[] {
  const prose = (text: string): string[] => wrapLine(text, view.width);
  const one = uploaded.length === 1;
  if (priced === null) {
    return prose(
      one
        ? "Once TraceRoot has processed the run's traces, that command shows the cost it derives from them."
        : "Once TraceRoot has processed the runs' traces, those commands show the cost it derives from them.",
    );
  }
  // Each run's cost lines: a line of cost, then any notes, such as cases without a trace.
  const costs = uploaded.map(({ event }) => {
    const usage = priced.get(event.run_id ?? "") ?? null;
    return usage !== null && isPriced(usage) ? pricedCostLines(usage).map(clean) : null;
  });
  if (costs.every((cost) => cost === null)) {
    return prose(
      one
        ? "TraceRoot is still pricing the run's LLM calls; that command shows the cost once it has."
        : "TraceRoot is still pricing the runs' LLM calls; those commands show the cost once it has.",
    );
  }
  if (one) {
    const [cost = "", ...notes] = costs[0] ?? [];
    return [
      ...prose(`TraceRoot priced the run's LLM calls: ${cost}.`),
      ...wrapLines(notes, view.width),
    ];
  }
  return [
    ...prose("TraceRoot priced the runs' LLM calls:"),
    ...wrapLines(
      uploaded.flatMap(({ event }, i) => {
        const [cost = "still being priced", ...notes] = costs[i] ?? [];
        return [`  ${clean(event.name)}: ${cost}`, ...notes.map((note) => `    ${note}`)];
      }),
      view.width,
    ),
  ];
}

/** The link TraceRoot gave an uploaded run, or null for a run it never registered. */
function uploadedRunUrl(event: EvaluationCompletedEvent, run: SavedRun | null): string | null {
  return event.run_id === null ? null : (run?.file.dashboard_url ?? null);
}

function failingTable(pairs: NewlyFailingPair[], view: View): string[] {
  return fitTable(
    ["CASE", "SCORER", "RESULT"],
    pairs.map((pair) => [clean(pair.case_id), clean(pair.scorer_name), failingResult(pair)]),
    {
      width: view.width,
      indent: "  ",
      headerStyle: view.bold,
      wrapLast: true,
      labels: [false, true, false],
    },
  );
}

/**
 * The pairs that passed in the baseline run and don't pass under a new version of their scorer.
 * A new version is never a regression, so the verdict lists them only under `changed`, and the
 * summary names them so that "no regression" isn't read as "everything that passed still does".
 */
function failingUnderNewVersion(changed: ChangedPair[]): NewlyFailingPair[] {
  const pairs: NewlyFailingPair[] = [];
  for (const pair of changed) {
    if (
      pair.change === "scorer_version" &&
      pair.baseline.passed === true &&
      pair.current.passed !== true
    ) {
      pairs.push({
        case_id: pair.case_id,
        scorer_name: pair.scorer_name,
        reason: pair.current.passed === false ? "failed" : "unjudged",
        value: pair.current.value,
        error: null,
      });
    }
  }
  return pairs;
}

/** What became of a pair that passed in the baseline run. */
function failingResult(pair: NewlyFailingPair): string {
  switch (pair.reason) {
    case "failed":
      return `failed: ${compact(pair.value, VALUE_WIDTH)}`;
    case "unjudged":
      return `neither passes nor fails: ${compact(pair.value, VALUE_WIDTH)}`;
    case "scorer_error":
      return `scorer raised: ${compact(pair.error, ERROR_WIDTH)}`;
    case "task_error":
      return `task raised: ${compact(pair.error, ERROR_WIDTH)}`;
    case "missing":
      return "no score: the scorer didn't run on this case";
  }
}

/** A case that raised: what its task raised, and what each of its scorers did. */
type ErroredCase = Pick<CaseLine, "case_id" | "task_error" | "scorer_errors">;

function erroredTable(cases: ErroredCase[], view: View, indent = "  "): string[] {
  return fitTable(
    ["CASE", "ERROR"],
    cases.map((item) => {
      const errors = [
        ...(item.task_error === null ? [] : [`task: ${compact(item.task_error, ERROR_WIDTH)}`]),
        ...item.scorer_errors.map(
          (error) => `${clean(error.scorer_name)}: ${compact(error.message, ERROR_WIDTH)}`,
        ),
      ];
      return [clean(item.case_id), errors.join("; ")];
    }),
    { width: view.width, indent, headerStyle: view.bold, wrapLast: true, labels: [false, false] },
  );
}

/**
 * A duration as a person reads it: milliseconds under a second, seconds to three significant
 * digits under a minute, then minutes and seconds.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${formatMean(ms)} ms`;
  }
  if (ms < 59_950) {
    return `${(ms / 1000).toLocaleString("en-US", { maximumSignificantDigits: 3 })} s`;
  }
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What the run took: how long it ran in all, apart from the mean time a case took, then each
 * evaluation's LLM use. The task's calls and the scorers' are counted apart, so an LLM judge's
 * tokens are never read as the agent's. Each figure is only what the calls reported: a token count
 * no call reported prints `—`, a cost no call reported is unknown, and a note says when a figure
 * covers only some of the calls or cases. A run whose SDK records no usage says so.
 */
function usageLines(report: Report, view: View): string[] {
  const prose = (text: string): string[] => wrapLine(text, view.width);
  const lines: string[] = [];
  if (report.elapsedMs !== null) {
    lines.push(...prose(`The run took ${formatDuration(report.elapsedMs)} in all.`));
  }
  const usages = report.runs.flatMap(({ event, run }) =>
    run === null
      ? []
      : [{ name: event.name, usage: runUsage(run.cases.map((item) => item.usage)) }],
  );
  // Every evaluation of a file runs under the same SDK, so a run that records no usage, or
  // captured none, says so once rather than once per evaluation.
  const [first] = usages;
  if (first !== undefined && first.usage.status !== "reported") {
    if (usages.every(({ usage }) => usage.status === first.usage.status)) {
      return [...lines, ...evaluationUsage(first.usage, report.runner, view)];
    }
  }
  const many = usages.length > 1;
  for (const { name, usage } of usages) {
    const block = evaluationUsage(usage, report.runner, view);
    if (many) {
      lines.push(view.bold(clean(name)), ...block.map((line) => `  ${line}`));
    } else {
      lines.push(...block);
    }
  }
  return lines;
}

/** One evaluation's LLM use, as {@link usageLines} prints it. */
function evaluationUsage(usage: RunUsage, runner: EvalRunner, view: View): string[] {
  const prose = (text: string): string[] => wrapLine(text, view.width);
  const sdk = `${SDK_NAMES[runner.language]} ${clean(runner.sdkVersion)}`;
  if (usage.status === "not_recorded") {
    return prose(`LLM use: not recorded; ${sdk} doesn't count a run's LLM calls.`);
  }
  if (usage.status === "unreadable") {
    return prose(
      "LLM use: unknown, because the case file records it in a form this CLI can't read.",
    );
  }
  if (usage.status === "not_captured" || usage.task === null || usage.scorers === null) {
    const setup =
      runner.language === "python"
        ? "traceroot.initialize(integrations=[...])"
        : "initialize({ instrumentModules })";
    return prose(
      `LLM use: not captured, because the evaluation instrumented no LLM client. Call ${setup} with the evaluation's LLM clients to count their calls.`,
    );
  }
  const { task, scorers } = usage;
  if (task.llm_calls + scorers.llm_calls === 0) {
    return prose("LLM use: no call through an instrumented LLM client.");
  }
  const roles: [string, UsageBucket][] = [["TASK", task]];
  if (scorers.llm_calls > 0) {
    roles.push(["SCORERS", scorers]);
  }
  const rows: string[][] = [["calls", ...roles.map(([, bucket]) => String(bucket.llm_calls))]];
  for (const [field, label] of USAGE_ROWS) {
    const optional = !CORE_TOKEN_FIELDS.includes(field);
    if (optional && roles.every(([, bucket]) => bucket[field] === null)) {
      continue;
    }
    rows.push([label, ...roles.map(([, bucket]) => partial(bucket, field, tokens(bucket[field])))]);
  }
  rows.push(["cost", ...roles.map(([, bucket]) => partial(bucket, "cost", cost(bucket)))]);
  const notes: string[] = [];
  if (roles.some(([, bucket]) => SUM_FIELDS.some((field) => isPartial(bucket, field)))) {
    notes.push(
      "  A figure followed by (n of m calls) counts only the calls that reported it, so it's a lower bound.",
    );
  }
  for (const [role, bucket] of roles) {
    if (bucket.llm_calls > 0 && CORE_TOKEN_FIELDS.every((field) => bucket[field] === null)) {
      notes.push(`  No ${role === "TASK" ? "task" : "scorer"} call reported token counts.`);
    }
  }
  if (roles.some(([, bucket]) => bucket.llm_calls > 0 && bucket.cost === null)) {
    notes.push(
      "  A cost is unknown when no call reported one; TraceRoot prices an uploaded run's calls from its traces.",
    );
  }
  if (usage.cases_with_usage < usage.cases) {
    notes.push(`  These cover ${usage.cases_with_usage} of the run's ${usage.cases} cases.`);
  }
  return [
    ...fitTable(["LLM USE", ...roles.map(([role]) => role)], rows, {
      width: view.width,
      headerStyle: view.bold,
    }),
    ...wrapLines(notes, view.width),
  ];
}

/**
 * What an uploaded run's saved file says about results TraceRoot may not have: ones whose upload
 * failed, and ones a cancelled run kept before TraceRoot had acknowledged them. Either way the
 * uploaded run can show fewer cases than this one.
 */
function missingResults(run: SavedRun | null): string[] {
  const { failed, unconfirmed } = run?.file.upload_results ?? { failed: 0, unconfirmed: 0 };
  const notes: string[] = [];
  if (failed > 0) {
    notes.push(
      `  ${failed} ${plural(failed, "result")} didn't reach TraceRoot, so the uploaded run is missing ${failed === 1 ? "that case" : "those cases"}.`,
    );
  }
  if (unconfirmed > 0) {
    notes.push(
      `  TraceRoot hadn't confirmed ${unconfirmed} ${plural(unconfirmed, "result")} when the run stopped, so the uploaded run may be missing ${unconfirmed === 1 ? "that case" : "those cases"}.`,
    );
  }
  return notes;
}

/** The token rows that always print, as `—` when no call reported them. */
const CORE_TOKEN_FIELDS: readonly TokenField[] = ["input_tokens", "output_tokens", "total_tokens"];

/** Every sum a bucket carries, each with the count of calls it covers. */
const SUM_FIELDS: readonly SumField[] = [...TOKEN_FIELDS, "cost"];

/** The token rows, in order; the cache and reasoning rows print only when a call reported them. */
const USAGE_ROWS: ReadonlyArray<readonly [TokenField, string]> = [
  ["input_tokens", "input tokens"],
  ["output_tokens", "output tokens"],
  ["total_tokens", "total tokens"],
  ["cache_read_tokens", "cached input read"],
  ["cache_write_tokens", "cached input written"],
  ["reasoning_tokens", "reasoning tokens"],
];

/**
 * A sum's figure, followed by how many of the calls it covers when that's some but not all of
 * them: `1,200 (10 of 11 calls)`.
 */
function partial(bucket: UsageBucket, field: SumField, figure: string): string {
  return isPartial(bucket, field)
    ? `${figure} (${bucket[coverageOf(field)]} of ${bucket.llm_calls} calls)`
    : figure;
}

/** Whether a sum covers some of the bucket's calls, but not all of them. */
function isPartial(bucket: UsageBucket, field: SumField): boolean {
  const calls = bucket[coverageOf(field)];
  return calls > 0 && calls < bucket.llm_calls;
}

/** A token sum, or `—` when no call reported it. */
function tokens(value: number | null): string {
  return value === null ? "—" : formatMean(value);
}

/** A bucket's cost in its currency, or `unknown` when no call reported one. */
function cost(bucket: UsageBucket): string {
  if (bucket.cost === null) {
    return bucket.llm_calls === 0 ? "—" : "unknown";
  }
  const value = formatMean(bucket.cost);
  return bucket.currency === "USD"
    ? `$${value}`
    : `${value} ${clean(bucket.currency ?? "")}`.trim();
}
