import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileSecure } from "../util/secureFile.js";
import { ensureGitignore } from "./artifacts.js";
import { type Secret, redact } from "./secret.js";

/**
 * The agent's own account of what it did, kept for the runs that need it.
 *
 * The instrument stage shows the agent working as a block of activity lines
 * above a spinner and then takes the block away again, because on a run that
 * worked the transcript was progress rather than a record: what changed is in
 * `git diff` and in the setup report. That reasoning holds right up to the run
 * that exits 0 having achieved nothing — a failure wearing a success's exit
 * code — where the cleared block was the only account of why the agent stopped,
 * and the checks that decide the run failed all happen after it is gone.
 *
 * Kept as a file rather than left on screen, for three reasons. The on-screen
 * block is a window and not a transcript: it holds the last few parsed activity
 * lines, so even preserving it would preserve a summary of the end of the run.
 * The failures this exists for are reported after the fact, by which time the
 * terminal has scrolled or closed. And a file can be attached to a bug report,
 * which is what actually happens to this evidence next.
 *
 * Whole, not tailed. The stop reason can be anywhere in it — a refused tool
 * call in the middle, the `system/init` event at the very top that says which
 * tools the agent was given — and a truncation that drops either end drops the
 * answer. It costs nothing in memory that the run was not already paying:
 * `runProcess` has the entire captured output in a string before any of this
 * runs.
 *
 * In `.traceroot/`, where the existing `.gitignore` covers it, and written with
 * the same 0700/0600 discipline as the credential and the checkpoint. This is
 * the one setup artefact that quotes whatever the agent happened to read out of
 * the repository, so it must not be committable and must not be world-readable.
 *
 * One stable path, overwritten per run. The remedy has to be able to name it,
 * and the failure anyone is debugging is the one that just happened.
 */

/** Where the transcript lives, relative to the repository root. */
export const AGENT_OUTPUT_PATH = join(".traceroot", "setup-instrument-output.log");

/**
 * Writes the agent's captured output, returning the repository-relative path —
 * or null when there was nothing to write or it could not be written.
 *
 * Null is what stops the error naming a file that is not there. A run whose
 * agent printed nothing at all has no evidence to offer, and a failed write is
 * not worth replacing the real failure with: the stage is already throwing, and
 * throwing something about the filesystem instead would bury the cause this is
 * meant to surface. Both cases simply leave the pointer off the remedy.
 *
 * Redacted here as well as in `runProcess`.
 *
 * `launchAgent` passes the application credential to `runProcess` as a secret,
 * which scrubs it from both the streamed chunks and the returned `output`, so
 * what arrives here has already been through it. This is the same defence in
 * depth that redaction applies twice for there — once per chunk, once over the
 * whole buffer — and it is the one that matters most, because this is the only
 * one of the three whose result is a file that outlives the process. A caller
 * that assembles output some other way cannot leak a key through this function.
 */
export function writeAgentOutput(input: {
  /** Repository root: where `.traceroot/` lives. */
  root: string;
  /** The agent's captured stdout+stderr, exactly as `runProcess` returned it. */
  output: string;
  /** Every secret that must not reach the disk; the application credential. */
  secrets: readonly Secret[];
}): string | null {
  if (input.output.trim() === "") {
    return null;
  }
  const target = join(input.root, AGENT_OUTPUT_PATH);
  const redacted = redact(input.output, input.secrets);
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    ensureGitignore(dirname(target));
    // The agent's bytes and nothing else: Claude Code's stream is newline-
    // delimited JSON, so a header of our own would be a line `jq` chokes on.
    writeFileSecure(target, redacted.endsWith("\n") ? redacted : `${redacted}\n`);
    return AGENT_OUTPUT_PATH;
  } catch {
    return null;
  }
}
