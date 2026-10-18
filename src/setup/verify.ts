import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { removeEnvContent } from "./envWrite.js";
import { type RunProcess, splitCommand } from "./exec.js";
import { withVenvOnPath } from "./python.js";
import type { Secret } from "./secret.js";
import type { ApplicationVerification, VerificationRun } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The one variable the credential-free run does without.
 *
 * Named here because it is now taken out of a file as well as out of the child
 * environment, and the two have to be the same variable. `TRACEROOT_HOST_URL`
 * is deliberately not in this list: the environment sets it for both runs so
 * that they differ by the credential and nothing else.
 */
const KEY_ENV = "TRACEROOT_API_KEY";

/**
 * Where the credential file is kept while the application runs without it.
 *
 * A sibling path, so the move is a rename within one directory and cannot fail
 * across filesystems, and a name obvious enough that someone who finds one left
 * behind by a killed process knows what it is and where it belongs.
 */
const PARKED_SUFFIX = ".traceroot-setup-hidden";

export interface VerifyApplicationInput {
  /** The project's own check, as detected. Null when it has none. */
  command: string | null;
  /**
   * The same command's result from before anything was instrumented, or null
   * when no baseline was taken.
   *
   * A suite that was already red, or that needs a database or a network this
   * machine does not have, fails here too — and used to be reported as broken
   * by the instrumentation. With a baseline the two are distinguishable, and a
   * failure that predates setup is reported as inconclusive rather than blamed
   * on work that was done correctly.
   *
   * Null is not "it passed". It is "nobody looked", which is a weaker statement
   * than either answer a baseline gives, and it is reported as such: a failing
   * check with no baseline is inconclusive, never failed.
   */
  baseline?: VerificationRun | null;
  cwd: string;
  parentEnv: NodeJS.ProcessEnv;
  /**
   * The virtualenv interpreter the service runs on, or null when there is none.
   *
   * The check below spawns the project's own command, and `detect_stack` names
   * that command the way the project documents it — `pytest`, not
   * `.venv/bin/pytest` — because that is what a user types. It resolves for
   * them because their shell has the virtualenv activated; this process's
   * environment does not have it, so without this the spawn fails with ENOENT
   * on the commonest shape of Python project there is, after the application
   * has already been instrumented correctly.
   *
   * Required rather than optional, and for a reason this field has already
   * earned: an optional one that defaults to null type-checks when the caller
   * simply omits it, which is exactly how the baseline came to be the only run
   * that had the virtualenv. Required, omitting it is a compile error at the
   * call site rather than an ENOENT in front of a user.
   */
  interpreter: string | null;
  /**
   * The application's key. Never handed to the check: it is here so the
   * check's captured output is redacted, should the application print a key it
   * found somewhere setup did not take it out of.
   */
  credential: Secret;
  /**
   * Absolute paths to every file the application could read this credential
   * out of: the dotenv file this run wrote it into, and the project's own file
   * when the key resolved from one that was already there. Empty when there is
   * no such file — a key exported in the user's shell reaches the application
   * only through the environment, which the check builds for itself.
   *
   * Required rather than optional, and a list rather than one path, because
   * either omission silently empties the credential-free run of its meaning:
   * the instrumented entry point loads these files itself, so an environment
   * with `TRACEROOT_API_KEY` removed and any one of them still on disk is a run
   * *with* the key. The run that writes nothing because the key is already in
   * the project's `.env` is exactly that case, and it is the common one —
   * nothing was written, so a single "the file this run wrote" is null and the
   * file the application actually reads stays on disk.
   */
  credentialFiles: readonly string[];
  runProcess: RunProcess;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The verification plus, when it failed, the captured output of the run that
 * failed. The output is returned separately rather than folded into
 * {@link ApplicationVerification} on purpose: the verification is checkpointed,
 * and a checkpoint must not accumulate arbitrary process output.
 */
export interface VerifyApplicationResult {
  verification: ApplicationVerification;
  failure: { output: string } | null;
  /**
   * Files the credential was taken out of for the credential-free run, so what
   * "without the credential" meant is a fact the caller can report rather than
   * a promise. Empty when there was no such file.
   */
  withheld: readonly string[];
}

const NOT_RUN: VerificationRun = { ran: false, exitCode: null, durationMs: 0 };

/** The untouched copy of a credential file, and where it came from. */
interface Parked {
  original: string;
  parked: string;
}

/**
 * Takes the credential out of a file for the duration of one run, or returns
 * null when the file is not there.
 *
 * The credential's file is the project's own `.env` — setup writes the key into
 * a file the application already loads, which is the whole reason the key is
 * reachable at all. So that file holds the project's other variables too, and
 * moving the whole file aside, which is what this used to do, ran the
 * credential-free check against an application missing its database URL and
 * everything else it is configured with. The check then failed for reasons that
 * have nothing to do with TraceRoot, and the run stopped and told the user
 * their instrumentation had broken their application. Withholding the
 * credential has to mean the credential.
 *
 * The rename stays, as the copy that comes back. It is no longer the mechanism
 * but it is the crash path: from the moment it happens until the run ends, the
 * file's original bytes sit under a name nothing else writes, so a process
 * killed in between leaves them recoverable — and the restore is a rename of
 * bytes this function never parsed rather than a rewrite of what it understood.
 * Rewriting a user's `.env` in place with no copy anywhere is the one way to
 * actually lose it.
 *
 * Throws rather than carrying on: a credential-free run that cannot be made
 * credential-free proves nothing, and reporting "your application works without
 * TraceRoot" on the strength of a failed `rename` is the exact dishonesty this
 * function exists to remove.
 */
function park(file: string): Parked | null {
  if (!existsSync(file)) {
    return null;
  }
  const parked = `${file}${PARKED_SUFFIX}`;
  // `rename` replaces an existing target on POSIX without a word, and what
  // would be replaced here is a credential file some earlier run parked and
  // never got to put back — the run killed outright, which is the case the name
  // above exists for. That run's copy is the user's only copy: the file at
  // `file` is the one this run wrote in its place. Refusing leaves both on disk
  // for the user to settle, which is the one outcome that cannot lose a file.
  if (existsSync(parked)) {
    throw new Error(
      `${parked} is already there, and moving ${file} aside would overwrite it. It is a copy of ${file} left behind by a run that was interrupted while the application ran without its credential. Put it back or delete it, then run setup again.`,
    );
  }
  // Read, and stat, before anything moves: the copy written below comes from the
  // bytes this call was handed rather than from a path it has to go and find
  // again, and a failure in either of these leaves the file exactly where it is.
  const original = readFileSync(file, "utf8");
  const mode = statSync(file).mode & 0o777;
  try {
    renameSync(file, parked);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not move ${file} aside to run the application without its credential: ${reason}`,
    );
  }
  const { content, removed } = removeEnvContent(original, [KEY_ENV]);
  if (removed.length === 0) {
    // Nothing in this file can hand the key back, so the credential-free run
    // does not need it touched — and rewriting a user's env file to take out a
    // line it does not have is risk for nothing. The caller already asks which
    // files hold the credential; this is the same question asked of the bytes.
    unpark({ original: file, parked });
    return null;
  }
  try {
    // `wx` never follows a symlink and never writes over an existing file. The
    // rename above just emptied this path, so anything at it now appeared in
    // between and must not be written through.
    //
    // The original's own mode, because the file at this path has to look to the
    // project exactly like its own file minus one line, permissions included. A
    // check that reads the repository as another uid — a container, a process
    // started under a different account — can read a 0644 env file and cannot
    // read a 0600 one, so standing in a tighter copy would fail the
    // credential-free run for a reason this step introduced, which is the
    // defect this function exists to stop causing. Tightening it would protect
    // nothing in any case: the copy that still holds the credential is the one
    // the rename moved aside, and a rename keeps the inode, so that copy sits
    // at the user's own mode for the whole window.
    writeFileSync(file, content, { mode, flag: "wx" });
    // And again, because `writeFileSync`'s `mode` is masked by the process
    // umask: under one that strips group and other read, a 0644 original is
    // created 0600 and the stand-in ends up tighter than the file it replaces —
    // the very outcome the mode is here to avoid, in exactly the hardened
    // environments most likely to run the check as another uid. `chmod` is not
    // masked. The window between the two calls is tighter than intended and
    // never looser, so nothing can read the stand-in that could not already
    // read the original.
    chmodSync(file, mode);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The file is aside at this point, and leaving it there is the whole-file
    // withholding this function exists to stop doing. Put it back, then refuse:
    // a check run against a repository missing its configuration proves nothing
    // about the credential either.
    unpark({ original: file, parked });
    throw new Error(`could not stand in a copy of ${file} without its credential: ${reason}`);
  }
  return { original: file, parked };
}

/**
 * Puts the credential file back. Safe to call more than once, and deliberately
 * unconditional about the destination: what sits at the original path is this
 * run's own copy of the file without the credential, and if something else has
 * appeared there instead, the user's own credential file is still the copy that
 * has to survive this function.
 *
 * A rename, so the file comes back as the bytes it was — the same CRLF endings,
 * the same final newline or lack of one, the same mode. Nothing here
 * re-serialises what it read.
 *
 * Throws with the parked name in it rather than passing the `rename` error on
 * as it stands: the file is still on disk under a name its owner never chose,
 * and the one thing this failure owes them is where to find it.
 */
function unpark(entry: Parked | null): void {
  if (entry === null || !existsSync(entry.parked)) {
    return;
  }
  try {
    renameSync(entry.parked, entry.original);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not put ${entry.original} back after running the application without it: ${reason}. Your file is still on disk, at ${entry.parked} — move it back to ${entry.original}.`,
    );
  }
}

/**
 * The environment every run of the project's check gets: the caller's, with
 * TraceRoot switched off.
 *
 * Switched off twice over, because each half closes a different door.
 * `TRACEROOT_API_KEY` is *deleted* rather than set empty, because SDKs commonly
 * treat an empty string as "configured but blank" and take a different path
 * than "absent" — and absent is what the check is about. `TRACEROOT_ENABLED` is
 * set to `false`, which both SDKs honour, because absent from this environment
 * is not absent from the process: a key exported in a shell profile, or loaded
 * from a file nobody moved aside, reaches an SDK that `@observe` starts on its
 * own whenever `TRACEROOT_API_KEY` is set. dotenv does not override a variable
 * that is already set, so the switch holds against every file the application
 * loads for itself.
 *
 * A copy, never the caller's object: a variable is deleted from it, and the
 * environment handed in is the CLI's own.
 */
function withTraceRootOff(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const off: NodeJS.ProcessEnv = { ...env, TRACEROOT_ENABLED: "false" };
  // biome-ignore lint/performance/noDelete: absent and empty are different to an SDK
  delete off.TRACEROOT_API_KEY;
  return off;
}

/**
 * Runs the project's own check once, with TraceRoot switched off.
 *
 * The run is the part that cannot be delegated. Putting "the app must still
 * work without the key" in the agent's prompt only buys the agent's word for
 * it. Instrumentation that hard-fails on a missing key is a production outage
 * waiting for the day someone deploys without one, so setup proves it here
 * instead of asking.
 *
 * Absent means absent from every place the application can read it. The
 * instrumented entry point loads its credential file itself, so deleting
 * `TRACEROOT_API_KEY` from the child environment and leaving that file on disk
 * hands the run the same key back off disk, and the check passes for free. So
 * the key is taken out of every file that holds it for the duration, and the
 * files are restored in a `finally`: the key and not the file, because the file
 * is the project's own `.env` and the rest of it is the configuration the
 * application needs in order to start at all.
 *
 * Once, and never with the key. There used to be a first run with
 * `TRACEROOT_API_KEY` set, and it was the one thing setup ran that could send a
 * trace: a suite that never calls `initialize()` still exports when the key is
 * in its environment, because `@observe` starts the SDK on its own. Its traces
 * landed in the user's project beside the application's, and the trace poll
 * then took a unit test's trace for the application's first. What it
 * established, that the suite also passes with TraceRoot on, was paid for in
 * test traces in somebody's project; TraceRoot being on is exercised by the
 * application's own run instead, the one the first trace comes from.
 */
export async function verifyApplication(
  input: VerifyApplicationInput,
): Promise<VerifyApplicationResult> {
  const baseline = input.baseline ?? null;

  if (input.command === null || input.command.trim() === "") {
    return {
      verification: {
        command: null,
        baseline,
        run: NOT_RUN,
        outcome: "skipped",
        passed: false,
        skippedReason: "no test or health command was detected",
      },
      failure: null,
      withheld: [],
    };
  }

  const parsed = splitCommand(input.command);
  if (parsed === null) {
    return {
      verification: {
        command: input.command,
        baseline,
        run: NOT_RUN,
        outcome: "skipped",
        passed: false,
        skippedReason: `could not parse the verification command: ${input.command}`,
      },
      failure: null,
      withheld: [],
    };
  }

  // The virtualenv first, for the check and not only the baseline. The command
  // is `pytest` as the project documents it, and it lives inside the
  // virtualenv; a baseline that could spawn it and a verification that could
  // not is how this ended a real run on "`pytest` could not be run" with the
  // instrumentation already in place and correct.
  const env = withTraceRootOff(withVenvOnPath(input.parentEnv, input.interpreter));
  const checked = await withoutCredentialFiles(input.credentialFiles, () =>
    input.runProcess({
      program: parsed.program,
      args: parsed.args,
      cwd: input.cwd,
      env,
      stdio: "capture",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: input.signal,
      secrets: [input.credential],
    }),
  );
  const run: VerificationRun = {
    ran: true,
    exitCode: checked.result.exitCode,
    durationMs: checked.result.durationMs,
  };
  if (checked.result.exitCode !== 0) {
    // Two reasons this run cannot name a cause, and they are different claims.
    //
    // `alreadyBroken` is a measurement: the same command was run before
    // anything changed and did not pass then either, so running it afterwards
    // measured the project's own breakage.
    //
    // `unmeasured` is the absence of a measurement. It is not a rare edge: the
    // routes that hand the instrumentation task over take no baseline at all,
    // by a decision recorded where the baseline is taken, and they reach this
    // function on a later resume. A baseline that could not be spawned lands
    // here too.
    //
    // Neither is a finding, so neither is `failed`. `failed` means exactly one
    // thing — it passed before this run and does not pass now — which is the
    // only version of that sentence this function can support.
    const alreadyBroken = baseline?.ran === true && baseline.exitCode !== 0;
    const unmeasured = baseline === null || !baseline.ran;
    return {
      verification: {
        command: input.command,
        baseline,
        run,
        outcome: alreadyBroken || unmeasured ? "inconclusive" : "failed",
        passed: false,
        skippedReason: null,
      },
      // Output only where it is worth reading. A suite known to have been
      // failing beforehand has already explained itself, and its output is the
      // project's own business rather than something setup puts in front of the
      // user. An unmeasured one has explained nothing, so the caller is handed
      // the output to show — it is the only diagnostic that run has.
      failure: alreadyBroken ? null : { output: checked.result.output },
      withheld: checked.withheld,
    };
  }

  return {
    verification: {
      command: input.command,
      baseline,
      run,
      outcome: "passed",
      passed: true,
      skippedReason: null,
    },
    failure: null,
    withheld: checked.withheld,
  };
}

export interface BaselineCheckInput {
  /** The project's own check. */
  command: string;
  cwd: string;
  parentEnv: NodeJS.ProcessEnv;
  /**
   * The virtualenv interpreter the service runs on, when one was found.
   *
   * The same argument the real check takes, and for the same reason: the
   * command is `pytest` as the project documents it, which resolves only
   * because the user's shell has the virtualenv activated. Without this the
   * baseline cannot spawn the command at all on the commonest shape of Python
   * project there is, and a measurement that cannot run measures nothing.
   */
  interpreter: string | null;
  runProcess: RunProcess;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Runs the project's own check once, before anything is instrumented.
 *
 * The one measurement that cannot be taken later. Afterwards the code is
 * edited, and "the suite fails" no longer distinguishes a suite the
 * instrumentation broke from one that needed a database, a network or a fix
 * before setup ever ran — and a run that cannot tell those apart reports the
 * second as the first, which sends the user looking for a fault in work that
 * was done correctly.
 *
 * TraceRoot switched off, exactly as the check has it: no `TRACEROOT_API_KEY`,
 * an ambient one from the user's shell included, and `TRACEROOT_ENABLED=false`.
 * Nothing this run instrumented exists yet, but a repository that already
 * carries TraceRoot does, and its suite exports through `@observe` the moment a
 * key is reachable — from the shell, or from a file the project loads for
 * itself. A baseline must not put traces in the user's project any more than
 * the check may, and one taken with TraceRoot in a different state than the
 * check is not a baseline for it. Everything else about the environment is the
 * same, virtualenv included — a baseline that cannot find `pytest` where the
 * real check finds it is comparing two different things. The output is not
 * captured for reporting either: the exit code is the whole of what a baseline
 * is for, and a suite's pre-existing failure output is not setup's to put in
 * front of the user.
 *
 * Never throws for a failing command: a non-zero exit is the answer, not an
 * error. A command that cannot be parsed returns an un-run result, which reads
 * downstream as "no baseline" and leaves the verification behaving exactly as
 * it did before baselines existed.
 */
export async function runBaselineCheck(input: BaselineCheckInput): Promise<VerificationRun> {
  const parsed = splitCommand(input.command);
  if (parsed === null) {
    return NOT_RUN;
  }
  // The same environment the real check gets, built by the same function, so
  // the two cannot drift apart over whether TraceRoot is on. It copies before
  // it deletes, which matters here: `withVenvOnPath` hands back the very object
  // it was given when there is no virtualenv to add, and deleting in place
  // would reach into the caller's own environment.
  const env = withTraceRootOff(withVenvOnPath(input.parentEnv, input.interpreter));
  const result = await input.runProcess({
    program: parsed.program,
    args: parsed.args,
    cwd: input.cwd,
    env,
    stdio: "capture",
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: input.signal,
  });
  // A command that could not be spawned at all is not evidence about the
  // suite. Reported as un-run so the verification does not read a missing
  // binary as "this project was already broken" and excuse a real failure.
  if (result.spawnFailed) {
    return NOT_RUN;
  }
  return { ran: true, exitCode: result.exitCode, durationMs: result.durationMs };
}

/**
 * Runs `body` with the credential taken out of every one of these files, and
 * puts them all back however `body` ends.
 *
 * All of them or none: a refusal part-way through puts back what it already
 * touched before it propagates, because a run that stops here still has to
 * leave the repository as it found it.
 *
 * `finally` covers a throw, a non-zero exit, a timeout and an abort — the
 * process runner resolves rather than rejects for the last three. It does not
 * cover a signal: Node's default `SIGINT` ends the process without unwinding,
 * which is a plausible thing for a user to do in the middle of a ten-minute
 * test suite and would leave their credential file sitting under another name.
 * So the signals are handled for exactly as long as the files are parked, and
 * then re-raised so the interrupt still means what it meant.
 */
async function withoutCredentialFiles<T>(
  files: readonly string[],
  body: () => Promise<T>,
): Promise<{ result: T; withheld: readonly string[] }> {
  const parked: Parked[] = [];
  // Deduplicated: the file this run wrote and the file the key resolved from
  // are often one file, and parking a path twice would move the check's own
  // parked copy.
  try {
    for (const file of new Set(files)) {
      const entry = park(file);
      if (entry !== null) {
        parked.push(entry);
      }
    }
  } catch (err) {
    // A file this run could not put back outlives the run, so it is the failure
    // the user has to act on; the parking failure that brought us here is the
    // reason, and travels along as its cause.
    const failure = restore(parked);
    throw failure === null ? err : new Error(failure.message, { cause: err });
  }
  if (parked.length === 0) {
    return { result: await body(), withheld: [] };
  }

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  // The last net, for a `process.exit()` from somewhere else in the tree.
  //
  // Both of these drop what `restore` hands back, and have to: an exit handler
  // has nobody left to report to and a signal handler nothing to throw to. What
  // they can still do is attempt every file rather than stop at the first one
  // that will not go back, which is the whole of what is available here.
  const rescue = (): void => {
    restore(parked);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    restore(parked);
    for (const name of signals) {
      process.removeListener(name, onSignal);
    }
    process.removeListener("exit", rescue);
    process.kill(process.pid, signal);
  };

  for (const name of signals) {
    process.once(name, onSignal);
  }
  process.once("exit", rescue);
  // The body's outcome is held rather than returned or rethrown from inside the
  // `try`, so that the files go back first and a file that could not go back is
  // still reported afterwards: that one outlives the process and the user has to
  // move it by hand, where a failed check is a report this run was going to make
  // anyway. So the restoration speaks first, with the body's own failure as its
  // cause.
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  let failure: Error | null = null;
  try {
    outcome = { ok: true, value: await body() };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    failure = restore(parked);
    for (const name of signals) {
      process.removeListener(name, onSignal);
    }
    process.removeListener("exit", rescue);
  }
  if (failure !== null) {
    throw outcome.ok ? failure : new Error(failure.message, { cause: outcome.error });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return { result: outcome.value, withheld: parked.map((entry) => entry.original) };
}

/**
 * Puts every parked file back and hands back the first failure, or null when
 * they all went back. Safe to call more than once.
 *
 * Every entry is attempted before anything is reported. Stopping at the first
 * failed rename would leave every file behind it parked under a name its owner
 * never chose — the loss this whole dance exists to prevent, visited on the
 * files it was not even failing on — and one file that cannot go back is no
 * reason to abandon the rest.
 *
 * The failure comes back rather than being thrown so the caller can finish its
 * own cleanup before deciding where it surfaces: the signal and exit handlers
 * have listeners to drop and nowhere to throw to, and the paths that can
 * propagate do it once the listeners are gone.
 */
function restore(parked: readonly Parked[]): Error | null {
  let failure: Error | null = null;
  for (const entry of parked) {
    try {
      unpark(entry);
    } catch (err) {
      // The first one, kept: it names the first file the user has to deal with,
      // and a later success must not be what they hear about instead.
      failure ??= err instanceof Error ? err : new Error(String(err));
    }
  }
  return failure;
}
