/**
 * What an `evals run` came to, as the command prints it: the `--json` document, or the summary on
 * stdout. The summary prints everything that comes from the run through `clean()`, so an escape
 * sequence in an evaluation name, a case id or a runner's message can't act on the terminal.
 */

import type { Writers } from "../output.js";
import { clean, compact, formatMean, plural } from "../registry/enhancers/eval-reads.js";
import { createStyler } from "../render/style.js";
import { renderTable } from "../render/table.js";
import { cliCommand } from "../setup/invocation.js";
import type { StackLanguage } from "../setup/types.js";
import type { InterruptSignal } from "./events.js";
import type { EvalRunner } from "./lookup.js";
import type { CaseLine, EvaluationCompletedEvent } from "./protocol.js";
import type { UploadTarget } from "./spawn.js";
import type {
  ChangedPair,
  NewlyErroredCase,
  NewlyFailingPair,
  SavedRun,
  Verdict,
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

/** One score's mean over a run. */
export interface ScoreMean {
  name: string;
  /** null when no case gave the score a number or a boolean. */
  mean: number | null;
  /** How many cases produced the score. */
  count: number;
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
}

/** The evaluations that finished without a TraceRoot run id. */
export function notUploaded(runs: SavedEvaluation[]): SavedEvaluation[] {
  return runs.filter((saved) => saved.event.run_id === null);
}

/**
 * Each score's mean over a run's cases, computed the way both SDKs compute the means they report:
 * a number or a boolean counts toward the mean, a boolean as 1 or 0, and any other value only
 * toward how many cases produced the score. In the order the scores first appear.
 */
export function scoreMeans(cases: CaseLine[]): ScoreMean[] {
  const totals = new Map<string, { sum: number; numbers: number; count: number }>();
  for (const item of cases) {
    for (const score of item.scores) {
      const total = totals.get(score.scorer_name) ?? { sum: 0, numbers: 0, count: 0 };
      totals.set(score.scorer_name, total);
      total.count += 1;
      const value = typeof score.value === "boolean" ? Number(score.value) : score.value;
      if (typeof value === "number" && Number.isFinite(value)) {
        total.sum += value;
        total.numbers += 1;
      }
    }
  }
  return [...totals].map(([name, { sum, numbers, count }]) => ({
    name,
    mean: numbers === 0 ? null : sum / numbers,
    count,
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
    project_id: report.upload?.projectId ?? null,
    runs: report.runs.map(({ event, path, run }) => ({
      evaluation_name: event.name,
      local_run_id: event.local_run_id,
      uploaded_run_id: event.run_id,
      uploaded_run_url: uploadedRunUrl(event, run),
      status: event.status,
      path,
      counts: event.counts,
      duration_ms: run === null ? null : meanDuration(run.cases),
      scores: run === null ? null : scoreMeans(run.cases),
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
    ...(report.outcome === "interrupted" ? { signal: report.signal } : {}),
  };
}

/**
 * The summary on stdout: each evaluation with its run id, the mean time a case took and the score
 * means, the verdict, then where an uploaded run went.
 *
 * @param env the CLI's environment, which says how to spell the command that opens an uploaded
 * run.
 */
export function renderSummary(report: Report, writers: Writers, env: NodeJS.ProcessEnv): void {
  const styler = createStyler(writers.out);
  const blocks = [
    ...report.runs.map((saved) => evaluationLines(saved, styler.bold)),
    verdictLines(report, styler.bold),
    uploadLines(report, env),
  ].filter((block) => block.length > 0);
  if (blocks.length === 0) {
    return;
  }
  writers.out.write(`${blocks.map((block) => block.join("\n")).join("\n\n")}\n`);
}

function evaluationLines(
  { event, run }: SavedEvaluation,
  bold: (text: string) => string,
): string[] {
  const { counts } = event;
  const errors =
    counts.errored === 0
      ? ""
      : ` (${counts.task_errors} ${plural(counts.task_errors, "task error")}, ${counts.scorer_errors} ${plural(counts.scorer_errors, "scorer error")})`;
  const duration = run === null ? null : meanDuration(run.cases).mean;
  const timing = duration === null ? "" : ` · mean ${formatMean(duration)} ms per case`;
  const lines = [
    `${bold(clean(event.name))} · ${clean(event.local_run_id)} · ${event.status.replaceAll("_", " ")}`,
    `  ${counts.cases} ${plural(counts.cases, "case")} · ${counts.errored} errored${errors}${timing}`,
  ];
  if (run === null) {
    lines.push("  the saved run can't be read, so its scores are unknown");
    return lines;
  }
  const means = scoreMeans(run.cases);
  if (means.length === 0) {
    lines.push("  no scores");
    return lines;
  }
  const table = renderTable(
    ["SCORE", "MEAN", "CASES"],
    means.map((score) => [clean(score.name), formatMean(score.mean), String(score.count)]),
    { headerStyle: bold },
  );
  return [...lines, ...indent(table)];
}

function verdictLines(report: Report, bold: (text: string) => string): string[] {
  const { baseline, verdict } = report;
  if (report.outcome === "interrupted") {
    const what =
      report.signal === null ? "The runner was interrupted" : `Interrupted by ${report.signal}`;
    const saved = report.runs.length === 0 ? "; the runner saved no run" : "";
    const compared = baseline === null ? "" : ", so nothing was compared";
    return [`${what}${saved}${compared}.`];
  }
  if (baseline === null || verdict === null) {
    return [];
  }
  const against = `baseline ${clean(baseline.id)}`;
  if (verdict.outcome === "not_comparable") {
    return [`Not compared with ${against}: ${clean(verdict.not_comparable_reason ?? "")}.`];
  }
  const lines: string[] = [];
  if (verdict.outcome === "ok") {
    lines.push(`No regression against ${against}: nothing newly fails or newly errors.`);
  } else {
    const failing = verdict.newly_failing.length;
    const errored = verdict.newly_errored.length;
    const what: string[] = [];
    const tables: string[] = [];
    if (failing > 0) {
      what.push(
        `${failing} ${plural(failing, "case and scorer pair")} newly ${failing === 1 ? "fails" : "fail"}`,
      );
      tables.push("", bold("Newly failing"), ...indent(failingTable(verdict.newly_failing, bold)));
    }
    if (errored > 0) {
      what.push(
        `${errored} ${plural(errored, "case")} newly ${errored === 1 ? "errors" : "error"}`,
      );
      tables.push("", bold("Newly errored"), ...indent(erroredTable(verdict.newly_errored, bold)));
    }
    lines.push(`Regressed against ${against}: ${what.join(", and ")}.`, ...tables);
  }
  const rescored = failingUnderNewVersion(verdict.changed);
  if (rescored.length > 0) {
    const count = rescored.length;
    lines.push(
      "",
      `${count} ${plural(count, "case and scorer pair")} that passed there ${count === 1 ? "doesn't" : "don't"} pass under a new scorer version, which isn't a regression:`,
      ...indent(failingTable(rescored, bold)),
    );
  }
  const changed = verdict.changed.length;
  if (changed > 0) {
    lines.push(
      "",
      `${changed} ${plural(changed, "score")} changed without regressing; --json lists ${changed === 1 ? "it" : "them"}.`,
    );
  }
  if (verdict.payloads === "truncated") {
    lines.push(
      "",
      "A run stores truncated payloads, so each case's input and expected were matched as stored.",
    );
  }
  return lines;
}

/**
 * Each uploaded evaluation's TraceRoot run id, with its link and the command that opens it, then
 * the evaluations that weren't uploaded. The link is the one the run file saved, as TraceRoot gave
 * it to the runner; the CLI never builds one from an id and a host, so a run TraceRoot gave none
 * gets the command alone. The command is spelled the way the CLI was started, and names the project, which a
 * read needs under a browser login; the key check said which project the run went to. It repeats
 * the flags that gave the key or the host, so it reads from the same host with the same key.
 */
function uploadLines({ upload, runs, outcome, runner }: Report, env: NodeJS.ProcessEnv): string[] {
  if (upload === null) {
    return [];
  }
  const lines: string[] = [];
  for (const { event, run } of runs) {
    if (event.run_id !== null) {
      const id = clean(event.run_id);
      const url = uploadedRunUrl(event, run);
      const read = [
        `evals runs get ${id} --project ${clean(upload.projectId)}`,
        ...upload.readFlags.map(clean),
      ];
      lines.push(
        `Uploaded ${clean(JSON.stringify(event.name))} to TraceRoot as run ${id}. To open it:`,
        ...(url === null ? [] : [`  ${clean(url)}`]),
        `  ${cliCommand(read.join(" "), env)}`,
      );
    }
  }
  // An interrupted run's evaluations stopped short, which says why they have no TraceRoot run id.
  const missing = outcome === "interrupted" ? [] : notUploaded(runs);
  if (missing.length > 0) {
    const names = missing.map(({ event }) => clean(JSON.stringify(event.name))).join(", ");
    const local =
      runner.language === "python"
        ? "`local=True` or `report_to=`"
        : "`local: true` or `transport`";
    lines.push(
      ...(lines.length > 0 ? [""] : []),
      `Not uploaded: ${names} finished without a TraceRoot run id. An evaluation defined with ${local} runs without uploading.`,
    );
  }
  return lines;
}

/** The link TraceRoot gave an uploaded run, or null for a run it never registered. */
function uploadedRunUrl(event: EvaluationCompletedEvent, run: SavedRun | null): string | null {
  return event.run_id === null ? null : (run?.file.dashboard_url ?? null);
}

function failingTable(pairs: NewlyFailingPair[], bold: (text: string) => string): string {
  return renderTable(
    ["CASE", "SCORER", "RESULT"],
    pairs.map((pair) => [clean(pair.case_id), clean(pair.scorer_name), failingResult(pair)]),
    { headerStyle: bold },
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

function erroredTable(cases: NewlyErroredCase[], bold: (text: string) => string): string {
  return renderTable(
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
    { headerStyle: bold },
  );
}

function indent(block: string): string[] {
  return block.split("\n").map((line) => `  ${line}`);
}
