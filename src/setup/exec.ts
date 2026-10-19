import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { win32 as windowsPath } from "node:path";
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
  /** True when the program could not be spawned at all (ENOENT). */
  spawnFailed: boolean;
}

/** Injectable process runner, so every stage that shells out stays testable. */
export type RunProcess = (options: RunProcessOptions) => Promise<RunProcessResult>;

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
 * The extensions `PATHEXT` lists when the environment does not say.
 *
 * Windows' own default, in its own order, because the order is the answer to
 * "which of these did the user mean": a `node.exe` beside a `node.cmd` is what
 * their shell would have run, so it is what this runs.
 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * The extensions `CreateProcess` cannot start, so a shell has to.
 *
 * `npm`, `pnpm`, `yarn` and `npx` are batch shims on Windows. A shell-less
 * spawn of the bare name never finds one, and since the CVE-2024-27980 fix
 * (Node 18.20.2 / 20.12.2) spawning one by its full name without a shell is
 * refused outright. Without the branch below, every Node project on Windows got
 * a verification that could not be run at all and a report that blamed the
 * project's own check for it.
 */
const BATCH_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

/**
 * Characters that break the quoting of the program's own path.
 *
 * Every token on the command line below is double-quoted, and inside a quoted
 * run cmd.exe leaves `& | < > ( ) ^` alone — which the program's path needs,
 * because `C:\Program Files (x86)\nodejs\npm.cmd` is where a great many
 * Windows installs put it. What a quoted run does not survive is a `"` or a
 * newline, which end it and hand what follows back to the parser, a `%VAR%`,
 * which is still expanded there, or a trailing backslash, which escapes the
 * closing quote for whatever parses the line next.
 */
const CMD_UNSAFE_PATH = /["%!\r\n]/;

/**
 * Characters an argument is refused for rather than escaped.
 *
 * Stricter than the path, because an argument is the part that can have come
 * out of the customer's repository and because a shim is a batch file: its own
 * `%*` is a second pass over this line, so "safe inside quotes" has to hold
 * through two parsers rather than one. Refusing every character either of them
 * acts on keeps the guarantee {@link splitCommand} exists for — no value from a
 * manifest is ever re-interpreted by a shell — and costs nothing, because what
 * reaches this is a package manager's subcommand.
 */
const CMD_UNSAFE_ARGUMENT = /["%!^&|<>()\r\n]/;

/** How `spawn` has to be called for a program, once the platform is accounted for. */
export interface SpawnTarget {
  program: string;
  args: readonly string[];
  /**
   * True only for the cmd.exe form, whose command line is quoted here: letting
   * Node quote it a second time nests the quotes and runs nothing.
   */
  windowsVerbatimArguments: boolean;
}

/** Injected, so both Windows branches are reachable from a test on a POSIX host. */
export interface SpawnLookup {
  platform?: NodeJS.Platform;
  /** The child's own environment — its PATH is what resolves the program for it. */
  env?: NodeJS.ProcessEnv;
  /** The child's working directory, which a relative program path is relative to. */
  cwd?: string;
  isFile?: (path: string) => boolean;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A `;`-separated Windows list, with the quotes a PATH entry may carry removed.
 */
function splitWindowsList(value: string): string[] {
  return value
    .split(";")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter((part) => part !== "");
}

/**
 * One environment variable by name, case-insensitively.
 *
 * Every spelling of `PATH` is the same variable on Windows, which a plain
 * object copy of an environment cannot represent — it can carry both `Path` and
 * `PATH` — so reading one spelling would miss the value the child will actually
 * be given.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted && value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * Where `program` actually lives, or null when nothing on PATH answers to it.
 *
 * Only a bare name is searched for. A name that says where it is is taken at
 * its word — from the child's working directory when it is relative, because
 * that is where the spawn will look for it — and a name that already carries an
 * extension is not given another.
 */
function resolveWindowsProgram(
  program: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  isFile: (path: string) => boolean,
): string | null {
  const named = windowsPath.extname(program) !== "";
  const spellings = named
    ? [program]
    : splitWindowsList(envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).map(
        (ext) => `${program}${ext}`,
      );
  if (windowsPath.isAbsolute(program)) {
    return spellings.find((candidate) => isFile(candidate)) ?? null;
  }
  if (/[\\/]/.test(program)) {
    const from = cwd ?? process.cwd();
    return (
      spellings
        .map((candidate) => windowsPath.join(from, candidate))
        .find((candidate) => isFile(candidate)) ?? null
    );
  }
  for (const dir of splitWindowsList(envValue(env, "PATH") ?? "")) {
    for (const candidate of spellings) {
      const full = windowsPath.join(dir, candidate);
      if (isFile(full)) {
        return full;
      }
    }
  }
  return null;
}

/**
 * How a program and its arguments have to be handed to `spawn` here.
 *
 * On POSIX, exactly as they arrived: `execvp` runs what is on PATH and nothing
 * stands between the two. Windows has two problems this answers.
 *
 * A bare name is resolved against PATH × PATHEXT here rather than left to the
 * spawn, because Node's own search on Windows looks in the child's working
 * directory first, and that directory is the customer's repository: a shim
 * checked into it must never be run in preference to the real one. A name
 * nothing on PATH answers to therefore returns null, and the caller reports a
 * failed spawn, rather than reaching Node's search at all. The search uses the
 * child's PATH, not this process's, because the caller composes that PATH to
 * decide what resolves: a virtualenv prepended so `pytest` is the one inside it
 * is exactly why a caller composes that environment at all.
 *
 * A name that resolves to a batch shim is then spawned through `ComSpec` with
 * `/d /s /c` and a command line built here, because Node refuses to start one
 * without a shell. `/s` strips the outer quote pair, so the inner line arrives
 * at cmd.exe as written. Returns null instead when that line would carry a
 * character cmd.exe re-interprets ({@link CMD_UNSAFE_PATH},
 * {@link CMD_UNSAFE_ARGUMENT}): the caller reports a failed spawn rather than
 * running an approximation of what it was asked for.
 *
 * The group kill above stays POSIX-only, so on Windows the shim's own child
 * outlives a timeout exactly as any grandchild already did.
 */
export function resolveSpawnTarget(
  program: string,
  args: readonly string[],
  lookup: SpawnLookup = {},
): SpawnTarget | null {
  const unchanged: SpawnTarget = { program, args, windowsVerbatimArguments: false };
  if ((lookup.platform ?? process.platform) !== "win32") {
    return unchanged;
  }
  const env = lookup.env ?? process.env;
  const resolved = resolveWindowsProgram(program, env, lookup.cwd, lookup.isFile ?? isRegularFile);
  if (resolved === null) {
    // Nothing on PATH answers to it. Refused rather than passed through: given
    // the bare name, Node's own search tries the repository first, and would
    // run the very shim the search above exists to skip.
    return null;
  }
  if (!BATCH_EXTENSIONS.has(windowsPath.extname(resolved).toLowerCase())) {
    return { program: resolved, args, windowsVerbatimArguments: false };
  }
  const unsafe = (token: string, pattern: RegExp): boolean =>
    pattern.test(token) || token.endsWith("\\");
  if (unsafe(resolved, CMD_UNSAFE_PATH) || args.some((arg) => unsafe(arg, CMD_UNSAFE_ARGUMENT))) {
    return null;
  }
  const line = [resolved, ...args].map((token) => `"${token}"`).join(" ");
  return {
    // cmd.exe lives in system32, which is on every Windows PATH, so the
    // fallback is a name the spawn can still resolve.
    program: envValue(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
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
    const secrets = options.secrets ?? [];

    /** Keeps decoded text for `output`, and streams it to `onData` as it arrives. */
    const append = (text: string): void => {
      if (text === "") {
        return;
      }
      chunks += text;
      // Redacted per chunk as well as in `output`: a caller renders these
      // straight to the terminal, so an unscrubbed chunk is a visible leak.
      options.onData?.(redact(text, secrets));
    };

    // Only captured runs are detached. `inherit` hands the terminal to an
    // interactive agent, and a new session would take that child out of the
    // terminal's foreground group: Ctrl+C would stop reaching it and it would
    // be racing the CLI for stdin. A captured child has no stake in the
    // terminal, so its own group costs nothing and is what makes the kill
    // reach the grandchildren that hold the pipes open.
    const detached = capture && POSIX;

    const spawnFailure = (): RunProcessResult => ({
      exitCode: 127,
      output: "",
      durationMs: Date.now() - started,
      timedOut: false,
      spawnFailed: true,
    });

    // Resolved against the environment and directory the child is being given,
    // which is where the caller put the program it expects to run.
    const target = resolveSpawnTarget(options.program, options.args, {
      env: options.env,
      cwd: options.cwd,
    });
    if (target === null) {
      // Refused rather than approximated: see `resolveSpawnTarget`. Reported as a failed
      // spawn, which is what it is — the command was never run.
      return resolve(spawnFailure());
    }

    let child: ChildProcess;
    try {
      child = spawn(target.program, target.args, {
        cwd: options.cwd,
        env: options.env,
        detached,
        windowsVerbatimArguments: target.windowsVerbatimArguments,
        stdio: capture
          ? [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
          : [options.stdin === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      });
    } catch {
      return resolve(spawnFailure());
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

    const finish = (exitCode: number, spawnFailed = false): void => {
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
        append(decoder.end());
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
        output: redact(chunks, secrets),
        durationMs: Date.now() - started,
        timedOut,
        spawnFailed,
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
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        decoders.push(decoder);
        stream?.on("data", (buf: Buffer) => append(decoder.write(buf)));
      }
    }

    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {
        // A child that exits before reading stdin yields EPIPE; not an error.
      });
      child.stdin?.end(options.stdin);
    }

    child.on("error", () => {
      if (!hasProcess()) {
        // A failure to start. `spawn` reports EACCES, EAGAIN, EMFILE, ENFILE
        // and ENOENT on this event rather than throwing, and the child it hands
        // back for those never gets a pid — which is what tells them apart from
        // everything below.
        finish(127, true);
        return;
      }
      // This child started, so whatever went wrong is not a failure to start.
      // Node emits `error` for a `kill` the kernel refused as well — EPERM for
      // a child that re-execed something setuid, say — and the timeout and
      // abort paths here both kill. Recording that as a spawn failure told the
      // user their command was not installed while it was still running.
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
