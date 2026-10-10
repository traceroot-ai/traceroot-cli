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
  credential: Secret;
  host: string;
  /**
   * Absolute path to the dotenv file this run wrote the credential into, or
   * null when it wrote none — a key that already resolved from the user's own
   * config is never written to a file at all.
   *
   * Required rather than optional because forgetting it silently empties the
   * credential-free run of its meaning: the instrumented entry point loads this
   * file itself, so an environment with `TRACEROOT_API_KEY` removed and the
   * file still on disk is a second run *with* the key.
   */
  credentialFile: string | null;
  runProcess: RunProcess;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the real clock. */
  now?: () => number;
}

/**
 * The verification plus, when it failed, the captured output of the run that
 * failed. The output is returned separately rather than folded into
 * {@link ApplicationVerification} on purpose: the verification is checkpointed,
 * and a checkpoint must not accumulate arbitrary process output.
 */
export interface VerifyApplicationResult {
  verification: ApplicationVerification;
  failure: { phase: "with" | "without"; output: string } | null;
  /**
   * Files moved aside for the credential-free run, so what "without the
   * credential" meant is a fact the caller can report rather than a promise.
   * Empty when there was nothing to move.
   */
  withheld: readonly string[];
  /**
   * When the application ran with the credential present, or null when it never
   * ran. The window a trace has to fall inside to be this run's own, which is
   * the only thing that distinguishes it from the project's other traffic.
   */
  ranAt: { from: Date; to: Date } | null;
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
 */
function unpark(entry: Parked | null): void {
  if (entry === null || !existsSync(entry.parked)) {
    return;
  }
  renameSync(entry.parked, entry.original);
}

/**
 * Runs the project's own check twice: once with the TraceRoot credential
 * present, once with it removed.
 *
 * The second run is the part that cannot be delegated. Putting "the app must
 * still work without the key" in the agent's prompt only buys the agent's word
 * for it. Instrumentation that hard-fails on a missing key is a
 * production outage waiting for the day someone deploys without one, so setup
 * proves it here instead of asking.
 *
 * Absent means absent from both places the application can read it. The
 * instrumentation task tells the agent to load the credential file from the
 * entry point — `load_dotenv("./.env.traceroot")` — so deleting
 * `TRACEROOT_API_KEY` from the child environment and leaving the file on disk
 * hands the second run the same key back off disk, and the check passes for
 * free. The file is moved aside for the duration and restored in a `finally`,
 * because a verification step that can lose a user's credential file is worse
 * than one that proves too little.
 *
 * `TRACEROOT_API_KEY` is *deleted* from the child environment rather than set
 * empty, because SDKs commonly treat an empty string as "configured but blank"
 * and take a different path than "absent".
 */
export async function verifyApplication(
  input: VerifyApplicationInput,
): Promise<VerifyApplicationResult> {
  const now = input.now ?? (() => Date.now());
  const idle = { withheld: [] as readonly string[], ranAt: null };

  if (input.command === null || input.command.trim() === "") {
    return {
      verification: {
        command: null,
        withCredentials: NOT_RUN,
        withoutCredentials: NOT_RUN,
        passed: false,
        skippedReason: "no test or health command was detected",
      },
      failure: null,
      ...idle,
    };
  }

  const parsed = splitCommand(input.command);
  if (parsed === null) {
    return {
      verification: {
        command: input.command,
        withCredentials: NOT_RUN,
        withoutCredentials: NOT_RUN,
        passed: false,
        skippedReason: `could not parse the verification command: ${input.command}`,
      },
      failure: null,
      ...idle,
    };
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const withEnv: NodeJS.ProcessEnv = {
    ...input.parentEnv,
    TRACEROOT_API_KEY: input.credential.reveal(),
    TRACEROOT_HOST_URL: input.host,
  };
  // Same host as the configured run, so the two only differ by the credential.
  // Without this the credential-free run inherits whatever `TRACEROOT_HOST_URL`
  // the parent environment happens to carry, and the comparison stops being
  // about the key at all.
  const withoutEnv: NodeJS.ProcessEnv = {
    ...input.parentEnv,
    TRACEROOT_HOST_URL: input.host,
  };
  // biome-ignore lint/performance/noDelete: absent and empty are different to an SDK
  delete withoutEnv.TRACEROOT_API_KEY;

  const from = new Date(now());
  const first = await input.runProcess({
    program: parsed.program,
    args: parsed.args,
    cwd: input.cwd,
    env: withEnv,
    stdio: "capture",
    timeoutMs,
    signal: input.signal,
    secrets: [input.credential],
  });
  const ranAt = { from, to: new Date(now()) };
  const withCredentials: VerificationRun = {
    ran: true,
    exitCode: first.exitCode,
    durationMs: first.durationMs,
  };
  if (first.exitCode !== 0) {
    return {
      verification: {
        command: input.command,
        withCredentials,
        withoutCredentials: NOT_RUN,
        passed: false,
        skippedReason: null,
      },
      failure: { phase: "with", output: first.output },
      withheld: [],
      ranAt,
    };
  }

  const second = await withoutCredentialFile(input.credentialFile, () =>
    input.runProcess({
      program: parsed.program,
      args: parsed.args,
      cwd: input.cwd,
      env: withoutEnv,
      stdio: "capture",
      timeoutMs,
      signal: input.signal,
      secrets: [input.credential],
    }),
  );
  const withoutCredentials: VerificationRun = {
    ran: true,
    exitCode: second.result.exitCode,
    durationMs: second.result.durationMs,
  };

  return {
    verification: {
      command: input.command,
      withCredentials,
      withoutCredentials,
      passed: second.result.exitCode === 0,
      skippedReason: null,
    },
    failure:
      second.result.exitCode === 0 ? null : { phase: "without", output: second.result.output },
    withheld: second.withheld,
    ranAt,
  };
}

/**
 * Runs `body` with the credential file moved aside, and puts it back however
 * `body` ends.
 *
 * `finally` covers a throw, a non-zero exit, a timeout and an abort — the
 * process runner resolves rather than rejects for the last three. It does not
 * cover a signal: Node's default `SIGINT` ends the process without unwinding,
 * which is a plausible thing for a user to do in the middle of a ten-minute
 * test suite and would leave their credential file sitting under another name.
 * So the signals are handled for exactly as long as the file is parked, and
 * then re-raised so the interrupt still means what it meant.
 */
async function withoutCredentialFile<T>(
  file: string | null,
  body: () => Promise<T>,
): Promise<{ result: T; withheld: readonly string[] }> {
  const parked = file === null ? null : park(file);
  if (parked === null) {
    return { result: await body(), withheld: [] };
  }

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  // The last net, for a `process.exit()` from somewhere else in the tree.
  const rescue = (): void => unpark(parked);
  const onSignal = (signal: NodeJS.Signals): void => {
    unpark(parked);
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
  try {
    return { result: await body(), withheld: [parked.original] };
  } finally {
    unpark(parked);
    for (const name of signals) {
      process.removeListener(name, onSignal);
    }
    process.removeListener("exit", rescue);
  }
}
