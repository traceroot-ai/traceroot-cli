import type { EvaluationRun } from "../api/client.js";
import { type Wire, formatMean } from "../registry/enhancers/eval-reads.js";

/** The run read's `usage` block, as the CLI types it. */
export type PricedUsage = NonNullable<Wire<EvaluationRun>["usage"]>;
type Bucket = PricedUsage["task"];

/** A money amount. Keeps significant digits, so a small cost never rounds to $0. */
function money(value: number): string {
  return `$${formatMean(value)}`;
}

/**
 * One bucket as `<label> <amount>`. A missing cost is never printed as a number:
 * unpriced calls read as unknown, and no recorded calls say so, because a
 * code-only scorer and an uninstrumented one look the same to TraceRoot.
 */
function describeBucket(label: string, bucket: Bucket | null | undefined): string {
  if (bucket === null || bucket === undefined) return `${label} unknown`;
  const calls = bucket.llm_calls ?? 0;
  const priced = bucket.priced_llm_calls ?? 0;
  const coverage = `${priced} of ${calls} calls priced`;
  if (bucket.state === "no_calls") return `${label} no LLM calls recorded`;
  if (bucket.cost === null || bucket.cost === undefined) {
    return `${label} unknown (${coverage})`;
  }
  const amount = money(bucket.cost);
  return priced < calls ? `${label} ${amount} (${coverage})` : `${label} ${amount}`;
}

/**
 * The lines that follow the `cost` label in `evals runs get` (and, later, in the
 * upload summary): one line of cost, plus a note when some results have no trace.
 */
export function pricedCostLines(usage: PricedUsage): string[] {
  const pending = usage.results_pending ?? 0;
  const processed = usage.results_processed ?? 0;
  const withoutTrace = usage.results_without_trace ?? 0;
  const buckets = [usage.task, usage.scorers, usage.combined];

  if (pending > 0 || buckets.some((b) => b?.state === "processing")) {
    return [
      `TraceRoot is still processing ${pending} of the run's ${pending + processed} traced cases; run this command again for the full cost.`,
    ];
  }
  if (processed === 0) {
    return ["unknown: TraceRoot has no trace for this run's cases."];
  }
  const lines = [
    [
      describeBucket("task", usage.task),
      describeBucket("scorers", usage.scorers),
      describeBucket("total", usage.combined),
    ].join(", "),
  ];
  if (withoutTrace > 0) {
    const total = processed + withoutTrace;
    lines.push(
      withoutTrace === 1
        ? `1 of ${total} cases has no trace in TraceRoot, so its calls aren't counted.`
        : `${withoutTrace} of ${total} cases have no trace in TraceRoot, so their calls aren't counted.`,
    );
  }
  return lines;
}

/** True when the cost is final and at least one result was priced from a trace. */
export function isPriced(usage: PricedUsage): boolean {
  const buckets = [usage.task, usage.scorers, usage.combined];
  return !buckets.some((b) => b?.state === "processing") && (usage.results_processed ?? 0) > 0;
}
