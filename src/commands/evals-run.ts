/**
 * `traceroot evals run <file> [--baseline <run id or path>] [--upload]`: runs one evaluation file
 * on this machine through its SDK's own eval runner and, given a baseline run, says whether a case
 * newly fails or newly errors. With `--upload`, the runner also sends the run and its traces to
 * TraceRoot.
 *
 * The pieces live in src/eval: the lookup finds the runner, `runEvalRunner` runs it, without
 * credentials unless the run is uploaded, and reads its outcome, and `compareRuns` compares the run
 * it saved with the baseline. This module puts them in order and turns what they found into output
 * and an exit code:
 * 1. the file, before anything else;
 * 2. the baseline, read and checked before the runner starts, so a typo doesn't cost a full run;
 * 3. with `--upload`, the API key, checked with TraceRoot before the runner starts for the same
 *    reason;
 * 4. the lookup and the run;
 * 5. the comparison.
 *
 * Everything that comes from the run or the lookup is printed through `clean()`, so an escape
 * sequence in an evaluation name, a case id or a runner's message can't act on the terminal.
 */

import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import { type Whoami, createApiClient } from "../api/client.js";
import type { InterruptSignal, RunOutcome } from "../eval/events.js";
import { EVALS_RUN_EXIT_CODES, INTERRUPTED_EXIT_CODES } from "../eval/exit-codes.js";
import { type EvalRunner, findEvalRunner } from "../eval/lookup.js";
import type { CaseLine, EvaluationCompletedEvent } from "../eval/protocol.js";
import { type UploadTarget, runEvalRunner, runnerEnv } from "../eval/spawn.js";
import {
  type ChangedPair,
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
  reportError,
  writeJson,
} from "../output.js";
import { clean, compact, formatMean, plural } from "../registry/enhancers/eval-reads.js";
import { onceOption } from "../registry/flags.js";
import { createStyler } from "../render/style.js";
import { renderTable } from "../render/table.js";
import { cliCommand } from "../setup/invocation.js";
import { makeSecret } from "../setup/secret.js";
import type { StackLanguage } from "../setup/types.js";
import { DEFAULT_HOST } from "./constants.js";
import { apiKeyFromCommand, contextFromCommand } from "./shared.js";

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

/** The `kind` of `fatal` both runners report an evaluation that failed partway with. */
const HARNESS_ERROR = "harness_error";

/**
 * What both runners' message says when an uploaded run's cases aren't a `Dataset`, such as a plain
 * list: they report a run against a dataset TraceRoot has, and publish only a `Dataset` to it.
 */
const NO_SYNCED_DATASET = "no synced dataset";

export interface EvalsRunOptions {
  /** The evaluation file, as given. */
  file: string;
  /** `--baseline`: a run id, or the path of a run file. */
  baseline?: string;
  json: boolean;
  /** `--upload`: what the run is uploaded with. null keeps the run on this machine. */
  upload: UploadAccess | null;
  /** Where the runner runs, and so where it saves its run. Relative paths resolve against it. */
  cwd: string;
  /** The CLI's environment, which the runner's is built from. */
  env: NodeJS.ProcessEnv;
  writers: Writers;
}

/** What `--upload` resolved, before TraceRoot has seen the key. */
export interface UploadAccess {
  /** The project API key, or undefined when no source holds one. */
  apiKey: string | undefined;
  /** The TraceRoot host, resolved as every other command resolves it. */
  host: string;
  /** How long the key check may take. */
  timeoutMs: number;
}

/** An upload whose key TraceRoot accepted. */
interface Upload {
  target: UploadTarget;
  /** The project the key belongs to, which the command that opens an uploaded run names. */
  projectId: string;
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

/** A runner outcome that reports a failure. */
type FailedOutcome = Extract<RunOutcome, { outcome: "fatal" | "crashed" }>;

/** What stopped a runner that failed after some of the file's evaluations finished. */
interface Failure {
  /** The runner's `fatal` kind, or `crashed` for a runner that stopped without one. */
  kind: string;
  /**
   * The message of the error that reports the failure, as human mode's `error:` line says it but
   * without its escaping: the runner's kind and message, or what the crash was.
   */
  message: string;
}

/** What a run that the runner saved came to, for the summary and the `--json` document. */
interface Report {
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

/** What `evals run --help` adds after the flags: where the run goes, and the exit codes. */
const HELP = [
  "",
  "The runner gets no API key and runs with tracing off. The run is saved under",
  `${join(RUNS_DIR, "<run id>")}.json; evals runs reads runs recorded on TraceRoot.`,
  "",
  "Exit codes:",
  "  0    nothing newly fails or newly errors, or no baseline was given",
  "  2    invalid arguments, or a baseline the new run can't be compared with",
  "  4    the baseline run doesn't exist",
  `  ${EVALS_RUN_EXIT_CODES.harness}   harness: the evaluation couldn't run`,
  `  ${EVALS_RUN_EXIT_CODES.regressed}   regressed: a case newly fails or newly errors`,
  `  ${INTERRUPTED_EXIT_CODES.SIGINT}  Ctrl+C (${INTERRUPTED_EXIT_CODES.SIGTERM} for SIGTERM, ${INTERRUPTED_EXIT_CODES.SIGHUP} for SIGHUP)`,
  "",
  "A score from a new version of its scorer is never a regression; the summary",
  "names each one that passed in the baseline and doesn't now. When the runner",
  "fails after some evaluations finished, those are still compared and printed",
  `before the error, and a regression among them exits ${EVALS_RUN_EXIT_CODES.regressed}.`,
].join("\n");

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
    .option("--upload", "also upload the run and its traces to TraceRoot, with a project API key")
    .allowExcessArguments(false)
    .addHelpText("after", HELP)
    .action(
      async (file: string, opts: { baseline?: string; upload?: boolean }, command: Command) => {
        process.exitCode = await runEvalsRun({
          file,
          baseline: opts.baseline,
          json: command.optsWithGlobals().json === true,
          upload: opts.upload === true ? uploadAccess(command) : null,
          cwd: process.cwd(),
          env: process.env,
          writers: defaultWriters,
        });
      },
    );
}

/**
 * What `--upload` uploads with: the host every other command resolves, and the first project API
 * key, which a browser login doesn't hide here as it does from the other commands.
 */
function uploadAccess(command: Command): UploadAccess {
  const context = contextFromCommand(command);
  return {
    apiKey: apiKeyFromCommand(command).value,
    host: context.auth.hostUrl.value ?? DEFAULT_HOST,
    timeoutMs: context.timeoutMs,
  };
}

/**
 * Runs the command, prints what the run came to, and returns the exit code: 0, 18, 2 for runs that
 * can't be compared, 17 for a runner that failed after some evaluations finished or for an uploaded
 * run with an evaluation that wasn't uploaded, or the interrupting signal's status.
 *
 * The evaluations that finished before a runner failed are compared and printed as for a completed
 * run, and the failure is reported after them: in the `--json` document's `failure`, or as the
 * usual `error:` line on stderr. A regression among them exits 18, which outranks the failure's 17.
 *
 * When nothing ran, or no evaluation finished, it throws a {@link CliError} instead, which the
 * central handler reports on stderr: 2 for a bad file or baseline, 4 for a baseline that doesn't
 * exist, 3 or 5 when `--upload` has no key TraceRoot accepts or can't reach it, and 17 when the
 * runner couldn't be found or failed.
 */
export async function runEvalsRun(options: EvalsRunOptions): Promise<number> {
  const { cwd, env, writers } = options;
  const file = resolve(cwd, options.file);
  requireFile(file, options.file);
  const baseline = options.baseline === undefined ? null : readBaseline(options.baseline, cwd);
  const upload = options.upload === null ? null : await checkUpload(options.upload, env, writers);

  const runner = await findRunner(options.file, cwd, env);
  // Which interpreter a Python file runs under is the one thing a venv mix-up hides.
  const under = runner.language === "python" ? ` (${clean(runner.argv[0])})` : "";
  logProgress(
    `Running ${clean(options.file)} with ${SDK_NAMES[runner.language]} ${clean(runner.sdkVersion)}${under}`,
    writers,
  );
  const outcome = await runEvalRunner({
    argv: runner.argv,
    cwd,
    env,
    upload: upload?.target,
    output: writers.err,
    // A CLI that exits while the runner runs, as when a reader closes its output, cuts the run short.
    earlyExitCode: EVALS_RUN_EXIT_CODES.harness,
  });

  const report: Report = {
    outcome: "ok",
    file,
    runner,
    runs: [],
    baseline,
    upload,
    verdict: null,
    signal: null,
    failure: null,
  };
  let failed: CliError | null = null;
  switch (outcome.outcome) {
    case "fatal":
    case "crashed": {
      const { failure, error } = failureOf(outcome, options.file, runner.language, upload !== null);
      if (outcome.evaluations.length === 0) {
        throw error;
      }
      report.failure = failure;
      failed = error;
      compareFinished(report, outcome.evaluations, cwd);
      // A regression in what finished outranks the failure.
      report.outcome = report.outcome === "regressed" ? "regressed" : "failed";
      break;
    }
    case "no_evaluations":
      throw harness(noEvaluations(options.file, runner.language));
    case "interrupted":
      report.outcome = "interrupted";
      report.signal = outcome.signal;
      report.runs = outcome.evaluations.map((event) => readSaved(event, cwd));
      break;
    case "completed":
      compareFinished(report, outcome.evaluations, cwd);
      // A regression is the one finding that outranks an evaluation that wasn't uploaded.
      if (
        upload !== null &&
        report.outcome !== "regressed" &&
        notUploaded(report.runs).length > 0
      ) {
        report.outcome = "not_uploaded";
      }
      break;
  }

  print(report, options);
  if (failed !== null && !options.json) {
    reportError(failed, {}, writers);
  }
  switch (report.outcome) {
    case "interrupted":
      return INTERRUPTED_EXIT_CODES[report.signal ?? "SIGINT"];
    case "regressed":
      return EVALS_RUN_EXIT_CODES.regressed;
    case "failed":
    case "not_uploaded":
      return EVALS_RUN_EXIT_CODES.harness;
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
 * Checks `--upload`'s key with TraceRoot before the runner starts, through the request `traceroot
 * login --api-key` checks a key with. The runner reaches TraceRoot before its first case and stops
 * without saving anything when that fails, so a missing or rejected key, or a host that can't be
 * reached, would otherwise cost a whole run to find out.
 */
async function checkUpload(
  access: UploadAccess,
  env: NodeJS.ProcessEnv,
  writers: Writers,
): Promise<Upload> {
  if (access.apiKey === undefined) {
    const login = cliCommand("login --api-key <key>", env);
    throw new CliError(
      `\`--upload\` needs a project API key; a browser login can't upload eval runs. Run \`${login}\` or set \`TRACEROOT_API_KEY\`.`,
      ExitCode.auth,
    );
  }
  const client = createApiClient({
    host: access.host,
    auth: { kind: "api-key", key: access.apiKey },
    timeoutMs: access.timeoutMs,
  });
  let who: Whoami;
  try {
    who = await client.whoami();
  } catch (error) {
    throw keyCheckFailure(error, access.host);
  }
  logProgress(
    `Uploading to project ${clean(who.project_name ?? who.project_id)} at ${clean(access.host)}`,
    writers,
  );
  return {
    target: { host: access.host, apiKey: makeSecret(access.apiKey) },
    projectId: who.project_id,
  };
}

/** A failed key check, said as what it stopped. Anything other than a {@link CliError} is kept. */
function keyCheckFailure(error: unknown, host: string): unknown {
  if (!(error instanceof CliError)) {
    return error;
  }
  const what =
    error.exitCode === ExitCode.auth
      ? `TraceRoot at ${host} rejected the API key`
      : `couldn't check the API key with TraceRoot at ${host}`;
  return new CliError(
    `${clean(what)}, so the evaluation didn't run: ${clean(error.message)}`,
    error.exitCode,
  );
}

/**
 * Finds the runner for the file. The lookup's Python version probe gets a local run's
 * environment, so it has no API key, with or without `--upload`.
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

/**
 * What stopped a runner that failed, for the `--json` document, and the harness error that reports
 * it. Both carry the same message, whether or not some evaluations finished first: the error's is
 * escaped for the terminal, and the document's is kept as it is, like the rest of its text.
 */
function failureOf(
  outcome: FailedOutcome,
  file: string,
  language: StackLanguage,
  uploading: boolean,
): { failure: Failure; error: CliError } {
  const failure: Failure =
    outcome.outcome === "fatal"
      ? { kind: outcome.kind, message: fatalMessage(outcome, file, language, uploading) }
      : {
          kind: "crashed",
          message: `the eval runner exited with status ${outcome.exitStatus} before it reported the end of the run; its output is above`,
        };
  return { failure, error: harness(cleanLines(failure.message)) };
}

/**
 * What a `fatal` event exits 17 with: the runner's kind and message, and for an uploaded run's
 * `harness_error`, what to do about it. A run whose cases are a plain list can't be uploaded. Any
 * other failure of an uploaded run leaves no saved run behind, whether it happened before the
 * cases ran or after, as when TraceRoot fails to register or complete the run. The text is left
 * unescaped; {@link failureOf} escapes it for the terminal.
 */
function fatalMessage(
  fatal: Extract<RunOutcome, { outcome: "fatal" }>,
  file: string,
  language: StackLanguage,
  uploading: boolean,
): string {
  const failed = `the eval runner failed with ${fatal.kind}: ${fatal.message}`;
  if (!uploading || fatal.kind !== HARNESS_ERROR) {
    return failed;
  }
  if (fatal.message.includes(NO_SYNCED_DATASET)) {
    return notADataset(file, language);
  }
  return `${failed}\n\nThe runner saved no run on this machine either. To check the evaluation without uploading it, rerun without --upload.`;
}

/** Says why cases given as a plain list can't be uploaded, and how to give them as a Dataset. */
function notADataset(file: string, language: StackLanguage): string {
  const found = `${file} gives an evaluation its cases as a plain list, which can't be uploaded: TraceRoot records an uploaded run against a Dataset, which the runner publishes before the run if TraceRoot doesn't have it yet. No case ran.`;
  const example =
    language === "python"
      ? '`cases = Dataset("cases")`, then `cases.add(input, expected=...)` for each case'
      : '`const cases = new Dataset("cases")`, then `cases.add(input, { expected })` for each case';
  return `${found}\n\nDefine the cases as a Dataset, as in ${example}, or run without --upload.`;
}

/** Says where an evaluation has to be for the runner to find it, which differs by language. */
function noEvaluations(file: string, language: StackLanguage): string {
  const found = `${clean(file)} defines no evaluation the runner can find, so nothing ran.`;
  if (language === "python") {
    return `${found}\n\nDefine an Evaluation at module level, as in \`evaluation = Evaluation(...)\`, not inside a function or under \`if __name__ == "__main__":\`.`;
  }
  return `${found}\n\nExport an Evaluation at module level, as in \`export const evaluation = new Evaluation({ ... })\`, not inside a function.`;
}

/** The evaluations that finished without a TraceRoot run id. */
function notUploaded(runs: SavedEvaluation[]): SavedEvaluation[] {
  return runs.filter((saved) => saved.event.run_id === null);
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
 * Reads the runs the finished evaluations saved into the report and, given a baseline, compares it
 * with the new run of its evaluation. Set the report's `failure` first: it changes what the
 * comparison says when the baseline's evaluation didn't finish.
 */
function compareFinished(
  report: Report,
  evaluations: EvaluationCompletedEvent[],
  cwd: string,
): void {
  const runs = evaluations.map((event) => requireSaved(event, cwd));
  report.runs = runs;
  if (report.baseline !== null) {
    report.verdict = compareWithBaseline(report.baseline, runs, report.failure !== null);
    report.outcome = report.verdict.outcome;
  }
}

/**
 * Compares the baseline with the new run of the same evaluation. A file can define several
 * evaluations, and the runner runs them all, unless it `stopped` partway, after a failure.
 */
function compareWithBaseline(
  baseline: Baseline,
  runs: ReadEvaluation[],
  stopped: boolean,
): Verdict {
  const name = baseline.run.file.evaluation_name;
  const matches = runs.filter((saved) => saved.event.name === name);
  const [match] = matches;
  if (match !== undefined && matches.length === 1) {
    return compareRuns(baseline.run, match.run);
  }
  return {
    outcome: "not_comparable",
    newly_failing: [],
    newly_errored: [],
    changed: [],
    not_comparable_reason:
      matches.length === 0
        ? noNewRunReason(name, runs, stopped)
        : `the file ran ${matches.length} evaluations named ${JSON.stringify(name)}, so which one to compare with the baseline run is ambiguous`,
    payloads: baseline.run.file.artifact.payloads,
  };
}

/**
 * Why there is no new run of the baseline's evaluation: the file didn't run it, or the runner
 * stopped before it finished. Names the evaluations that did finish.
 */
function noNewRunReason(name: string, runs: ReadEvaluation[], stopped: boolean): string {
  const ran = runs.map((saved) => JSON.stringify(saved.event.name)).join(", ");
  if (stopped) {
    return `no evaluation named ${JSON.stringify(name)}, which the baseline run is of, finished before the eval runner stopped; it finished ${ran}`;
  }
  return `the file ran no evaluation named ${JSON.stringify(name)}, which the baseline run is of; it ran ${ran === "" ? "none" : ran}`;
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
    renderSummary(report, options.writers, options.env);
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
    project_id: report.upload?.projectId ?? null,
    runs: report.runs.map(({ event, path, run }) => ({
      evaluation_name: event.name,
      local_run_id: event.local_run_id,
      uploaded_run_id: event.run_id,
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
    failure: report.failure,
    ...(report.outcome === "interrupted" ? { signal: report.signal } : {}),
  };
}

/**
 * The summary on stdout: each evaluation with its run id and score means, the verdict, then where
 * an uploaded run went.
 *
 * @param env the CLI's environment, which says how to spell the command that opens an uploaded
 * run.
 */
function renderSummary(report: Report, writers: Writers, env: NodeJS.ProcessEnv): void {
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
 * Each uploaded evaluation's TraceRoot run id, with the command that opens it, then the
 * evaluations that weren't uploaded. The command is spelled the way the CLI was started, and names
 * the project, which a read needs under a browser login; the key check said which project the run
 * went to.
 */
function uploadLines({ upload, runs, outcome, runner }: Report, env: NodeJS.ProcessEnv): string[] {
  if (upload === null) {
    return [];
  }
  const lines: string[] = [];
  for (const { event } of runs) {
    if (event.run_id !== null) {
      const id = clean(event.run_id);
      lines.push(
        `Uploaded ${clean(JSON.stringify(event.name))} to TraceRoot as run ${id}. To open it:`,
        `  ${cliCommand(`evals runs get ${id} --project ${clean(upload.projectId)}`, env)}`,
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

/**
 * Text that may run over several lines, such as a runner's message, made safe to print. Each line
 * is cleaned on its own, so the line breaks stay and every other control character is escaped.
 */
function cleanLines(text: string): string {
  return text.split(/\r?\n/).map(clean).join("\n");
}
