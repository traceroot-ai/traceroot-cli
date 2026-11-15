// The inline dataset from inline-rows-a with its second row replaced: same size, other rows.
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
    { input: "delta", expected: "DELTA" },
  ],
  task: toUpper,
  scorers: [exact_match],
});
