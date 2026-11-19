/**
 * What every line that redraws itself in place shares: the spinner's frames, the timer that turns
 * them, and the sequence that erases the line.
 *
 * Kept apart from spinner.ts, which draws the wizard's rail from the prompt library, so a command
 * off the wizard's path, such as `evals run`, can animate a line without loading that library.
 */

/** Clack's spinner alphabet. */
export const FRAMES = ["◒", "◐", "◓", "◑"] as const;
const FRAME_MS = 120;

/** Written out rather than embedded, so no control character reaches source. */
export const ESC = String.fromCharCode(27);
/** Erase this line, return to column 0. Never moves the cursor up. */
export const CLEAR_LINE = `${ESC}[2K\r`;

/** Real timers, unref'd so a spinner can never be the reason a process lingers. */
export function defaultAnimate(tick: () => void): () => void {
  const timer = setInterval(tick, FRAME_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
