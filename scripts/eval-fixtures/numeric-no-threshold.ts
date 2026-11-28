// The all-pass evaluation plus a numeric scorer that declares no threshold.
import { Dataset, Evaluation, type ScorerContext, scorer } from "@traceroot-ai/traceroot";

const words = new Dataset("words");
words.add("alpha", { expected: "ALPHA" });
words.add("beta", { expected: "BETA" });
words.add("gamma", { expected: "GAMMA" });

function toUpper(word: string): string {
  return word.toUpperCase();
}

function exact_match(ctx: ScorerContext): boolean {
  return ctx.output === ctx.expected;
}

function checkNotEmpty(ctx: ScorerContext): boolean {
  return String(ctx.output).length > 0;
}

function output_length(ctx: ScorerContext): number {
  return String(ctx.output).length;
}

export const evaluation = new Evaluation({
  name: "uppercase",
  dataset: words,
  task: toUpper,
  scorers: [exact_match, scorer(checkNotEmpty, { name: "not_empty", version: "2" }), output_length],
});
