/**
 * Starts an SDK eval runner and reads what its run came to.
 *
 * The runner is the lookup's command, spawned without a shell through `runProcess`, which runs it
 * in a process group of its own. It writes its events to a file in a temporary folder this module
 * creates and always removes: a file rather than stdout, so an evaluation that prints can't corrupt
 * the stream, and rather than an inherited descriptor, so nothing differs by platform. The file is
 * read once the runner has exited, because the runner's exit status alone doesn't say whether the
 * run worked (see {@link outcomeOf}).
 *
 * On a terminal, the file is also read while the runner runs, for the progress line (see
 * progress-line.ts). That read only feeds the line: what the run came to is still decided by the
 * read after the runner has exited, from the whole file.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "../output.js";
import { terminalColumns } from "../render/wrap.js";
import { runProcess } from "../setup/exec.js";
import { type Secret, redact } from "../setup/secret.js";
import { type InterruptSignal, type RunOutcome, outcomeOf } from "./events.js";
import { filterNotices } from "./notices.js";
import { type ProgressLine, type ProgressLineOptions, startProgressLine } from "./progress-line.js";
import { type EventWatch, watchEventFile } from "./tail.js";

/** How long the runner has after the first Ctrl+C before its process group is killed. */
export const INTERRUPT_GRACE_MS = 10_000;

/** How many of the runner's last output lines a crash carries. */
const OUTPUT_TAIL_LINES = 20;

/**
 * The signals that cancel a run: Ctrl+C, a request to stop, and a closed terminal. `runProcess`
 * forwards each of the three to the runner's process group.
 */
const INTERRUPT_SIGNALS: readonly InterruptSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * What a local run sets in the runner's environment, whatever the CLI's own holds. `undefined`
 * removes a variable.
 *
 * No API key, no session token, tracing off and reporting off, so neither the runner nor the
 * evaluation's own code has a credential to reach TraceRoot with. `TRACEROOT_TOKEN` is the CLI's
 * own sign-in, which can mint access tokens.
 */
const LOCAL_RUN: Readonly<Record<string, string | undefined>> = {
  TRACEROOT_API_KEY: undefined,
  TRACEROOT_TOKEN: undefined,
  TRACEROOT_ENABLED: "false",
  TRACEROOT_EVAL_OPTIONS: "{}",
};

/** Where a run that is uploaded goes: a TraceRoot host, and a project API key for it. */
export interface UploadTarget {
  /** The host, as the CLI resolved it. */
  host: string;
  apiKey: Secret;
}

/**
 * What an uploaded run sets instead: the project API key and its host, reporting on, and tracing
 * on, so a TRACEROOT_ENABLED=false left in the environment can't drop the cases' traces. The
 * project API key is the one credential it gets: the CLI's session token is still removed.
 */
function uploadedRun(target: UploadTarget): Record<string, string | undefined> {
  return {
    TRACEROOT_API_KEY: target.apiKey.reveal(),
    TRACEROOT_TOKEN: undefined,
    TRACEROOT_HOST_URL: target.host,
    TRACEROOT_ENABLED: "true",
    TRACEROOT_EVAL_OPTIONS: JSON.stringify({ reporting: true }),
  };
}

/**
 * The runner's environment: the CLI's own, with the variables that decide what the run may reach
 * replaced, and the event file named.
 *
 * Without an event file, it is the environment for a process the CLI starts before the runner,
 * such as the lookup's Python version probe: the same replacements, and no event file.
 *
 * @param parent the CLI's environment, which is not modified.
 * @param upload where the run is uploaded to; without it, the run stays on this machine.
 */
export function runnerEnv(
  parent: NodeJS.ProcessEnv,
  eventFile?: string,
  upload?: UploadTarget,
): NodeJS.ProcessEnv {
  const run = upload === undefined ? LOCAL_RUN : uploadedRun(upload);
  return withVariables(parent, { ...run, TRACEROOT_EVAL_EVENT_FILE: eventFile });
}

export interface RunEvalRunnerOptions {
  /** The runner command from the lookup, program first, spawned as given. */
  argv: readonly string[];
  /**
   * Where the runner runs. Defaults to the CLI's own directory, so the run is saved under
   * `./.traceroot/eval/runs` and the project's own imports resolve.
   */
  cwd?: string;
  /** The CLI's environment, which the runner's is built from (see {@link runnerEnv}). */
  env?: NodeJS.ProcessEnv;
  /**
   * Where the run is uploaded to. Without it the run stays on this machine. With it, the API key is
   * scrubbed from everything the runner writes before the CLI passes it on, a key split across two
   * chunks of its output included.
   */
  upload?: UploadTarget;
  /**
   * Where the runner's stdout and stderr both go. Defaults to the CLI's stderr. The output passes on
   * as the runner wrote it, but for the SDK's own Git notice, which is reworded for an uploaded run
   * and left out of a local one (see notices.ts).
   */
  output?: Sink;
  /**
   * Shows a progress line at the bottom of `output` while the runner runs. Give it only when
   * `output` is a terminal that can redraw: without it, the runner's output passes straight on, and
   * the event file isn't read until the runner has exited.
   */
  progress?: RunProgressOptions;
  /** How long the runner has after the first Ctrl+C. Defaults to {@link INTERRUPT_GRACE_MS}. */
  interruptGraceMs?: number;
  /**
   * The exit code the CLI ends with in place of 0 if it exits while the runner is still running,
   * as when a reader closes its stdout or stderr early: the run was cut short, so a 0 would read
   * as a run that worked. Without it, the exit code is left as it is.
   */
  earlyExitCode?: number;
}

/** How the progress line is drawn: everything {@link startProgressLine} takes but the sink. */
export interface RunProgressOptions extends Omit<ProgressLineOptions, "sink"> {
  /** How often the event file is read while the runner runs. Defaults to `EVENT_POLL_MS`. */
  pollMs?: number;
}

/**
 * Runs the eval runner to its end and returns what the run came to.
 *
 * While the runner runs, the CLI listens for SIGINT, SIGTERM and SIGHUP itself. `runProcess`
 * forwards the first of them to the runner's process group, and then re-raises it if nothing else
 * is listening, which would end the CLI before it could read the event file or remove it. So:
 * - the first signal reaches the runner, which finishes or drops the case in flight and saves
 *   what ran;
 * - if the runner is still running when the grace period ends, or on a second signal, its process
 *   group is killed through `runProcess`'s abort signal: SIGTERM, then SIGKILL two seconds later
 *   for anything still running;
 * - either way the event file is read and removed, and the outcome is `interrupted`, carrying the
 *   first signal.
 *
 * The CLI can also end before this returns: through `process.exit`, as when a reader closes the
 * CLI's stdout or stderr early (EPIPE), through an uncaught exception, or through SIGQUIT (Ctrl+\).
 * The runner's process group is its own, so nothing else would stop it. While it runs, an `exit`
 * listener and a SIGQUIT listener send SIGKILL to that group and remove the event folder. SIGKILL
 * and not the abort's SIGTERM: the abort's SIGKILL waits on a timer, which never fires once the CLI
 * is exiting, so a runner that ignores SIGTERM would outlive it. SIGQUIT then ends the CLI as it
 * would have. An exit with code 0 ends with {@link RunEvalRunnerOptions.earlyExitCode} instead,
 * when one is given.
 *
 * The listeners stay until the event file is removed, so no signal can end the CLI between the
 * runner's exit and the removal, and are gone when this returns.
 *
 * With {@link RunEvalRunnerOptions.progress}, every one of those ends also stops reading the event
 * file, before its folder is removed, and erases the progress line. On the first interrupt, the
 * line says the run is stopping.
 */
export async function runEvalRunner(options: RunEvalRunnerOptions): Promise<RunOutcome> {
  const [program, ...args] = options.argv;
  if (program === undefined) {
    throw new Error("runEvalRunner needs a runner command");
  }
  const output = options.output ?? process.stderr;
  const secrets = options.upload === undefined ? [] : [options.upload.apiKey];
  let line: ProgressLine | undefined;
  let watch: EventWatch | undefined;
  // Through the progress line while there is one, which writes whole lines above itself.
  const notices = filterNotices(
    (text) => {
      if (line === undefined) {
        output.write(text);
      } else {
        line.write(text);
      }
    },
    () => terminalColumns(output),
    options.upload !== undefined,
  );
  const scrubbed = redactAcrossChunks((text) => notices.write(text), secrets);
  const interrupts = listenForInterrupts(options.interruptGraceMs ?? INTERRUPT_GRACE_MS, () =>
    line?.stopping(),
  );
  let folder: string | undefined;
  let signalRunner: ((name: NodeJS.Signals) => void) | undefined;
  const exits = listenForExit(() => {
    signalRunner?.("SIGKILL");
    watch?.stop();
    if (folder !== undefined) {
      removeFolder(folder);
    }
    line?.end();
  }, options.earlyExitCode);
  try {
    folder = mkdtempSync(join(tmpdir(), "traceroot-eval-"));
    const eventFile = join(folder, "events.jsonl");
    if (options.progress !== undefined) {
      const { pollMs, ...drawing } = options.progress;
      const shown = startProgressLine({ ...drawing, sink: output });
      line = shown;
      watch = watchEventFile(eventFile, (lines) => shown.events(lines), pollMs);
    }
    const result = await runProcess({
      program,
      args,
      cwd: options.cwd ?? process.cwd(),
      env: runnerEnv(options.env ?? process.env, eventFile, options.upload),
      stdio: "capture",
      onData: (chunk) => scrubbed.write(chunk),
      signal: interrupts.signal,
      onSpawn: (signal) => {
        signalRunner = signal;
      },
      secrets,
    });
    scrubbed.flush();
    notices.flush();
    // A runner's `fatal` message is printed too, so it is scrubbed like its output.
    return outcomeOf(redact(readEvents(eventFile), secrets), {
      status: result.exitCode,
      signal: interrupts.received(),
      outputTail: lastLines(result.output, OUTPUT_TAIL_LINES),
    });
  } finally {
    watch?.stop();
    line?.end();
    if (folder !== undefined) {
      removeFolder(folder);
    }
    exits.stop();
    interrupts.stop();
  }
}

interface InterruptListener {
  /** Aborted when the runner's process group is to be killed. */
  signal: AbortSignal;
  /** The first of the signals to arrive, if any has. */
  received(): InterruptSignal | null;
  /** Removes the listeners and clears the deadline. */
  stop(): void;
}

/**
 * Listens for {@link INTERRUPT_SIGNALS}. The first one starts the grace period and calls `onFirst`,
 * and the end of the grace period or a second signal, of any of the three, aborts
 * {@link InterruptListener.signal}.
 *
 * Registered before the runner is spawned, so these listeners are already there when `runProcess`
 * checks whether anything else handles the signal.
 */
function listenForInterrupts(graceMs: number, onFirst: () => void): InterruptListener {
  const controller = new AbortController();
  let received: InterruptSignal | null = null;
  let deadline: NodeJS.Timeout | undefined;
  const onSignal = (signal: InterruptSignal): void => {
    if (received !== null) {
      controller.abort();
      return;
    }
    received = signal;
    deadline = setTimeout(() => controller.abort(), graceMs);
    onFirst();
  };
  // One handler per signal, so each knows which signal it is for.
  const handlers = INTERRUPT_SIGNALS.map((signal) => [signal, () => onSignal(signal)] as const);
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  return {
    signal: controller.signal,
    received: () => received,
    stop: () => {
      clearTimeout(deadline);
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    },
  };
}

/**
 * Calls `cleanUp` when the CLI is about to end without the runner's outcome: on `exit`, or on
 * SIGQUIT, which is re-raised once `cleanUp` has run and the listeners are removed, so it still ends
 * the CLI unless something else handles it. `cleanUp` must be synchronous, because an `exit`
 * listener can't wait. `stop` removes both listeners.
 *
 * On an exit with code 0, `earlyExitCode`, when given, becomes the code the CLI ends with: Node
 * reads `process.exitCode` once the `exit` listeners have run. Any other code is left as it is.
 *
 * Registered before the event folder exists, so a SIGQUIT can't end the CLI between its creation
 * and these listeners.
 */
function listenForExit(cleanUp: () => void, earlyExitCode: number | undefined): { stop(): void } {
  const onExit = (code: number): void => {
    cleanUp();
    if (code === 0 && earlyExitCode !== undefined) {
      process.exitCode = earlyExitCode;
    }
  };
  const onQuit = (): void => {
    cleanUp();
    stop();
    if (process.listenerCount("SIGQUIT") === 0) {
      process.kill(process.pid, "SIGQUIT");
    }
  };
  const stop = (): void => {
    process.off("exit", onExit);
    process.off("SIGQUIT", onQuit);
  };
  process.on("exit", onExit);
  process.on("SIGQUIT", onQuit);
  return { stop };
}

/** Where the runner's output goes once its secrets are scrubbed. */
interface ScrubbedOutput {
  /** Takes the next chunk of the runner's output. */
  write(chunk: string): void;
  /** Passes on what is held back, once the runner has ended. */
  flush(): void;
}

/**
 * Passes the runner's output to `write` with every secret redacted, a secret that two chunks split
 * between them included. `runProcess` redacts each chunk on its own, which misses a secret that
 * crosses a read boundary. So the end of each chunk that a secret could start at, the longest such
 * end (see {@link secretStartAtEnd}), is held back until the next chunk or
 * {@link ScrubbedOutput.flush} shows whether the rest of the secret follows. Any other text passes
 * on at once, so the last line the runner wrote shows while it works. The text and its order are
 * otherwise unchanged: a character written as two UTF-16 units is never cut between them, so a sink
 * that encodes each write gets whole characters.
 */
function redactAcrossChunks(
  write: (text: string) => void,
  secrets: readonly Secret[],
): ScrubbedOutput {
  let held = "";
  return {
    write: (chunk) => {
      const text = redact(held + chunk, secrets);
      let cut = text.length - secretStartAtEnd(text, secrets);
      if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) {
        cut -= 1;
      }
      held = text.slice(cut);
      if (cut > 0) {
        write(text.slice(0, cut));
      }
    },
    flush: () => {
      if (held !== "") {
        write(held);
      }
      held = "";
    },
  };
}

/**
 * How many characters at the end of `text` a secret could start at: the length of the longest end
 * of it that is the start of one of `secrets`, short of the whole secret, or 0 when none is. A
 * secret that crosses into the next chunk always leaves such an end behind.
 */
function secretStartAtEnd(text: string, secrets: readonly Secret[]): number {
  let longest = 0;
  for (const secret of secrets) {
    const value = secret.reveal();
    for (let length = Math.min(text.length, value.length - 1); length > longest; length -= 1) {
      if (text.endsWith(value.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

/** Whether a UTF-16 unit is the first of the two a character outside the BMP is written as. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * A copy of `env` with each of `changes` set, or removed when its value is undefined.
 *
 * A variable is replaced under every spelling of its name: Windows reads `Traceroot_Api_Key` as
 * `TRACEROOT_API_KEY`, so a key left under another spelling would still reach the runner there.
 */
function withVariables(
  env: NodeJS.ProcessEnv,
  changes: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const replaced = new Set(Object.keys(changes).map((name) => name.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !replaced.has(name.toUpperCase())) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(changes)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

/** The event file's text, or no events when the runner never created it. */
function readEvents(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/** The last `count` lines of `text`, without the blank lines it ends with. */
function lastLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return lines.slice(-count);
}

/**
 * Removes the event file's folder.
 *
 * A failure is left to the system's temp cleanup rather than thrown: this runs in a `finally`,
 * where a throw would replace the run's outcome. On POSIX a file can be removed while another
 * process still has it open. On Windows it can't, and a virus scanner reading the new file is
 * enough to fail the removal for a moment, which is what the retries are for.
 */
function removeFolder(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Left for the system's temp cleanup; see above.
  }
}
