import { CliError } from "../output.js";
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
  | "APP_VERIFICATION_FAILED"
  | "TRACE_TIMEOUT"
  | "BACKEND_UNSUPPORTED"
  | "UNSAFE_OVERWRITE"
  // A user pressing Ctrl+C is not a failure; it exits 0 like a declined prompt.
  | "CANCELLED";

/** Stable code → exit status. Part of the command's contract; do not renumber. */
export const SETUP_EXIT_CODES: Readonly<Record<SetupErrorCode, number>> = {
  UNEXPECTED: 1,
  NOT_AUTHENTICATED: 2,
  AMBIGUOUS: 3,
  UNSUPPORTED: 4,
  AGENT_FAILED: 5,
  APP_VERIFICATION_FAILED: 6,
  TRACE_TIMEOUT: 7,
  BACKEND_UNSUPPORTED: 8,
  UNSAFE_OVERWRITE: 9,
  CANCELLED: 0,
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
