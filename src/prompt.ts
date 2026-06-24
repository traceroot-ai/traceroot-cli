import { createInterface } from "node:readline";
import { type Sink, colorEnabled } from "./output.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

/** Asks one question and resolves with the typed line. Injectable in tests. */
export type Prompt = (question: string) => Promise<string>;

/**
 * Dims text for prompt strings (e.g. the `(default: …)` hint) when the
 * destination supports color. Defaults to `process.stdout`, where prompts are
 * shown; a no-op when piped or `NO_COLOR` is set, so non-TTY/test output stays
 * plain.
 */
export function dim(text: string, sink: Sink = process.stdout): string {
  return colorEnabled(sink) ? `${ANSI_DIM}${text}${ANSI_RESET}` : text;
}

/**
 * True when both stdin and stdout are TTYs — the condition under which the CLI
 * may prompt for missing values (mirrors `login`'s interactivity check). In
 * non-interactive or piped contexts this is false and callers fail fast instead.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Production prompt: a visible readline question on stdout (same style as `login`). */
export const readLine: Prompt = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

/**
 * Asks a `y/N` confirmation. Returns true only for an explicit `y`/`yes`
 * (case-insensitive); empty input, `n`, and `no` return false — so the safe
 * (non-destructive) choice is the default.
 */
export async function confirm(question: string, prompt: Prompt): Promise<boolean> {
  const answer = (await prompt(question)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
