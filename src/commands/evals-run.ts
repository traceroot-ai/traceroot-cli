/**
 * `traceroot evals run <file> [--baseline <run id or path>] [--upload]`: runs one evaluation file
 * on this machine through its SDK's own eval runner and, given a baseline run, says whether a case
 * newly fails or newly errors. With `--upload`, the runner also sends the run and its traces to
 * TraceRoot.
 *
 * The pieces live in src/eval: the lookup finds the runner, `runEvalRunner` runs it, without
 * credentials unless the run is uploaded, and reads its outcome, `compareRuns` compares the run it
 * saved with the baseline, and the report prints what the run came to. This module puts them in
 * order, builds the report from what they found, and picks the exit code:
 * 1. the file, before anything else;
 * 2. the baseline, read and checked before the runner starts, so a typo doesn't cost a full run;
 * 3. with `--upload`, the API key, checked with TraceRoot before the runner starts for the same
 *    reason;
 * 4. the lookup and the run;
 * 5. the comparison.
 *
 * Everything that comes from the run or the lookup is printed through `clean()`, so an escape
 * sequence in an evaluation name, a case id or a runner's message can't act on the terminal.
 *
 * While the runner runs, a terminal gets a progress line at the bottom of stderr (see
 * {@link showsProgress}). Everything else gets exactly the runner's output, as it always has.
 */

import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import { type Whoami, createApiClient } from "../api/client.js";
import type { AuthSource, ResolvedField } from "../config/resolve.js";
import type { RunOutcome } from "../eval/events.js";
import { EVALS_RUN_EXIT_CODES, INTERRUPTED_EXIT_CODES } from "../eval/exit-codes.js";
import { type EvalRunner, findEvalRunner } from "../eval/lookup.js";
import { countsCasesItRuns } from "../eval/progress.js";
import type { EvaluationCompletedEvent } from "../eval/protocol.js";
import {
  type Baseline,
  type Failure,
  type Report,
  SDK_NAMES,
  type SavedEvaluation,
  type Upload,
  notUploaded,
  renderSummary,
  toDocument,
} from "../eval/report.js";
import { runEvalRunner, runnerEnv } from "../eval/spawn.js";
import {
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
import { clean } from "../registry/enhancers/eval-reads.js";
import { onceOption } from "../registry/flags.js";
import { cliCommand, shellWord } from "../setup/invocation.js";
import { makeSecret } from "../setup/secret.js";
import { canRedraw } from "../setup/tty.js";
import type { StackLanguage } from "../setup/types.js";
import { DEFAULT_HOST } from "./constants.js";
import { apiKeyFromCommand, contextFromCommand } from "./shared.js";

/** Where the runners save their runs, under the directory they run in. */
const RUNS_DIR = join(".traceroot", "eval", "runs");

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
  /**
   * The flags that gave the key or the host, which the command that opens an uploaded run repeats
   * (see {@link readFlags}).
   */
  readFlags: string[];
}

/** An evaluation whose saved run was read. */
type ReadEvaluation = SavedEvaluation & { run: SavedRun };

/** A runner outcome that reports a failure. */
type FailedOutcome = Extract<RunOutcome, { outcome: "fatal" | "crashed" }>;

/** What `evals run --help` adds after the flags: where the run goes, and the exit codes. */
const HELP = [
  "",
  "Without --upload, the runner gets no API key and runs with tracing off. Either",
  `way the run is saved under ${join(RUNS_DIR, "<run id>")}.json; evals runs reads`,
  "runs recorded on TraceRoot.",
  "",
  "--upload also sends the run and its traces to TraceRoot. That takes a project",
  "API key, from --api-key, --env-file, TRACEROOT_API_KEY, the config file",
  "traceroot login --api-key writes, or ./.env: a browser login can't upload. The",
  "evaluation's cases have to be a Dataset, which the runner publishes first if",
  "TraceRoot doesn't have it. --baseline still compares the runs saved here.",
  "",
  "Exit codes:",
  "  0    nothing newly fails or newly errors, or no baseline was given",
  "  2    invalid arguments, or a baseline the new run can't be compared with",
  "  3    --upload: no project API key, or TraceRoot rejected it",
  "  4    the baseline run doesn't exist",
  "  5    --upload: TraceRoot can't be reached",
  `  ${EVALS_RUN_EXIT_CODES.harness}   harness: the evaluation couldn't run, or with --upload, wasn't uploaded`,
  `  ${EVALS_RUN_EXIT_CODES.regressed}   regressed: a case newly fails or newly errors`,
  `  ${INTERRUPTED_EXIT_CODES.SIGINT}  Ctrl+C (${INTERRUPTED_EXIT_CODES.SIGTERM} for SIGTERM, ${INTERRUPTED_EXIT_CODES.SIGHUP} for SIGHUP)`,
  "",
  "With --upload, a key check that fails another way exits with the shared code",
  "for its HTTP status, such as 4 for a 404 or 1 for a server error. Nothing runs",
  "either way.",
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
  const key = apiKeyFromCommand(command);
  const host = context.auth.hostUrl;
  return {
    apiKey: key.value,
    host: host.value ?? DEFAULT_HOST,
    timeoutMs: context.timeoutMs,
    readFlags: readFlags(key.source, host, command.optsWithGlobals().envFile as string | undefined),
  };
}

/**
 * The flags a later command needs to read an uploaded run from the same host with the same key.
 * Only a flag holds for this command alone, so only the flags that gave the key or the host are
 * repeated: `--host` and `--env-file` as given, and `--api-key <key>` for a key given with
 * `--api-key`, which is never printed. A key or host from the environment, the config file or
 * `./.env` reaches the later command the same way.
 */
function readFlags(key: AuthSource, host: ResolvedField, envFile: string | undefined): string[] {
  const flags: string[] = [];
  if (host.source === "flag" && host.value !== undefined) {
    flags.push(`--host ${shellWord(host.value)}`);
  }
  if ((key === "env-file" || host.source === "env-file") && envFile !== undefined) {
    flags.push(`--env-file ${shellWord(envFile)}`);
  }
  if (key === "flag") {
    flags.push("--api-key <key>");
  }
  return flags;
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
    progress: showsProgress(options)
      ? { exactCount: countsCasesItRuns(runner.language) }
      : undefined,
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

/**
 * Whether the run shows a progress line: only on a stderr that is a terminal that can redraw, so
 * not under a non-empty `NO_COLOR` or `TERM=dumb`, and not in CI, where a terminal is read as a
 * log afterwards. Under `--json` stderr can still be a terminal, but whatever reads that output
 * reads it as text, so it gets none either.
 */
function showsProgress(options: EvalsRunOptions): boolean {
  const { CI } = options.env;
  const inCi = CI !== undefined && CI !== "" && CI !== "false";
  return !options.json && !inCi && canRedraw(options.writers.err, options.env);
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
    readFlags: access.readFlags,
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
 * it. Both carry the same message: the error's is escaped for the terminal, and the document's is
 * kept as it is, like the rest of its text. The message is the same whether or not some
 * evaluations finished first, except for an uploaded run's `harness_error`, whose message names
 * them (see {@link fatalMessage}).
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
          message: crashMessage(outcome.exitStatus),
        };
  return { failure, error: harness(cleanLines(failure.message)) };
}

/**
 * What a `fatal` event exits 17 with: the runner's kind and message, and for an uploaded run's
 * `harness_error`, what to do about it. An evaluation whose cases are a plain list can't be
 * uploaded. Any other failure of an uploaded evaluation leaves no saved run of it behind, whether
 * it happened before its cases ran or after, as when TraceRoot fails to register or complete the
 * run. The evaluations that finished before it keep the runs the runner saved and uploaded, and the
 * message names each one. The text is left unescaped; {@link failureOf} escapes it for the
 * terminal.
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
  const finished = fatal.evaluations.map(finishedBefore);
  if (fatal.message.includes(NO_SYNCED_DATASET)) {
    return notADataset(file, language, finished);
  }
  if (finished.length === 0) {
    return `${failed}\n\nThe runner saved no run on this machine either. To check the evaluation without uploading it, rerun without --upload.`;
  }
  return `${failed}\n\nThe evaluation that failed saved no run on this machine either. ${finished.join(" ")} To check the evaluation that failed without uploading it, rerun without --upload.`;
}

/**
 * Says what became of an evaluation that finished before an uploaded run failed: the runner saved
 * its run on this machine, and uploaded it unless it finished without a TraceRoot run id.
 */
function finishedBefore(event: EvaluationCompletedEvent): string {
  const saved = `${JSON.stringify(event.name)} finished before it, and was saved on this machine as ${event.local_run_id}`;
  if (event.run_id === null) {
    return `${saved} but not uploaded.`;
  }
  return `${saved} and uploaded to TraceRoot as ${event.run_id}.`;
}

/**
 * Says why cases given as a plain list can't be uploaded, and how to give them as a Dataset.
 *
 * @param finished what became of each evaluation that finished before this one, from
 * {@link finishedBefore}.
 */
function notADataset(file: string, language: StackLanguage, finished: string[]): string {
  const ran =
    finished.length === 0
      ? "No case ran."
      : `None of that evaluation's cases ran. ${finished.join(" ")}`;
  const found = `${file} gives an evaluation its cases as a plain list, which can't be uploaded: TraceRoot records an uploaded run against a Dataset, which the runner publishes before the run if TraceRoot doesn't have it yet. ${ran}`;
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

/**
 * What a runner that crashed did. Exiting 0 is a crash only when the runner stopped before it
 * reported the end of the run; a non-zero status is one whether or not it got that far.
 */
function crashMessage(status: number): string {
  const early = status === 0 ? " before it reported the end of the run" : "";
  return `the eval runner exited with status ${status}${early}; its output is above`;
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

function print(report: Report, options: EvalsRunOptions): void {
  if (options.json) {
    writeJson(toDocument(report), options.writers);
  } else {
    renderSummary(report, options.writers, { env: options.env, cwd: options.cwd });
  }
}

/**
 * Text that may run over several lines, such as a runner's message, made safe to print. Each line
 * is cleaned on its own, so the line breaks stay and every other control character is escaped.
 */
function cleanLines(text: string): string {
  return text.split(/\r?\n/).map(clean).join("\n");
}
