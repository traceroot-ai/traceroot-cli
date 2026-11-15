import type { InterruptSignal } from "./events.js";

/**
 * The outcomes of `traceroot evals run` that no other command produces, each with its own exit
 * code, so a script or a coding agent can tell "a case regressed" from "the evaluation couldn't
 * run" without reading the output.
 *
 * Part of the command's contract; do not renumber.
 *
 * Every code below 10 belongs to the classes all commands share ({@link ExitCode} in
 * src/output.ts), and `setup` numbers its own outcomes from 10 to 16 (src/setup/errors.ts). This
 * table continues from 17, so a code of 10 or more means one outcome across the whole CLI. Where
 * this command fails the way any other can, as with a bad flag (2) or a baseline run that doesn't
 * exist (4), it returns the shared code.
 */
export const EVALS_RUN_EXIT_CODES = {
  /**
   * The evaluation didn't run: no interpreter or tsx, an SDK too old to run it, a failure the
   * runner reported (`fatal`), no evaluation in the file, or a runner that crashed.
   */
  harness: 17,
  /** A case and scorer pair that passed in the baseline run doesn't now, or a case newly errors. */
  regressed: 18,
} as const;

/**
 * The exit code of a run cancelled by a signal: the shell's own status for a process that signal
 * ended, 128 plus the signal's number.
 */
export const INTERRUPTED_EXIT_CODES: Readonly<Record<InterruptSignal, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
