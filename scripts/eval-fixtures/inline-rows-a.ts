// An inline dataset: a plain list of two rows, with no case ids.
import { Evaluation, type ScorerContext } from "@traceroot-ai/traceroot";

function toUpper(word: string): string {
  return word.toUpperCase();
}

function exact_match(ctx: ScorerContext): boolean {
  return ctx.output === ctx.expected;
}

export const evaluation = new Evaluation({
  name: "uppercase",
  dataset: [
    { input: "alpha", expected: "ALPHA" },
    { input: "beta", expected: "BETA" },
  ],
  task: toUpper,
  scorers: [exact_match],
});
