/**
 * `traceroot evals run <file> [--baseline <run id or path>]`: runs one evaluation file on this
 * machine through its SDK's own eval runner and, given a baseline run, says whether a case that
 * passed there doesn't now.
 *
 * The pieces live in src/eval: the lookup finds the runner, `runEvalRunner` runs it without
 * credentials and reads its outcome, and `compareRuns` compares the run it saved with the baseline.
 * This module puts them in order and turns what they found into output and an exit code:
 * 1. the file, before anything else;
 * 2. the baseline, read and checked before the runner starts, so a typo doesn't cost a full run;
 * 3. the lookup and the run;
 * 4. the comparison.
 *
 * Everything that comes from the run or the lookup is printed through `clean()`, so an escape
 * sequence in an evaluation name, a case id or a runner's message can't act on the terminal.
 */

import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import type { InterruptSignal } from "../eval/events.js";
import { EVALS_RUN_EXIT_CODES, INTERRUPTED_EXIT_CODES } from "../eval/exit-codes.js";
import { type EvalRunner, findEvalRunner } from "../eval/lookup.js";
import type { CaseLine, EvaluationCompletedEvent } from "../eval/protocol.js";
import { runEvalRunner, runnerEnv } from "../eval/spawn.js";
import {
  type NewlyErroredCase,
  type NewlyFailingPair,
  type SavedRun,
  type Verdict,
  compareRuns,
  loadRun,
  partialRunReason,
} from "../eval/verdict.js";
import {
  CliError,
  ExitCode,
  type Writers,
  defaultWriters,
  logProgress,
  writeJson,
} from "../output.js";
import { clean, compact, formatMean, plural } from "../registry/enhancers/eval-reads.js";
import { onceOption } from "../registry/flags.js";
import { createStyler } from "../render/style.js";
import { renderTable } from "../render/table.js";
import type { StackLanguage } from "../setup/types.js";

/** Where the runners save their runs, under the directory they run in. */
const RUNS_DIR = join(".traceroot", "eval", "runs");

/** The package each language's runner comes from. */
const SDK_NAMES: Readonly<Record<StackLanguage, string>> = {
  python: "traceroot",
  typescript: "@traceroot-ai/traceroot",
  javascript: "@traceroot-ai/traceroot",
};

/** The version of the `--json` document. A change that breaks a reader of it bumps it. */
const SCHEMA_VERSION = 1;

/** How wide a score value or an error message may print in the summary. */
const VALUE_WIDTH = 60;
const ERROR_WIDTH = 100;

export interface EvalsRunOptions {
  /** The evaluation file, as given. */
  file: string;
  /** `--baseline`: a run id, or the path of a run file. */
  baseline?: string;
  json: boolean;
  /** Where the runner runs, and so where it saves its run. Relative paths resolve against it. */
  cwd: string;
  /** The CLI's environment, which the runner's is built from. */
  env: NodeJS.ProcessEnv;
  writers: Writers;
}

/** A baseline run, read and checked. */
interface Baseline {
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

/** An evaluation the runner ran, and the run it saved. */
interface SavedEvaluation {
  event: EvaluationCompletedEvent;
  path: string;
  /** null for a run that couldn't be read, which only an interrupted run is printed with. */
  run: SavedRun | null;
}

/** An evaluation whose saved run was read. */
type ReadEvaluation = SavedEvaluation & { run: SavedRun };

/** What a run that the runner saved came to, for the summary and the `--json` document. */
interface Report {
  outcome: Verdict["outcome"] | "interrupted";
  file: string;
  runner: EvalRunner;
  runs: SavedEvaluation[];
  baseline: Baseline | null;
  /** null without a baseline, and for an interrupted run, which is never compared. */
  verdict: Verdict | null;
  /** For an interrupted run: the signal the CLI received, or null when only the runner saw one. */
  signal: InterruptSignal | null;
}

export function registerEvalsRun(evals: Command): void {
  evals
    .command("run")
    .description(
      "Run an evaluation file on this machine and save the run; with --baseline, exit 18 if a case regressed",
    )
    .argument("<file>", "evaluation file: .py, .ts, .js or .mjs")
    .option(
      "--baseline <run>",
      "run id or run file to compare the new run with",
      onceOption("--baseline"),
    )
    .allowExcessArguments(false)
    .action(async (file: string, opts: { baseline?: string }, command: Command) => {
      process.exitCode = await runEvalsRun({
        file,
        baseline: opts.baseline,
        json: command.optsWithGlobals().json === true,
        cwd: process.cwd(),
        env: process.env,
        writers: defaultWriters,
      });
    });
}

/**
 * Runs the command, prints what the run came to, and returns the exit code: 0, 18, 2 for runs that
 * can't be compared, or the interrupting signal's status.
 *
 * When nothing ran, or the evaluation couldn't run, it throws a {@link CliError} instead, which the
 * central handler reports on stderr: 2 for a bad file or baseline, 4 for a baseline that doesn't
 * exist, and 17 when the runner couldn't be found or failed.
 */
export async function runEvalsRun(options: EvalsRunOptions): Promise<number> {
  const { cwd, env, writers } = options;
  const file = resolve(cwd, options.file);
  requireFile(file, options.file);
  const baseline = options.baseline === undefined ? null : readBaseline(options.baseline, cwd);

  const runner = await findRunner(options.file, cwd, env);
  // Which interpreter a Python file runs under is the one thing a venv mix-up hides.
  const under = runner.language === "python" ? ` (${clean(runner.argv[0])})` : "";
  logProgress(
    `Running ${clean(options.file)} with ${SDK_NAMES[runner.language]} ${clean(runner.sdkVersion)}${under}`,
    writers,
  );
  const outcome = await runEvalRunner({ argv: runner.argv, cwd, env, output: writers.err });

  const report: Report = {
    outcome: "ok",
    file,
    runner,
    runs: [],
    baseline,
    verdict: null,
    signal: null,
  };
  switch (outcome.outcome) {
    case "fatal":
      throw harness(
        `the eval runner failed with ${clean(outcome.kind)}: ${cleanLines(outcome.message)}`,
      );
    case "crashed":
      throw harness(
        `the eval runner exited with status ${outcome.exitStatus} before it reported the end of the run; its output is above`,
      );
    case "no_evaluations":
      throw harness(noEvaluations(options.file, runner.language));
    case "interrupted":
      report.outcome = "interrupted";
      report.signal = outcome.signal;
      report.runs = outcome.evaluations.map((event) => readSaved(event, cwd));
      print(report, options);
      return INTERRUPTED_EXIT_CODES[outcome.signal ?? "SIGINT"];
    case "completed": {
      const runs = outcome.evaluations.map((event) => requireSaved(event, cwd));
      report.runs = runs;
      if (baseline !== null) {
        report.verdict = compareWithBaseline(baseline, runs);
        report.outcome = report.verdict.outcome;
      }
      break;
    }
  }

  print(report, options);
  switch (report.outcome) {
    case "regressed":
      return EVALS_RUN_EXIT_CODES.regressed;
    case "not_comparable":
      return ExitCode.usage;
    default:
      return 0;
  }
}

/** Rejects an evaluation file that isn't there, before anything else runs. */
function requireFile(path: string, given: string): void {
  if (!existsSync(path)) {
    throw new CliError(`no evaluation file at ${clean(given)}`, ExitCode.usage);
  }
  if (statSync(path).isDirectory()) {
    throw new CliError(`${clean(given)} is a folder, not an evaluation file`, ExitCode.usage);
  }
}

/**
 * Reads the baseline run and checks that a run can be compared with it.
 *
 * A run id resolves to `.traceroot/eval/runs/<id>.json` under `cwd`, and anything else, or an id
 * with no run under it, is read as a path. A baseline that is there but can't be read, or that ran
 * only some of its cases, is a usage error with the reason.
 */
function readBaseline(ref: string, cwd: string): Baseline {
  if (ref.trim() === "") {
    throw new CliError("--baseline needs a run id or the path of a run file", ExitCode.usage);
  }
  const byId = isRunId(ref) ? join(cwd, RUNS_DIR, `${ref}.json`) : null;
  const byPath = resolve(cwd, ref);
  const path = [byId, byPath].find(
    (candidate): candidate is string => candidate !== null && existsSync(candidate),
  );
  if (path === undefined) {
    const looked =
      byId === null ? byPath : `${join(RUNS_DIR, `${ref}.json`)} or ${ref} under ${cwd}`;
    throw new CliError(
      `no baseline run ${clean(ref)}: nothing at ${clean(looked)}`,
      ExitCode.notFound,
    );
  }

  const load = loadRun(path);
  if (!load.ok) {
    const code = load.reason === "missing" ? ExitCode.notFound : ExitCode.usage;
    throw new CliError(`can't read the baseline run: ${clean(load.message)}`, code);
  }
  const partial = partialRunReason(load.run.file, "baseline");
  if (partial !== null) {
    throw new CliError(
      `${clean(ref)} can't be a baseline: ${clean(partial)}. Compare with a run of every case.`,
      ExitCode.usage,
    );
  }
  return { id: basename(path, ".json"), path, run: load.run };
}

/** A run id is a plain name: no folder in it, and not `.` or `..`. */
function isRunId(ref: string): boolean {
  return !/[/\\]/.test(ref) && ref !== "." && ref !== "..";
}

/**
 * Finds the runner for the file. The lookup's Python version probe gets the environment the
 * runner will, so it has no API key either.
 */
async function findRunner(file: string, cwd: string, env: NodeJS.ProcessEnv): Promise<EvalRunner> {
  const lookup = await findEvalRunner(file, { cwd, env: runnerEnv(env) });
  if (lookup.ok) {
    return lookup.runner;
  }
  const { kind, message, fix } = lookup.failure;
  // An extension no runner loads is a wrong argument; every other failure is the harness's.
  const code = kind === "unsupported_extension" ? ExitCode.usage : EVALS_RUN_EXIT_CODES.harness;
  throw new CliError(`${cleanLines(message)}\n\n${cleanLines(fix)}`, code);
}

function harness(message: string): CliError {
  return new CliError(message, EVALS_RUN_EXIT_CODES.harness);
}

/** Says where an evaluation has to be for the runner to find it, which differs by language. */
function noEvaluations(file: string, language: StackLanguage): string {
  const found = `${clean(file)} defines no evaluation the runner can find, so nothing ran.`;
  if (language === "python") {
    return `${found}\n\nDefine an Evaluation at module level, as in \`evaluation = Evaluation(...)\`, not inside a function or under \`if __name__ == "__main__":\`.`;
  }
  return `${found}\n\nExport an Evaluation at module level, as in \`export const evaluation = new Evaluation({ ... })\`, not inside a function.`;
}

function runPath(event: EvaluationCompletedEvent, cwd: string): string {
  return join(cwd, RUNS_DIR, `${event.local_run_id}.json`);
}

/** The run an evaluation saved, or null when it can't be read. */
function readSaved(event: EvaluationCompletedEvent, cwd: string): SavedEvaluation {
  const path = runPath(event, cwd);
  const load = loadRun(path);
  return { event, path, run: load.ok ? load.run : null };
}

/** The run an evaluation saved. A run the runner reported and didn't save is the harness's fault. */
function requireSaved(event: EvaluationCompletedEvent, cwd: string): ReadEvaluation {
  const path = runPath(event, cwd);
  const load = loadRun(path);
  if (!load.ok) {
    throw harness(
      `the eval runner reported run ${clean(event.local_run_id)} of ${clean(JSON.stringify(event.name))}, but ${clean(load.message)}`,
    );
  }
  return { event, path, run: load.run };
}

/**
 * Compares the baseline with the new run of the same evaluation. A file can define several
 * evaluations, and the runner runs them all.
 */
function compareWithBaseline(baseline: Baseline, runs: ReadEvaluation[]): Verdict {
  const name = baseline.run.file.evaluation_name;
  const matches = runs.filter((saved) => saved.event.name === name);
  const [match] = matches;
  if (match !== undefined && matches.length === 1) {
    return compareRuns(baseline.run, match.run);
  }
  const ran = runs.map((saved) => JSON.stringify(saved.event.name)).join(", ");
  return {
    outcome: "not_comparable",
    newly_failing: [],
    newly_errored: [],
    changed: [],
    not_comparable_reason:
      matches.length === 0
        ? `the file ran no evaluation named ${JSON.stringify(name)}, which the baseline run is of; it ran ${ran === "" ? "none" : ran}`
        : `the file ran ${matches.length} evaluations named ${JSON.stringify(name)}, so which one to compare with the baseline run is ambiguous`,
    payloads: baseline.run.file.artifact.payloads,
  };
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

function print(report: Report, options: EvalsRunOptions): void {
  if (options.json) {
    writeJson(toDocument(report), options.writers);
  } else {
    renderSummary(report, options.writers);
  }
}

/**
 * The `--json` document. Text from the run is kept as the runner wrote it: JSON escapes control
 * characters itself.
 */
function toDocument(report: Report): Record<string, unknown> {
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
    runs: report.runs.map(({ event, path, run }) => ({
      evaluation_name: event.name,
      local_run_id: event.local_run_id,
      status: event.status,
      path,
      counts: event.counts,
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
    ...(report.outcome === "interrupted" ? { signal: report.signal } : {}),
  };
}

/** The summary on stdout: each evaluation with its run id and score means, then the verdict. */
function renderSummary(report: Report, writers: Writers): void {
  const styler = createStyler(writers.out);
  const blocks = [
    ...report.runs.map((saved) => evaluationLines(saved, styler.bold)),
    verdictLines(report, styler.bold),
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
  const lines = [
    `${bold(clean(event.name))} · ${clean(event.local_run_id)} · ${event.status.replaceAll("_", " ")}`,
    `  ${counts.cases} ${plural(counts.cases, "case")} · ${counts.errored} errored${errors}`,
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
    lines.push(`No regression against ${against}: nothing that passed there fails now.`);
  } else {
    const failing = verdict.newly_failing.length;
    const errored = verdict.newly_errored.length;
    const what = [
      failing === 0
        ? null
        : `${failing} ${plural(failing, "case and scorer pair")} newly ${failing === 1 ? "fails" : "fail"}`,
      errored === 0
        ? null
        : `${errored} ${plural(errored, "case")} newly ${errored === 1 ? "errors" : "error"}`,
    ];
    lines.push(
      `Regressed against ${against}: ${what.filter((part) => part !== null).join(", and ")}.`,
    );
    if (failing > 0) {
      lines.push("", bold("Newly failing"), ...indent(failingTable(verdict.newly_failing, bold)));
    }
    if (errored > 0) {
      lines.push("", bold("Newly errored"), ...indent(erroredTable(verdict.newly_errored, bold)));
    }
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

function failingTable(pairs: NewlyFailingPair[], bold: (text: string) => string): string {
  return renderTable(
    ["CASE", "SCORER", "RESULT"],
    pairs.map((pair) => [clean(pair.case_id), clean(pair.scorer_name), failingResult(pair)]),
    { headerStyle: bold },
  );
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

/**
 * Text that may run over several lines, such as a runner's message, made safe to print. Each line
 * is cleaned on its own, so the line breaks stay and every other control character is escaped.
 */
function cleanLines(text: string): string {
  return text.split(/\r?\n/).map(clean).join("\n");
}
