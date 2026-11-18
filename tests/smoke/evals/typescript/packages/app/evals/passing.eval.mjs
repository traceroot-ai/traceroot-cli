// The passing evaluation as an ES module.
import { Dataset, Evaluation, scorer } from "@traceroot-ai/traceroot";

const words = new Dataset("words");
words.add("alpha", { expected: "ALPHA" });
words.add("beta", { expected: "BETA" });
words.add("gamma", { expected: "GAMMA" });

function toUpper(word) {
  return word.toUpperCase();
}

function exact_match(ctx) {
  return ctx.output === ctx.expected;
}

function checkNotEmpty(ctx) {
  return String(ctx.output).length > 0;
}

export const evaluation = new Evaluation({
  name: "uppercase",
  dataset: words,
  task: toUpper,
  scorers: [exact_match, scorer(checkNotEmpty, { name: "not_empty", version: "2" })],
});
