// The all-pass evaluation, with the versioned scorer throwing on "beta".
//
// The scorer declares a name that differs from its function name, so the recording shows which of
// the two a throwing scorer is recorded under.
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
  if (ctx.input === "beta") {
    throw new Error(`cannot check ${JSON.stringify(ctx.input)}`);
  }
  return String(ctx.output).length > 0;
}

export const evaluation = new Evaluation({
  name: "uppercase",
  dataset: words,
  task: toUpper,
  scorers: [exact_match, scorer(checkNotEmpty, { name: "not_empty", version: "2" })],
});
