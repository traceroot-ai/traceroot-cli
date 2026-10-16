import { type ChildProcess, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { Secret } from "./secret.js";
import { redact } from "./secret.js";

/** Windows has no process groups, so the group-wide kill below is POSIX-only. */
const POSIX = process.platform !== "win32";

/**
 * How long the stdio pipes may keep draining once the child itself has exited.
 *
 * `close` fires only after every holder of those pipes has closed them, and a
 * grandchild inherits them: `sh -c "sleep 8 & sleep 8"` holds them for the full
 * eight seconds, long past any timeout. So a test command that starts a server
 * or a watcher made the ten-minute verification timeout never fire at all.
 * Settling on `exit` instead needs this grace period, because the pipe can
 * still hold bytes the child wrote just before exiting; whatever has not
 * arrived by then is being written by a survivor this run has given up on.
 */
const DRAIN_GRACE_MS = 250;

/** How long the child has to honour SIGTERM before it is SIGKILLed. */
const KILL_ESCALATION_MS = 2000;

/**
 * The process groups of children spawned `detached`.
 *
 * A detached child leads its own group, which is not the terminal's foreground
 * group, so Ctrl+C no longer reaches it — before this module detached anything,
 * the terminal signalled the CLI's whole group and the child died with the run.
 * Forwarding the signal to these groups restores exactly that, so a cancelled
 * run cannot leave a child behind.
 */
const detachedGroups = new Set<number>();
let forwarding = false;

/**
 * Signals a whole process group, reporting whether anything was there.
 *
 * `process.kill` throws ESRCH once the last member has exited, which is the
 * ordinary case for a kill that races the child's own exit, not an error. With
 * signal 0 this is just an existence probe.
 */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function forwardTerminalSignal(signal: NodeJS.Signals): void {
  for (const pgid of detachedGroups) {
    signalGroup(pgid, signal);
  }
  detachedGroups.clear();
  stopForwarding();
  if (process.listenerCount(signal) === 0) {
    // Nothing else handles it, so Node would have terminated the CLI on
    // delivery. Re-raise now that this handler is out of the way, so Ctrl+C
    // still ends the run with the status it always had instead of being
    // swallowed here.
    process.kill(process.pid, signal);
  }
}

const terminalHandlers: ReadonlyMap<NodeJS.Signals, () => void> = new Map(
  (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [
    signal,
    () => forwardTerminalSignal(signal),
  ]),
);

function startForwarding(): void {
  if (forwarding) {
    return;
  }
  forwarding = true;
  for (const [signal, handler] of terminalHandlers) {
    process.on(signal, handler);
  }
}

function stopForwarding(): void {
  if (!forwarding) {
    return;
  }
  forwarding = false;
  for (const [signal, handler] of terminalHandlers) {
    process.off(signal, handler);
  }
}

export interface RunProcessOptions {
  program: string;
  args: string[];
  cwd: string;
  /**
   * The child's complete environment. Callers build this explicitly rather than
   * mutating `process.env`, so a credential handed to one child never leaks into
   * the parent or into any later child.
   */
  env: NodeJS.ProcessEnv;
  /** Text piped to the child's stdin, when it takes its input that way. */
  stdin?: string;
  /** `inherit` hands the terminal to the child (interactive agents). */
  stdio: "inherit" | "capture";
  /**
   * Called with each captured chunk as it arrives.
   *
   * Capture alone buffers until exit, which is useless for a long-running
   * agent: the interesting part is what it is doing *now*. This lets a caller
   * render progress without giving the child the terminal.
   */
  onData?: (chunk: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Secrets scrubbed from captured output, as a defence in depth. */
  secrets?: readonly Secret[];
}

export interface RunProcessResult {
  exitCode: number;
  /** Combined stdout+stderr; empty when `stdio` is `inherit`. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * True when the program could not be started at all — the `spawn` call threw,
   * or the child emitted `error` before running. Set for **every** spawn
   * failure, not only a missing program: `EACCES` on a file that exists but is
   * not executable lands here too, which is why {@link spawnErrorCode} carries
   * the reason rather than letting callers assume one.
   */
  spawnFailed: boolean;
  /**
   * The error code behind a spawn failure — usually libuv's (`ENOENT` for a
   * program that is not on `PATH`, `EACCES` for one that cannot be executed),
   * but a synchronous `spawn` throw can carry a Node-internal one instead,
   * such as `ERR_INVALID_ARG_VALUE` for a NUL byte in an argument. Undefined
   * when the child started, and when the failure carried no code.
   *
   * A caller rendering this to a user should name the causes it knows and say
   * only that it could not start the program for the rest, rather than mapping
   * an unfamiliar code onto the nearest familiar remedy.
   */
  spawnErrorCode?: string;
}

/** Injectable process runner, so every stage that shells out stays testable. */
export type RunProcess = (options: RunProcessOptions) => Promise<RunProcessResult>;

/**
 * The code off a spawn error, when it carries one.
 *
 * Node puts it on `error.code` as a string — libuv's for a failure to exec,
 * its own `ERR_*` for an argument it rejected before trying. Anything without
 * one is a failure this module has nothing specific to say about, and callers
 * render it as such rather than guessing at the most likely cause.
 */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The conventional 128+n for a signalled exit, which has a null code. */
function statusFor(code: number | null, signalName: NodeJS.Signals | null): number {
  if (code !== null) {
    return code;
  }
  // Reporting the signal lets the caller still distinguish "killed" from
  // "exited cleanly", and which signal did it — the timeout and abort paths
  // here send SIGTERM (143), not Ctrl+C (130).
  const number = signalName === null ? undefined : osConstants.signals[signalName];
  return number === undefined ? 1 : 128 + number;
}

/**
 * Runs a child process to completion.
 *
 * Never rejects for a non-zero exit, a missing binary, or a timeout — those are
 * ordinary outcomes for the stages that call this, and each needs to report a
 * different message. Only programmer errors propagate.
 *
 * A timeout or an abort escalates SIGTERM → SIGKILL across the child's whole
 * process group, so a wedged agent cannot hold the terminal indefinitely and
 * cannot survive by way of a grandchild.
 */
export const runProcess: RunProcess = (options) =>
  new Promise<RunProcessResult>((resolve) => {
    const started = Date.now();
    const capture = options.stdio === "capture";
    let settled = false;
    let timedOut = false;
    let exited = false;
    let chunks = "";
    const decoders: StringDecoder[] = [];

    // Only captured runs are detached. `inherit` hands the terminal to an
    // interactive agent, and a new session would take that child out of the
    // terminal's foreground group: Ctrl+C would stop reaching it and it would
    // be racing the CLI for stdin. A captured child has no stake in the
    // terminal, so its own group costs nothing and is what makes the kill
    // reach the grandchildren that hold the pipes open.
    const detached = capture && POSIX;

    let child: ChildProcess;
    try {
      child = spawn(options.program, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached,
        stdio: capture
          ? [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
          : [options.stdin === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      });
    } catch (err) {
      return resolve({
        exitCode: 127,
        output: "",
        durationMs: Date.now() - started,
        timedOut: false,
        spawnFailed: true,
        spawnErrorCode: errorCode(err),
      });
    }

    // A detached child leads a group whose id is its pid. Undefined when the
    // spawn failed outright, in which case there is nothing to signal.
    const pgid = detached ? child.pid : undefined;
    if (pgid !== undefined) {
      detachedGroups.add(pgid);
      startForwarding();
    }

    let drainTimer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const finish = (exitCode: number, spawnFailed = false, spawnErrorCode?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      // Anything the decoders are still holding is a truncated character at the
      // very end of the stream. Flushing keeps it out of `output` rather than
      // dropping bytes silently, and it goes through `onData` as well so the
      // streaming view a caller rendered matches the `output` it is handed: a
      // process that ends mid-character would otherwise leave the two differing
      // by exactly the flushed text.
      for (const decoder of decoders) {
        const tail = decoder.end();
        if (tail === "") {
          continue;
        }
        chunks += tail;
        if (options.onData !== undefined) {
          options.onData(redact(tail, options.secrets ?? []));
        }
      }
      clearTimeout(timer);
      clearTimeout(drainTimer);
      // The escalation is the one timer this does not always clear, because it
      // is the one timer whose job starts here: see `kill`. It goes only when
      // nothing is left for it to reach, so an ordinary kill — the group died on
      // SIGTERM — still ends the process without a two-second tail.
      if (escalation !== undefined && !stillRunning()) {
        clearTimeout(escalation);
      }
      if (pgid !== undefined) {
        detachedGroups.delete(pgid);
        if (detachedGroups.size === 0) {
          stopForwarding();
        }
      }
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        output: redact(chunks, options.secrets ?? []),
        durationMs: Date.now() - started,
        timedOut,
        spawnFailed,
        spawnErrorCode,
      });
    };

    /**
     * Whether a process was ever started, which both checks below have to ask.
     *
     * A failed spawn still hands back a child object, but one with no pid, and
     * it emits `error` with no `exit` to follow — so neither check can be read
     * straight off the child. `child.kill` on it reaches `kill(0, …)`, which
     * signals the CLI's OWN process group rather than a child; and `exited`
     * never becomes true, which read a child that never existed as live and so
     * left the escalation armed with nothing for it to reach.
     */
    const hasProcess = (): boolean => child.pid !== undefined;

    /**
     * Signals the child, and on POSIX its whole process group.
     *
     * `child.kill` reaches only the direct child, so a grandchild survived it
     * and kept both the work and the stdio pipes alive.
     */
    const signalChild = (signal: NodeJS.Signals): void => {
      if (!hasProcess()) {
        return;
      }
      if (pgid !== undefined) {
        signalGroup(pgid, signal);
        return;
      }
      child.kill(signal);
    };

    /** True while anything this run started is still running. */
    const stillRunning = (): boolean => {
      if (!hasProcess()) {
        return false;
      }
      return pgid === undefined ? !exited : signalGroup(pgid, 0);
    };

    const kill = (): void => {
      signalChild("SIGTERM");
      // One escalation per run, however many ways the kill arrives: a timeout
      // and an abort can both fire, and each sends its own SIGTERM, but the
      // deadline for honouring the first one is the deadline.
      if (escalation !== undefined) {
        return;
      }
      // Referenced, which every other timer here is not, and deliberately
      // outliving the promise. The promise settles DRAIN_GRACE_MS after the
      // direct child exits, and that is precisely the moment a grandchild which
      // ignored SIGTERM is still running — so an unreferenced timer lets Node
      // exit first whenever nothing else is holding the CLI open, which is what
      // the end of a run looks like, and the survivor this kill was meant to
      // end outlives the CLI. `finish` releases it as soon as the group is
      // gone.
      escalation = setTimeout(() => {
        // Gated on the group rather than on the promise: the promise now
        // settles shortly after the direct child exits, which is exactly when
        // a grandchild that ignored SIGTERM is still running and still needs
        // escalating.
        if (stillRunning()) {
          signalChild("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
    };

    const onAbort = (): void => {
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      // Already aborted before this child existed, so the listener above will
      // never fire and nothing else would ever stop it. The run-wide signal is
      // shared by every stage that shells out, so this is the ordinary case
      // after a cancellation mid-run.
      kill();
    }

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs);
    timer?.unref?.();

    if (capture) {
      // A decoder per stream, not `buf.toString("utf8")` per chunk: a multi-byte
      // character can straddle a chunk boundary, and decoding each chunk
      // independently replaces the split character with U+FFFD. That corrupts a
      // non-ASCII path in `git status -z` output, so `changedFiles` reports a path
      // the worktree does not have. Separate decoders because stdout and stderr
      // arrive interleaved and share this callback — one decoder would splice the
      // two streams' partial characters together.
      const absorb = (decoder: StringDecoder) => (buf: Buffer) => {
        const text = decoder.write(buf);
        if (text === "") {
          return;
        }
        chunks += text;
        // Redacted per chunk as well as in `output`: a caller renders these
        // straight to the terminal, so an unscrubbed chunk is a visible leak.
        if (options.onData !== undefined) {
          options.onData(redact(text, options.secrets ?? []));
        }
      };
      decoders.push(new StringDecoder("utf8"), new StringDecoder("utf8"));
      child.stdout?.on("data", absorb(decoders[0] as StringDecoder));
      child.stderr?.on("data", absorb(decoders[1] as StringDecoder));
    }

    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {
        // A child that exits before reading stdin yields EPIPE; not an error.
      });
      child.stdin?.end(options.stdin);
    }

    child.on("error", (err) => {
      if (child.pid === undefined) {
        // A failure to start. `spawn` reports EACCES, EAGAIN, EMFILE, ENFILE
        // and ENOENT on this event rather than throwing, and the child it hands
        // back for those never gets a pid — which is what tells them apart from
        // everything below.
        finish(127, true, errorCode(err));
        return;
      }
      // This child started, so whatever went wrong is not a failure to start.
      // Node emits `error` for a `kill` the kernel refused as well — EPERM for
      // a child that re-execed something setuid, say — and the timeout and
      // abort paths here both kill. Recording that code as a spawn failure told
      // the user their command was not installed while it was still running.
      if (exited) {
        // `exit` has already fired and the real status is on its way out
        // through the drain path below. Settling here would replace it with a
        // failure that did not happen.
        return;
      }
      // Still running, and now known to be unsignallable: `exit` is the only
      // other way out of this promise, so settling is what keeps a child that
      // cannot be stopped from hanging the run. `timedOut` still says why the
      // signal was sent, and `spawnFailed` stays false, so no caller reports a
      // command that never ran. The escalation to SIGKILL is already queued and
      // may still land.
      finish(1);
    });
    child.on("exit", (code, signalName) => {
      exited = true;
      const status = statusFor(code, signalName);
      if (!capture) {
        finish(status);
        return;
      }
      // `close` below is the normal settle path and fires within a tick or two
      // of this, which is why the grace period costs an ordinary run nothing.
      // This timer is the backstop for the run where it never fires at all
      // because a survivor is holding the pipes.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        finish(status);
      }, DRAIN_GRACE_MS);
    });
    child.on("close", (code, signalName) => finish(statusFor(code, signalName)));
  });

/**
 * Splits a user-supplied command string into program + args without a shell.
 *
 * Verification commands come out of `package.json`, so they must not be handed
 * to `bash -lc`: that turns a manifest field into arbitrary code execution.
 * Quoted segments are respected; shell metacharacters are not interpreted.
 */
export function splitCommand(command: string): { program: string; args: string[] } | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (const char of command.trim()) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken || current !== "") {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
  }
  if (hasToken || current !== "") {
    tokens.push(current);
  }

  const program = tokens[0];
  if (program === undefined || program === "") {
    return null;
  }
  return { program, args: tokens.slice(1) };
}
