// The all-pass evaluation, stopped with SIGINT while its second case is running.
//
// The task for "beta" waits for a marker file, so the second case is always in flight when the
// recording script sends SIGINT. The runner lets a case in flight finish after SIGINT, so this
// file releases the case from its own SIGINT listener. The runner registered its listener first,
// so it has always seen the interrupt by the time the case finishes. The wait gives up after a
// minute, so a recording that never sends the signal fails instead of hanging.
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Dataset, Evaluation, type ScorerContext, scorer } from "@traceroot-ai/traceroot";

const MARKER = "release-second-case";

process.once("SIGINT", () => writeFileSync(MARKER, ""));

const words = new Dataset("words");
words.add("alpha", { expected: "ALPHA" });
words.add("beta", { expected: "BETA" });
words.add("gamma", { expected: "GAMMA" });

async function toUpper(word: string): Promise<string> {
  if (word === "beta") {
    const deadline = Date.now() + 60_000;
    while (!existsSync(MARKER)) {
      if (Date.now() > deadline) {
        throw new Error("the second case was never interrupted");
      }
      await sleep(50);
    }
  }
  return word.toUpperCase();
}

function exact_match(ctx: ScorerContext): boolean {
  return ctx.output === ctx.expected;
}

function checkNotEmpty(ctx: ScorerContext): boolean {
  return String(ctx.output).length > 0;
}

export const evaluation = new Evaluation({
  name: "uppercase",
  dataset: words,
  task: toUpper,
  scorers: [exact_match, scorer(checkNotEmpty, { name: "not_empty", version: "2" })],
});
