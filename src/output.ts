/**
 * Writes a "not implemented" message for the given command to stderr and
 * exits the process with a non-zero status.
 *
 * Scaffold stub for the stdout/stderr contract (filled in by P2-2).
 */
export function notImplemented(command: string): never {
  process.stderr.write(`error: '${command}' is not implemented yet\n`);
  process.exit(1);
}

/** A destination for textual output (stdout/stderr or a test double). */
export interface Sink {
  write(chunk: string): boolean;
  readonly isTTY?: boolean;
}

/** The pair of sinks a command writes to. */
export interface Writers {
  out: Sink;
  err: Sink;
}

/** Production writers backed by the real process streams. */
export const defaultWriters: Writers = { out: process.stdout, err: process.stderr };

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
// Bright (not dark) red — the single error color, matching error spans/rows.
const ANSI_RED = "\x1b[91m";

/**
 * Whether ANSI color should be applied for the given sink: true iff `NO_COLOR`
 * is unset in `env` AND the sink is a TTY.
 */
export function colorEnabled(sink: Sink, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR === undefined && sink.isTTY === true;
}

/**
 * Wraps text in the standard error red when color is enabled for `sink`. The one
 * place error coloring is defined, so every error path (the central handler and
 * commander's own messages) looks identical.
 */
export function colorizeError(text: string, sink: Sink = process.stderr): string {
  return colorEnabled(sink) ? `${ANSI_RED}${text}${ANSI_RESET}` : text;
}

/**
 * Writes a single compact JSON line (one trailing newline) to stdout. Never
 * colors and never touches stderr.
 */
export function writeJson(value: unknown, w: Writers = defaultWriters): void {
  w.out.write(`${JSON.stringify(value)}\n`);
}

/** Writes an informational message to stderr. */
export function logInfo(msg: string, w: Writers = defaultWriters): void {
  w.err.write(`${msg}\n`);
}

/** Writes a progress message to stderr, dimmed when color is enabled. */
export function logProgress(msg: string, w: Writers = defaultWriters): void {
  const text = colorEnabled(w.err) ? `${ANSI_DIM}${msg}${ANSI_RESET}` : msg;
  w.err.write(`${text}\n`);
}

/** Writes a warning to stderr, prefixed with "warning:". */
export function logWarn(msg: string, w: Writers = defaultWriters): void {
  w.err.write(`warning: ${msg}\n`);
}

/** An error carrying a process exit code. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Type guard for {@link CliError}. */
export function isCliError(e: unknown): e is CliError {
  return e instanceof CliError;
}

/**
 * Handles a stream `error` event: exits cleanly (code 0) on `EPIPE` — a
 * downstream reader such as `head` or `jq` closed the pipe early, which is not a
 * failure — and rethrows anything else. Wired to stdout/stderr in {@link run} so
 * a broken pipe never prints a Node stack trace. `exit` is injectable for tests.
 */
export function handlePipeError(
  err: NodeJS.ErrnoException,
  exit: (code: number) => void = process.exit,
): void {
  if (err.code === "EPIPE") {
    exit(0);
    return;
  }
  throw err;
}

/**
 * Reports an error to stderr (red when color is enabled) without a stack trace
 * and returns the exit code (a {@link CliError}'s `exitCode`, else 1). Never
 * writes to stdout.
 */
export function reportError(err: unknown, w: Writers = defaultWriters): number {
  const message = err instanceof Error ? err.message : String(err);
  w.err.write(`${colorizeError(`error: ${message}`, w.err)}\n`);
  return isCliError(err) ? err.exitCode : 1;
}
