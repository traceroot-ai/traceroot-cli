import type { Readable, Writable } from "node:stream";
import { cancel, select as clackSelect, isCancel } from "@clack/prompts";
import { SetupError } from "./errors.js";
import { type InputStream, discardTypeAhead } from "./tty.js";
import type { SetupStage } from "./types.js";

/**
 * Interactive single choice.
 *
 * Kept behind a dependency rather than called inline so the whole flow stays
 * testable without a TTY, and so the presentation layer can change without
 * touching a single stage.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Dimmed detail shown beside the label. */
  hint?: string;
}

export interface SelectInput {
  message: string;
  options: SelectOption[];
  /** Pre-highlighted option; defaults to the first. */
  initialValue?: string;
  /** Stage blamed if the user cancels, so the error names where it stopped. */
  stage: SetupStage;
}

export type SelectFn = (input: SelectInput) => Promise<string>;

/**
 * The terminal a question is asked on.
 *
 * Both halves travel together because the drain and the prompt have to be
 * looking at the same stream. Draining `process.stdin` while clack reads
 * something else would discard nothing and prove nothing, and that is exactly
 * the mistake a test would fail to catch if the two were passed separately.
 */
export interface SelectTerminal {
  input: InputStream & Readable;
  output: Writable;
}

/**
 * Production selector, against a given terminal.
 *
 * Split from {@link interactiveSelect} only so a test can hand it a pair of
 * streams: the type-ahead this discards is the whole point of the function, and
 * the one way to see it discarded is to be the thing that typed it.
 *
 * Cancellation (Ctrl+C) is a deliberate user action, not a fault: it exits 0
 * with a plain message rather than a stack trace or a failure code, matching how
 * the rest of the CLI treats a declined prompt.
 */
export async function selectFrom(input: SelectInput, terminal: SelectTerminal): Promise<string> {
  // Nothing typed before this question appeared is an answer to it. See
  // `discardTypeAhead` — without this, a stray Enter from the previous question
  // takes this one's default before the user has read a word of it.
  await discardTypeAhead(terminal.input);

  const choice = await clackSelect({
    message: input.message,
    options: input.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
    initialValue: input.initialValue ?? input.options[0]?.value,
    input: terminal.input,
    output: terminal.output,
    // No "↑/↓ to navigate · Enter: confirm" footer under the options.
    //
    // Clack prints it by default.
    // Arrow keys and Enter are how every list in a terminal has worked
    // for decades; a caption teaching them costs a line under every question
    // in the run, and the lines it competes with are the ones that say what
    // the choice actually does. The highlighted row already shows what
    // navigation means.
    showInstructions: false,
  });

  if (isCancel(choice)) {
    cancel("Setup cancelled.");
    throw new SetupError({
      stage: input.stage,
      code: "CANCELLED",
      message: "Setup cancelled.",
    });
  }
  return String(choice);
}

/** The selector the machine is wired to: {@link selectFrom} on the real terminal. */
export const interactiveSelect: SelectFn = (input) =>
  selectFrom(input, { input: process.stdin, output: process.stdout });
