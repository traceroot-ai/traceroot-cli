import { type RunProcess, splitCommand } from "./exec.js";
import type { Secret } from "./secret.js";
import type { ApplicationVerification, VerificationRun } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface VerifyApplicationInput {
  /** The project's own check, as detected. Null when it has none. */
  command: string | null;
  cwd: string;
  parentEnv: NodeJS.ProcessEnv;
  credential: Secret;
  host: string;
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
  failure: { phase: "with" | "without"; output: string } | null;
}

const NOT_RUN: VerificationRun = { ran: false, exitCode: null, durationMs: 0 };

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
 * `TRACEROOT_API_KEY` is *deleted* from the child environment rather than set
 * empty, because SDKs commonly treat an empty string as "configured but blank"
 * and take a different path than "absent".
 */
export async function verifyApplication(
  input: VerifyApplicationInput,
): Promise<VerifyApplicationResult> {
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
    };
  }

  const second = await input.runProcess({
    program: parsed.program,
    args: parsed.args,
    cwd: input.cwd,
    env: withoutEnv,
    stdio: "capture",
    timeoutMs,
    signal: input.signal,
    secrets: [input.credential],
  });
  const withoutCredentials: VerificationRun = {
    ran: true,
    exitCode: second.exitCode,
    durationMs: second.durationMs,
  };

  return {
    verification: {
      command: input.command,
      withCredentials,
      withoutCredentials,
      passed: second.exitCode === 0,
      skippedReason: null,
    },
    failure: second.exitCode === 0 ? null : { phase: "without", output: second.output },
  };
}
