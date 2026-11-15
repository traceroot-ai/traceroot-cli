// Builds its evaluation inside a function, so the runner finds none at module level.
import { Dataset, Evaluation, type ScorerContext } from "@traceroot-ai/traceroot";

function toUpper(word: string): string {
  return word.toUpperCase();
}

function exact_match(ctx: ScorerContext): boolean {
  return ctx.output === ctx.expected;
}

export function buildEvaluation(): Evaluation {
  const words = new Dataset("words");
  words.add("alpha", { expected: "ALPHA" });
  return new Evaluation({
    name: "uppercase",
    dataset: words,
    task: toUpper,
    scorers: [exact_match],
  });
}
