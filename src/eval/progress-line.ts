/**
 * The progress line `evals run` keeps at the bottom of a terminal while the runner runs:
 *
 *     ◐  uppercase · 3/10 cases done · 2 running · 1 errored [12s]
 *
 * It only ever owns that one line. It erases it and rewrites it in place, and never moves the
 * cursor up, so nothing the runner printed above it can be torn. The runner's own output still
 * reaches the terminal as the runner wrote it: each complete line goes out above the progress line,
 * which is erased, then the output written, then the line drawn again below it. A line the runner
 * has only partly written is held until its newline, or until the run ends, since the progress line
 * can't be drawn after half a line without joining the two.
 *
 * It is drawn only on a terminal that can redraw (the caller checks); anywhere else the runner's
 * output passes on untouched and nothing here runs. When the run ends, however it ends, the line is
 * erased and leaves nothing behind, so the summary starts where the line was.
 */

import { createColors } from "picocolors";
import type { Sink } from "../output.js";
import { CLEAR_LINE, FRAMES, defaultAnimate } from "../setup/redraw.js";
import {
  type ProgressText,
  type RunProgress,
  advance,
  describeProgress,
  readProgressEvent,
  startingProgress,
} from "./progress.js";

/**
 * Columns kept free of text: the spinner and the two spaces after it, with the spinner counted
 * twice, as a terminal that draws East Asian ambiguous characters wide draws it, and the last
 * column, so a line that fills the terminal can't make it wrap.
 */
const RESERVED_COLUMNS = 5;

/** The fewest columns a shortened evaluation name keeps before the whole line is cut instead. */
const MIN_NAME_COLUMNS = 8;

const ELLIPSIS = "…";

/** The width taken for a terminal that doesn't say how wide it is. */
const DEFAULT_COLUMNS = 80;

export interface ProgressLineOptions {
  /** A terminal that can redraw. */
  sink: Sink;
  /**
   * Whether the runner's `dataset.case_count` is the number of cases it runs, which makes it the
   * total the line shows (see `countsCasesItRuns`).
   */
  exactCount: boolean;
  /** The clock behind the elapsed time; injected so tests are deterministic. */
  now?: () => number;
  /** Starts the animation and returns a stop function; injected for tests. */
  animate?: (tick: () => void) => () => void;
}

export interface ProgressLine {
  /** Takes the event lines the runner finished writing. A line that can't be read is skipped. */
  events(lines: readonly string[]): void;
  /**
   * Takes the runner's output: each complete line goes above the progress line, and the text after
   * the last newline is held until its newline arrives or {@link ProgressLine.end}.
   */
  write(text: string): void;
  /** Says the run is stopping, once it was interrupted. */
  stopping(): void;
  /**
   * Erases the line, stops the animation, and writes the output still held, as it was written.
   * Anything written after it goes straight to the sink. It can be called more than once.
   */
  end(): void;
}

/** Draws the line at once and keeps it up to date until {@link ProgressLine.end}. */
export function startProgressLine(options: ProgressLineOptions): ProgressLine {
  const { sink, exactCount } = options;
  const now = options.now ?? Date.now;
  const started = now();
  // Only ever drawn on a terminal that can redraw, so the spinner is always painted.
  const color = createColors(true);
  let progress: RunProgress = startingProgress();
  let frame = 0;
  let held = "";
  let ended = false;

  const draw = (): void => {
    if (ended) {
      return;
    }
    const glyph = FRAMES[frame % FRAMES.length] ?? FRAMES[0];
    const text = fitLine(describeProgress(progress), elapsed(now() - started), columnsOf(sink));
    sink.write(`${CLEAR_LINE}${color.magenta(glyph)}  ${text}`);
  };

  draw();
  const stopAnimation = (options.animate ?? defaultAnimate)(() => {
    frame += 1;
    draw();
  });

  return {
    events(lines) {
      const before = progress;
      for (const line of lines) {
        const event = readProgressEvent(line);
        if (event !== null) {
          progress = advance(progress, event, exactCount);
        }
      }
      if (progress !== before) {
        draw();
      }
    },
    write(text) {
      if (ended) {
        sink.write(text);
        return;
      }
      held += text;
      const end = held.lastIndexOf("\n");
      if (end === -1) {
        return;
      }
      const lines = held.slice(0, end + 1);
      held = held.slice(end + 1);
      sink.write(`${CLEAR_LINE}${lines}`);
      draw();
    },
    stopping() {
      progress = { ...progress, stopping: true };
      draw();
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      stopAnimation();
      sink.write(`${CLEAR_LINE}${held}`);
      held = "";
    },
  };
}

/**
 * The line's text, cut to fit `columns` so it never wraps: a line that wrapped would leave its
 * first row behind at every redraw. When it is too long, the evaluation's name is shortened first,
 * so the counts stay in view, and only when even a short name doesn't fit is the whole line cut.
 */
export function fitLine(text: ProgressText, elapsedLabel: string, columns: number): string {
  const room = Math.max(1, columns - RESERVED_COLUMNS);
  const rest = elapsedLabel === "" ? text.detail : `${text.detail} [${elapsedLabel}]`;
  if (text.subject === null) {
    return shorten(rest, room);
  }
  const separator = " · ";
  const whole = `${text.subject}${separator}${rest}`;
  if (width(whole) <= room) {
    return whole;
  }
  const forName = room - width(separator) - width(rest);
  if (forName >= MIN_NAME_COLUMNS) {
    return `${shorten(text.subject, forName)}${separator}${rest}`;
  }
  return shorten(whole, room);
}

/**
 * How wide the terminal is. A terminal that reports no size, as a pseudo-terminal opened without
 * one does, reports 0 columns; it is taken to be 80 wide, like a sink that says nothing.
 */
function columnsOf(sink: Sink): number {
  const { columns } = sink as { columns?: number };
  return columns !== undefined && columns > 0 ? columns : DEFAULT_COLUMNS;
}

/** How long the run has been going: `12s`, `3m 4s`, or nothing in its first second. */
export function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) {
    return "";
  }
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

/** `text`, cut to at most `room` columns with an ellipsis when it is longer. */
function shorten(text: string, room: number): string {
  if (width(text) <= room) {
    return text;
  }
  if (room < width(ELLIPSIS)) {
    return "";
  }
  let kept = "";
  let used = 0;
  for (const char of text) {
    const next = used + width(char);
    if (next > room - width(ELLIPSIS)) {
      break;
    }
    kept += char;
    used = next;
  }
  return `${kept}${ELLIPSIS}`;
}

/**
 * The most columns `text` can take: one for each ASCII character and two for any other. That is
 * more than most characters take, but a terminal draws some, such as CJK and emoji, two columns
 * wide, and which ones depends on the terminal, so counting every one as wide is what keeps the
 * line from wrapping on all of them.
 */
function width(text: string): number {
  let columns = 0;
  for (const char of text) {
    columns += (char.codePointAt(0) ?? 0) < 0x80 ? 1 : 2;
  }
  return columns;
}
