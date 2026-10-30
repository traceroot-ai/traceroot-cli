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
 * `FORCE_COLOR` values that are not a request for color: the empty string, and
 * the two spellings of "off" that the wider ecosystem understands —
 * `FORCE_COLOR=0` is how chalk and supports-color are told to stay plain, so
 * reading it as "yes, color" would paint output for someone who asked for none.
 *
 * They do not switch color off, which stays `NO_COLOR`'s single job; they just
 * do not count as asking for it, and the sink decides as it otherwise would.
 */
const FORCE_COLOR_OFF = new Set(["", "0", "false"]);

/**
 * Whether ANSI color should be applied for the given sink, in three steps.
 *
 * `NO_COLOR`, set to anything at all, means no. It comes first, which is also
 * the answer when both variables are set: they ask for opposite things, and the
 * refusal outranks the request. Obeying `NO_COLOR` too eagerly costs a terminal
 * the color it could have had; obeying `FORCE_COLOR` too eagerly writes escape
 * codes into a file someone has to read. picocolors — the painter every wizard
 * line goes through — settles the same pair the same way, so a single run is
 * never half-painted.
 *
 * `FORCE_COLOR` then means yes, whatever the sink is. This is the clause a
 * caller that is not a terminal needs: a CI runner, a capture that is replayed
 * into one, or a suite that strips the codes back out all render SGR perfectly
 * well, and `isTTY` is false for every one of them. The caller is the only one
 * who knows, so saying so is the whole point of the variable.
 *
 * Otherwise the sink decides: a terminal gets color, a pipe or a file does not.
 */
export function colorEnabled(sink: Sink, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  if (env.FORCE_COLOR !== undefined && !FORCE_COLOR_OFF.has(env.FORCE_COLOR)) {
    return true;
  }
  return sink.isTTY === true;
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

/**
 * Process exit codes by failure class. This is a stable, script-facing contract:
 * scripts can branch on the code to decide whether to retry (network), re-auth
 * (auth), give up (not-found), or fix their invocation (usage). Anything not
 * classified stays `internal` (1).
 */
export const ExitCode = {
  /** Bad invocation: unknown flag/argument, malformed value, missing required input. */
  usage: 2,
  /** Authentication/authorization: HTTP 401/403, or missing local credentials. */
  auth: 3,
  /** The requested resource does not exist: HTTP 404. */
  notFound: 4,
  /** Network failure or timeout — transient; a retry may succeed. */
  network: 5,
  /**
   * The request was understood but conflicts with current state: HTTP 409 (a name
   * already taken, a limit reached, a status that changed since it was read).
   * The remedy is to change what was asked for (another name) or the state it
   * collides with; an immediate retry fails the same way.
   */
  conflict: 6,
  /** Unexpected/internal failure. The default when nothing else applies. */
  internal: 1,
} as const;

/**
 * Maps a numeric exit code to its stable string code for the `--json` error
 * envelope. Unknown codes (including the default 1) map to `"internal"`.
 */
export function exitCodeToString(exitCode: number): string {
  switch (exitCode) {
    case ExitCode.usage:
      return "usage";
    case ExitCode.auth:
      return "auth";
    case ExitCode.notFound:
      return "not_found";
    case ExitCode.network:
      return "network";
    case ExitCode.conflict:
      return "conflict";
    default:
      return "internal";
  }
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
 * Reports an error to stderr without a stack trace and returns the exit code (a
 * {@link CliError}'s `exitCode`, else {@link ExitCode.internal}). Never writes to
 * stdout. In `opts.json` mode a single machine-readable line is written instead
 * of prose: `{"error":{"code":"<class>","message":"<text>"}}`, where `<class>` is
 * the stable string for the exit code. Otherwise the human-readable `error:
 * <message>` line is written (red when color is enabled).
 */
export function reportError(
  err: unknown,
  opts: { json?: boolean } = {},
  w: Writers = defaultWriters,
): number {
  const message = err instanceof Error ? err.message : String(err);
  const code = isCliError(err) ? err.exitCode : ExitCode.internal;
  if (opts.json) {
    // One compact line to stderr; stdout stays empty (the output contract).
    w.err.write(`${JSON.stringify({ error: { code: exitCodeToString(code), message } })}\n`);
  } else {
    w.err.write(`${colorizeError(`error: ${message}`, w.err)}\n`);
  }
  return code;
}
