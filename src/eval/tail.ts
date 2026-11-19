/**
 * Reads a runner's event file while the runner is still writing it, for the progress line.
 *
 * The outcome never comes from here: the event file is read in full once the runner has exited
 * (see `outcomeOf` in events.ts), and that read alone decides what the run came to. This only says
 * what the runner has done so far, so a line it can't read here costs a moment of progress and
 * nothing else.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** How often the event file is read for new events while the runner runs. */
export const EVENT_POLL_MS = 100;

/** The newline byte. UTF-8 never uses it inside a character, so a line always ends on one. */
const NEWLINE = 0x0a;

export interface EventTail {
  /**
   * The lines the runner has finished writing since the last call, in order, without their
   * newlines. A line is finished once its newline is written: the text after the last newline may
   * be an event the runner is part way through writing, so it is held back until its newline
   * arrives, and every line is returned once.
   */
  read(): string[];
}

/**
 * Follows a file that only grows, from its start. Each read takes the bytes added since the last
 * one, so nothing is read twice. A file that isn't there yet reads as empty: the runner creates it
 * with its first event.
 */
export function tailFile(path: string): EventTail {
  let offset = 0;
  let held: Buffer = Buffer.alloc(0);
  return {
    read() {
      const added = readFrom(path, offset);
      if (added.length === 0) {
        return [];
      }
      offset += added.length;
      const bytes = held.length === 0 ? added : Buffer.concat([held, added]);
      const end = bytes.lastIndexOf(NEWLINE);
      if (end === -1) {
        held = bytes;
        return [];
      }
      // A copy, so the held bytes don't keep the whole read alive.
      held = Buffer.from(bytes.subarray(end + 1));
      return bytes.subarray(0, end).toString("utf8").split("\n");
    },
  };
}

/** The bytes of `path` from `offset` to its current end; none when it isn't there yet. */
function readFrom(path: string, offset: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Buffer.alloc(0);
    }
    throw error;
  }
  try {
    const length = fstatSync(fd).size - offset;
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export interface EventWatch {
  /** Stops reading. Nothing is passed on after it returns. */
  stop(): void;
}

/**
 * Reads the event file every `intervalMs` and passes each batch of finished lines to `onLines`.
 *
 * The timer is unref'd, so it never keeps the CLI running on its own. A read that fails, or an
 * `onLines` that throws, skips that batch's progress and nothing more: the run goes on, and its
 * outcome is read from the whole file afterwards.
 */
export function watchEventFile(
  path: string,
  onLines: (lines: string[]) => void,
  intervalMs: number = EVENT_POLL_MS,
): EventWatch {
  const tail = tailFile(path);
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) {
      return;
    }
    try {
      const lines = tail.read();
      if (lines.length > 0) {
        onLines(lines);
      }
    } catch {
      // Progress only; see above.
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
