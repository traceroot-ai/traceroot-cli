import type { Sink } from "../output.js";

/**
 * Whether a sink can be drawn on rather than merely appended to.
 *
 * `isTTY` is the honest test: a pipe, a CI log or a file has no cursor to move,
 * and an escape sequence written into one is corruption rather than animation.
 * `NO_COLOR` and `TERM=dumb` are the user saying the same thing on purpose.
 *
 * Shared by everything in the wizard that redraws, so a terminal that gets a
 * live checklist also gets a live spinner, and one that gets neither gets
 * neither. Two copies of this predicate would eventually disagree.
 */
export function canRedraw(sink: Sink, env: NodeJS.ProcessEnv): boolean {
  const tty = (sink as unknown as { isTTY?: boolean }).isTTY === true;
  return tty && env.TERM !== "dumb" && (env.NO_COLOR === undefined || env.NO_COLOR === "");
}

/** The input side of the terminal, narrowed to what discarding type-ahead needs. */
export interface InputStream {
  read: () => unknown;
  resume: () => unknown;
  pause: () => unknown;
}

/**
 * Throws away anything typed before the next question was on screen.
 *
 * Keystrokes are not addressed to a prompt, they are addressed to the process:
 * stdin buffers whatever arrives while nothing is reading it, and the next
 * reader is handed the backlog the instant it attaches. Between two of the
 * wizard's questions there is always such a gap — a stage boundary, an SDK
 * version lookup, a skill install — and a second Enter pressed during it does
 * not go nowhere. It answers the question that has not been asked yet, at
 * whatever that question's default happens to be.
 *
 * Which was live for the worst question in the run. Answering "Run Claude Code
 * for me" and pressing Enter once more — the ordinary reflex of someone moving
 * through a wizard — silently took "Confirm" on the gate guarding an LLM's
 * permission to edit the repository, so the agent started with the one prompt
 * that exists to be deliberated over never having been seen at all.
 *
 * So every prompt in the wizard drains first, and the rule is that a keystroke
 * only counts as an answer to a question that was already asked. It costs
 * type-ahead, which is a real thing to give up and the right trade here: these
 * questions are few, each is consequential, and none of them is one a user
 * could sensibly answer before reading it.
 *
 * Draining is asynchronous because it has to be. The bytes are not in the
 * stream's buffer yet when the gap starts — they are below Node, in the tty —
 * so a synchronous `read()` sees nothing. Resuming the stream pulls them up on
 * the next tick, `read()` discards what surfaced, and the pause afterwards
 * leaves the stream exactly as it was found, which is what lets clack attach to
 * it cleanly on the next line.
 */
export async function discardTypeAhead(input: InputStream): Promise<void> {
  input.resume();
  await new Promise((resolve) => setImmediate(resolve));
  while (input.read() !== null) {
    // Discarded on purpose: this was typed at a question nobody had asked.
  }
  input.pause();
}

/** The input side of the terminal, narrowed to what waiting on a keypress needs. */
export interface WatchableInput extends InputStream {
  on: (event: "data", listener: (chunk: unknown) => void) => unknown;
  off: (event: "data", listener: (chunk: unknown) => void) => unknown;
  isTTY?: boolean;
}

export interface WaitForEnterInput {
  input: WatchableInput;
  /** Called once, when the user presses Enter. Never called after `stop`. */
  onEnter: () => void;
}

/**
 * Lets the user end a wait by pressing Enter, and returns the function that
 * stops listening.
 *
 * Enter, and line-buffered stdin, on purpose. The obvious implementation is raw
 * mode and "press any key", and raw mode takes the terminal's own interrupt
 * character with it: `Ctrl+C` stops being a signal and starts being a `0x03`
 * byte this process has to recognise and re-raise itself. Getting that wrong
 * during a two-minute wait means a user who wants out cannot get out, and a
 * process that dies before restoring the mode leaves their shell with echo off.
 * Line discipline costs a key the user has to look for and buys the signal back
 * untouched — this function cannot break `Ctrl+C` because it never touches the
 * setting that governs it.
 *
 * Any line counts, not just an empty one. Somebody who typed while waiting and
 * then hit Enter has still asked to stop waiting, and reading their keystrokes
 * to decide whether they meant it would be a worse guess than taking them at
 * their word.
 *
 * Type-ahead is drained first, for the reason {@link discardTypeAhead} exists:
 * the Enter pressed at the confirmation prompt several minutes ago is still in
 * the tty's buffer, and attaching a reader hands it over on the next tick. That
 * keystroke was an answer to a question that had been asked; this one is not,
 * and a wait that skipped itself before it was ever offered would read as the
 * feature being broken.
 *
 * A sink with no tty gets nothing at all: there is nobody to press anything, and
 * resuming stdin in a pipeline would consume input that belongs to whatever is
 * on the other end of it.
 */
export function waitForEnter(input: WaitForEnterInput): () => void {
  const stream = input.input;
  if (stream.isTTY !== true) {
    return () => undefined;
  }

  let stopped = false;
  const listener = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    input.onEnter();
  };

  // Drained before the listener attaches, so the backlog goes to the floor
  // rather than to `onEnter`. Fire-and-forget: `discardTypeAhead` resumes the
  // stream itself, and the listener below is attached after it settles.
  void discardTypeAhead(stream).then(() => {
    if (stopped) {
      return;
    }
    stream.on("data", listener);
    stream.resume();
  });

  return () => {
    stopped = true;
    stream.off("data", listener);
    // Back to how the wizard leaves stdin between questions, so clack can
    // attach to it cleanly for whatever is asked next.
    stream.pause();
  };
}
