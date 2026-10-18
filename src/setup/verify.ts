import { existsSync, renameSync } from "node:fs";
import { type RunProcess, splitCommand } from "./exec.js";
import type { Secret } from "./secret.js";
import type { ApplicationVerification, VerificationRun } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Where the credential file is parked while the application runs without it.
 *
 * A sibling path, so the move is a rename within one directory and cannot fail
 * across filesystems, and a name obvious enough that someone who finds one left
 * behind by a killed process knows what it is and where it belongs.
 */
const PARKED_SUFFIX = ".traceroot-setup-hidden";

export interface VerifyApplicationInput {
  /** The project's own check, as detected. Null when it has none. */
  command: string | null;
  cwd: string;
  parentEnv: NodeJS.ProcessEnv;
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
   * Files moved aside for the credential-free run, so what "without the
   * credential" meant is a fact the caller can report rather than a promise.
   * Empty when there was nothing to move.
   */
  withheld: readonly string[];
}

const NOT_RUN: VerificationRun = { ran: false, exitCode: null, durationMs: 0 };

/** A file moved out of the way, and where it came from. */
interface Parked {
  original: string;
  parked: string;
}

/**
 * Moves the credential file aside, or returns null when there is nothing there.
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
  try {
    renameSync(file, parked);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not move ${file} aside to run the application without its credential: ${reason}`,
    );
  }
  return { original: file, parked };
}

/**
 * Puts the credential file back. Safe to call more than once, and deliberately
 * unconditional about the destination: if anything has since appeared at the
 * original path, the user's own credential file is still the copy that has to
 * survive this function.
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
 * hands the run the same key back off disk, and the check passes for free.
 * Every file that holds the key is moved aside for the duration and restored in
 * a `finally`, because a verification step that can lose a user's credential
 * file is worse than one that proves too little.
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
  if (input.command === null || input.command.trim() === "") {
    return {
      verification: {
        command: null,
        run: NOT_RUN,
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
        run: NOT_RUN,
        passed: false,
        skippedReason: `could not parse the verification command: ${input.command}`,
      },
      failure: null,
      withheld: [],
    };
  }

  const env = withTraceRootOff(input.parentEnv);
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
  const passed = checked.result.exitCode === 0;

  return {
    verification: {
      command: input.command,
      run,
      passed,
      skippedReason: null,
    },
    failure: passed ? null : { output: checked.result.output },
    withheld: checked.withheld,
  };
}

/**
 * Runs `body` with every credential file moved aside, and puts them all back
 * however `body` ends.
 *
 * All of them or none: a refusal part-way through puts back what it already
 * moved before it propagates, because a run that stops here still has to leave
 * the repository as it found it.
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
