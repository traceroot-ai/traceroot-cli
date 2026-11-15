// Imports a sibling module that does not exist, so the file fails to import.
import { Dataset, Evaluation, type ScorerContext } from "@traceroot-ai/traceroot";
import { normalize } from "./helpers";

const words = new Dataset("words");
words.add("alpha", { expected: "ALPHA" });

function toUpper(word: string): string {
  return normalize(word).toUpperCase();
}

function exact_match(ctx: ScorerContext): boolean {
  return ctx.output === ctx.expected;
}

export const evaluation = new Evaluation({
  name: "uppercase",
  dataset: words,
  task: toUpper,
  scorers: [exact_match],
});
