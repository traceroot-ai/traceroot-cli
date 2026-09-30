import { type ChildProcess, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { Secret } from "./secret.js";
import { redact } from "./secret.js";

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

/**
 * Runs a child process to completion.
 *
 * Never rejects for a non-zero exit, a missing binary, or a timeout — those are
 * ordinary outcomes for the stages that call this, and each needs to report a
 * different message. Only programmer errors propagate.
 *
 * A timeout or an abort escalates SIGTERM → SIGKILL so a wedged agent cannot
 * hold the terminal indefinitely.
 */
export const runProcess: RunProcess = (options) =>
  new Promise<RunProcessResult>((resolve) => {
    const started = Date.now();
    const capture = options.stdio === "capture";
    let settled = false;
    let timedOut = false;
    let chunks = "";
    const decoders: StringDecoder[] = [];

    let child: ChildProcess;
    try {
      child = spawn(options.program, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: capture
          ? [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
          : [options.stdin === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      });
    } catch {
      return resolve({
        exitCode: 127,
        output: "",
        durationMs: Date.now() - started,
        timedOut: false,
        spawnFailed: true,
      });
    }

    const finish = (exitCode: number, spawnFailed = false): void => {
      if (settled) {
        return;
      }
      settled = true;
      // Anything the decoders are still holding is a truncated character at the
      // very end of the stream; flushing keeps it out of `output` rather than
      // dropping bytes silently.
      for (const decoder of decoders) {
        chunks += decoder.end();
      }
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        output: redact(chunks, options.secrets ?? []),
        durationMs: Date.now() - started,
        timedOut,
        spawnFailed,
      });
    };

    const kill = (): void => {
      child.kill("SIGTERM");
      // A child that ignores SIGTERM would otherwise keep the CLI alive.
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 2000).unref?.();
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

    child.on("error", () => finish(127, true));
    child.on("close", (code, signalName) => {
      if (code !== null) {
        finish(code);
        return;
      }
      // A signalled exit has a null code; report the conventional 128+n so the
      // caller can still distinguish "killed" from "exited cleanly", and which
      // signal did it — the timeout and abort paths here send SIGTERM (143),
      // not Ctrl+C (130).
      const number = signalName === null ? undefined : osConstants.signals[signalName];
      finish(number === undefined ? 1 : 128 + number);
    });
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
