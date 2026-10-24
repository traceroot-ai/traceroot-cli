import { CliError, ExitCode } from "../output.js";
import type { SetupStage } from "./types.js";

/**
 * Failure classes for `setup`, each with its own process exit code so CI can
 * branch on *why* setup stopped — "the trace never arrived" is a very different
 * signal from "the agent crashed", and both differ from "you are not logged
 * in". A single catch-all exit code makes that distinction unrecoverable.
 */
export type SetupErrorCode =
  | "UNEXPECTED"
  | "NOT_AUTHENTICATED"
  | "AMBIGUOUS"
  | "UNSUPPORTED"
  | "AGENT_FAILED"
  | "TRACE_TIMEOUT"
  | "BACKEND_UNSUPPORTED"
  | "UNSAFE_OVERWRITE"
  // A question the user answered no to. A decision rather than a fault, so it
  // exits 0: a non-zero code here would make a deliberate stop look like a bug
  // to every script that wraps this command.
  | "CANCELLED"
  // A question the user never answered — Ctrl+C, or Escape, at a prompt. The
  // same keypress a shell reports as 130, and the reason it cannot share
  // `CANCELLED`'s 0: `traceroot setup && <next step>` must not carry on through
  // an interrupt, and the only thing that stops it is a non-zero status.
  | "INTERRUPTED";

/**
 * Stable code → exit status. Part of the command's contract; do not renumber.
 *
 * Two bands, because these numbers are not setup's to spend. 1–5 belong to the
 * whole CLI ({@link ExitCode}) and are referenced rather than repeated here, so
 * a script that reads 3 as "re-authenticate" is right whichever command handed
 * it back. Setup's own outcomes start at 10, and the gap is deliberate: the
 * shared table owns everything below it, including numbers it has not used yet.
 *
 * They were numbered from 2 up, which collided with all of it —
 * `setup --trace-timeout abc` exits 2 as a usage error and so did a run that was
 * not logged in, AGENT_FAILED shared 5 with the retryable network class, and the
 * `--json` envelope, which derives its `code` string from the number, named a
 * class the run had nothing to do with.
 *
 * 130 is the shell's own convention for a process ended by SIGINT, not a number
 * this table invented, which is why it sits outside both bands.
 */
export const SETUP_EXIT_CODES: Readonly<Record<SetupErrorCode, number>> = {
  UNEXPECTED: ExitCode.internal,
  // Not setup-specific at all: no credentials is what the shared `auth` class
  // already means, and a caller re-authenticating in response is right.
  NOT_AUTHENTICATED: ExitCode.auth,
  AMBIGUOUS: 10,
  UNSUPPORTED: 11,
  AGENT_FAILED: 12,
  // 13 is reserved. It was the failure of setup's own run of the project's
  // checks, which setup no longer makes, and a number is never handed on to a
  // different outcome.
  TRACE_TIMEOUT: 14,
  BACKEND_UNSUPPORTED: 15,
  UNSAFE_OVERWRITE: 16,
  CANCELLED: 0,
  INTERRUPTED: 130,
};

export interface SetupErrorOptions {
  stage: SetupStage;
  code: SetupErrorCode;
  message: string;
  /** A ready-to-run command that unblocks the user, appended to the message. */
  remedy?: string;
}

/**
 * A stage failure. Extends {@link CliError} so the existing central error
 * handler reports it (red, no stack trace, stderr only) and honours its exit
 * code without any special-casing.
 */
export class SetupError extends CliError {
  readonly stage: SetupStage;
  readonly code: SetupErrorCode;
  readonly remedy: string | null;

  constructor(options: SetupErrorOptions) {
    const remedy = options.remedy ?? null;
    super(
      remedy === null ? options.message : `${options.message}\n\n${remedy}`,
      SETUP_EXIT_CODES[options.code],
    );
    this.name = "SetupError";
    this.stage = options.stage;
    this.code = options.code;
    this.remedy = remedy;
  }
}

/**
 * The error raised when a required backend endpoint is absent. Kept as a
 * dedicated constructor because every call site owes the user the same thing: a
 * concrete manual fallback, since the CLI half of the feature is complete and
 * only the server side is missing.
 */
export function backendUnsupported(
  stage: SetupStage,
  what: string,
  fallback: string,
  host?: string,
): SetupError {
  // Naming the host is the whole point of this message. "Not available on this
  // deployment" is unactionable when the reader cannot see WHICH deployment was
  // asked — and the commonest cause is the default (TraceRoot Cloud) being used
  // when the developer meant a local or self-hosted one.
  const where = host === undefined || host === "" ? "this TraceRoot deployment" : host;
  return new SetupError({
    stage,
    code: "BACKEND_UNSUPPORTED",
    message: `${what} is not available at ${where} yet.`,
    remedy: fallback,
  });
}
