import { createInterface } from "node:readline";

/** Asks one question and resolves with the typed line. Injectable in tests. */
export type Prompt = (question: string) => Promise<string>;

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
