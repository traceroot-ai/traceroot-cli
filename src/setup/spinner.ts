import { S_BAR } from "@clack/prompts";
import color from "picocolors";
import type { Sink } from "../output.js";
import { canRedraw } from "./tty.js";

/**
 * A spinner that owns exactly one line: the last one.
 *
 * Two waits in the run have nothing to report while they last — the browser
 * sign-in, where the user is somewhere else entirely, and the trace poll. Static
 * text across either is indistinguishable from a hang, which is the one
 * impression a first-run tool cannot afford.
 *
 * It never moves the cursor up. Above this line sit a URL and a verification
 * code the user has to read and, in the URL's case, select with a mouse;
 * anything that redraws them risks tearing them mid-copy. So it only ever erases
 * the line it is on and rewrites it in place, and {@link LineSpinner.writeAbove}
 * grows the screen by pushing a settled line out below what is already there and
 * redrawing the spinner underneath it. That is what lets the coding agent's
 * activity feed accumulate above a spinner that stays last:
 *
 *     │  run: ls -la "/path/to/repo"
 *     │  read: barebone.py
 *     │
 *     ◑  Running Claude Code [34s]
 */

/** Clack's spinner alphabet. */
const FRAMES = ["◒", "◐", "◓", "◑"] as const;
const FRAME_MS = 120;

/** Written out rather than embedded, so no control character reaches source. */
const ESC = String.fromCharCode(27);
/** Erase this line, return to column 0. Never moves the cursor up. */
const CLEAR_LINE = `${ESC}[2K\r`;
/** Erase from the cursor to the bottom of the screen. */
const CLEAR_BELOW = `${ESC}[0J`;

export interface LineSpinner {
  /** Changes what the line says, without disturbing anything above it. */
  setMessage: (message: string) => void;
  /**
   * Adds one settled line above the spinner, which stays on the bottom.
   *
   * With a `maxFeedLines` window the lines are live rather than committed —
   * they scroll within the block and {@link LineSpinner.stopAndClear} can take
   * the whole thing away. Without one they are appended permanently, which is
   * what a sink with no cursor gets in every case.
   */
  writeAbove: (text: string) => void;
  /** Replaces the spinner with one settled line, and stops animating. */
  stop: (message: string) => void;
  /**
   * Erases the whole block — every feed line and the spinner itself — and
   * leaves `line` alone in its place.
   *
   * For the end of a step whose feed was progress rather than a record. A
   * coding agent's `run:`/`read:`/`write:` transcript is worth watching while
   * it happens and worth nothing afterwards: the diff and the setup report are
   * the authority on what changed, and forty stale paths above the closing
   * lines simply bury them.
   *
   * `line` is written verbatim, glyph and all, because the caller is the only
   * one that knows whether this settled as a step, a warning or a failure.
   *
   * On a sink with no cursor the feed lines have already gone out and cannot be
   * unwritten — correct for a log, which is read after the fact — so this
   * degrades to appending `line`. Same when the spinner has no feed window
   * (`maxFeedLines` unset): those lines were committed as they arrived.
   */
  stopAndClear: (line: string) => void;
}

export interface LineSpinnerInput {
  sink: Sink;
  message: string;
  env?: NodeJS.ProcessEnv;
  /** Clock behind the elapsed counter; injected so tests are deterministic. */
  now?: () => number;
  /** Starts the animation and returns a stop function; injected for tests. */
  animate?: (tick: () => void) => () => void;
  /**
   * How many transcript lines stay on screen above the spinner.
   *
   * A coding agent makes dozens of tool calls. Committing each one permanently
   * pushed the whole run off the top of the terminal and buried the wizard in
   * a wall of paths. A window keeps the block a fixed size: the newest lines
   * are visible, older ones scroll out of it.
   */
  maxFeedLines?: number;
  /**
   * When this wait has a deadline, as epoch milliseconds: the counter shows
   * what is left of it instead of how long it has been going.
   *
   * Elapsed time answers "is this hung?", which matters for a wait that could
   * in principle go on forever. A browser sign-in cannot: the link expires, and
   * then the run fails. For that wait the useful number is the budget, not the
   * spend — "how long do I have" rather than "how long have I been". Counting
   * up would leave a user who stepped away with nothing to work out whether the
   * link in front of them is still worth clicking.
   *
   * Falls back to elapsed once the deadline has passed, so the line keeps
   * moving in the seconds between expiry and the poll that reports it.
   */
  deadline?: number;
}

/** Real timers, unref'd so a spinner can never be the reason a process lingers. */
function defaultAnimate(tick: () => void): () => void {
  const timer = setInterval(tick, FRAME_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Starts spinning immediately. The caller must always `stop` it. */
export function startLineSpinner(input: LineSpinnerInput): LineSpinner {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now;
  const animate = input.animate ?? defaultAnimate;
  const started = now();
  let message = input.message;
  let frame = 0;

  const rail = color.dim(S_BAR);
  // Magenta rather than cyan for the spinning glyph. Cyan is what clack uses
  // for an active prompt, so the two were the same colour and a spinner read
  // as a question waiting on the user. There is no orange in picocolors'
  // 16-colour set; magenta is the nearest thing that is unmistakably not a
  // prompt, not an error, and not the dim transcript.

  if (!canRedraw(input.sink, env)) {
    // A pipe, a CI log or a file. One plain line per change of state, no
    // escape codes and no animation — a log is read after the fact, where a
    // spinner has nothing to add and a `\r` is damage. The rail stays: the
    // wizard still draws its frame into a pipe, and a line without one falls
    // outside it there exactly as it would on a terminal.
    input.sink.write(`${rail}  ${message}\n`);
    return {
      setMessage(next) {
        message = next;
        input.sink.write(`${rail}  ${next}\n`);
      },
      writeAbove(text) {
        input.sink.write(`${rail}  ${text}\n`);
      },
      stop(final) {
        input.sink.write(`${rail}  ${final}\n`);
      },
      stopAndClear(line) {
        input.sink.write(`${line}\n`);
      },
    };
  }

  // The transcript window. Empty until the first line arrives, so a spinner
  // with no feed behaves exactly as it did before.
  const maxFeed = Math.max(0, input.maxFeedLines ?? 0);
  const feed: string[] = [];
  // Rows currently owned by this spinner: the feed plus its own line.
  let ownedRows = 0;

  /**
   * Cursor back to the first row this spinner drew. Only ever over rows it owns
   * — the sign-in URL and the wizard's own frame sit above them and must never
   * be reached.
   */
  const rewindToTop = (): string => (ownedRows > 1 ? `${ESC}[${ownedRows - 1}A` : "");

  /**
   * What the bracket says: time left when there is a deadline, otherwise time
   * spent. The word "left" is what keeps the two apart — an unlabelled `[4m
   * 12s]` reads as elapsed, which is the opposite of what it would mean.
   */
  const counter = (): string => {
    if (input.deadline !== undefined) {
      const left = Math.round((input.deadline - now()) / 1000);
      if (left > 0) {
        const minutes = Math.floor(left / 60);
        return minutes === 0 ? `${left}s left` : `${minutes}m ${left % 60}s left`;
      }
    }
    const seconds = Math.floor((now() - started) / 1000);
    return seconds < 1 ? "" : `${seconds}s`;
  };

  const draw = (): void => {
    const label = counter();
    // The counter is the terminal's default colour, like the message it follows.
    //
    // It was dim, on the reasoning that it is a detail of the line rather than
    // the line. That was backwards for the only line on screen still moving:
    // during a two-minute agent run or a ten-minute sign-in window the number
    // *is* the information — it is the difference between waiting and suspecting
    // a hang — and dimming it hid the one part of the wizard that answers the
    // question a stalled user is actually asking.
    const elapsed = label === "" ? "" : ` [${label}]`;
    const glyph = FRAMES[frame % FRAMES.length] ?? FRAMES[0];
    // The message keeps the terminal's default colour while the transcript
    // above it is dimmed. Both were dim, which made the live line — the only
    // thing on screen still changing — indistinguishable from the log of what
    // had already happened.
    // Rewind over everything drawn last time, then reprint the window and the
    // spinner. Cursor-up only over rows this spinner drew, so nothing above is
    // ever at risk.
    const rewind = rewindToTop();
    const body = feed.map((line) => `${rail}  ${color.dim(line)}\n`).join("");
    // A rail line between the transcript and the spinner. Without it the live
    // line sits flush against the last thing the agent did and reads as one
    // more entry in the log rather than the status of the whole block.
    const gap = feed.length > 0 ? `${rail}\n` : "";
    input.sink.write(
      `${rewind}${CLEAR_LINE}${CLEAR_BELOW}${body}${gap}${CLEAR_LINE}${color.magenta(glyph)}  ${message}${elapsed}`,
    );
    ownedRows = feed.length + (feed.length > 0 ? 2 : 1);
  };

  draw();
  let stopAnimation: (() => void) | null = animate(() => {
    frame += 1;
    draw();
  });

  return {
    setMessage(next) {
      message = next;
      draw();
    },
    writeAbove(text) {
      if (maxFeed === 0) {
        // No window configured: commit the line permanently, as before.
        input.sink.write(`${CLEAR_LINE}${rail}  ${color.dim(text)}\n`);
        draw();
        return;
      }
      feed.push(text);
      while (feed.length > maxFeed) {
        feed.shift();
      }
      draw();
    },
    stop(final) {
      stopAnimation?.();
      stopAnimation = null;
      // The settled line takes the rail, so it joins the wizard's frame rather
      // than leaving a stray spinner frame on screen.
      input.sink.write(`${CLEAR_LINE}${rail}  ${final}\n`);
    },
    stopAndClear(line) {
      stopAnimation?.();
      stopAnimation = null;
      // Back to the top of the block, wipe everything from there down, print
      // the one line that survives it. `[0J` reaches the feed rows below the
      // cursor as well as the spinner's own, so the whole transcript goes in a
      // single write and never flickers.
      input.sink.write(`${rewindToTop()}${CLEAR_LINE}${CLEAR_BELOW}${line}\n`);
      feed.length = 0;
      ownedRows = 0;
    },
  };
}
