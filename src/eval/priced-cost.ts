import { ApiClient, bearerAuth } from "@traceroot-ai/tools";
import { type EvaluationRun, normalizeBaseUrl } from "../api/client.js";
import { type Wire, formatMean } from "../registry/enhancers/eval-reads.js";
import { getVersion } from "../version.js";
import type { UploadTarget } from "./spawn.js";

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

  if (isProcessing(usage)) {
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

/** True while TraceRoot still has results whose trace it hasn't processed. */
export function isProcessing(usage: PricedUsage): boolean {
  const buckets = [usage.task, usage.scorers, usage.combined];
  return (usage.results_pending ?? 0) > 0 || buckets.some((b) => b?.state === "processing");
}

/** True when the cost is final and at least one result was priced from a trace. */
export function isPriced(usage: PricedUsage): boolean {
  return !isProcessing(usage) && (usage.results_processed ?? 0) > 0;
}

/** How long the end of an uploaded `evals run` waits for TraceRoot's priced cost, all runs together. */
export const PRICED_READ_TIMEOUT_MS = 3000;

/**
 * Reads the `usage` TraceRoot priced each uploaded run at, once per run, all in parallel, with no
 * retry. The read goes through the same client the registry reads a run with, under the upload key.
 *
 * `timeoutMs` bounds the whole call, not each request: when it is up, every read still in flight is
 * aborted and its run maps to null, and the timer is never what keeps the process alive. `signal`
 * ends the call the same way, at once. A run whose read fails, answers with an error status, or has
 * no `usage` maps to null too. Never throws.
 */
export async function readPricedUsage(
  target: UploadTarget,
  runIds: string[],
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Map<string, PricedUsage | null>> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), opts.timeoutMs ?? PRICED_READ_TIMEOUT_MS);
  timer.unref();
  // Settles every read at the deadline, even one whose fetch doesn't heed the abort.
  const expired = new Promise<null>((resolve) => {
    deadline.signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  const stop = (): void => deadline.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) {
    stop();
  }
  try {
    const client = new ApiClient({
      baseUrl: normalizeBaseUrl(target.host),
      headers: {
        ...bearerAuth(target.apiKey.reveal()),
        accept: "application/json",
        "user-agent": `traceroot-cli/${getVersion()}`,
      },
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    });
    const read = async (id: string): Promise<PricedUsage | null> => {
      try {
        const path = `/api/v1/public/evaluation-runs/${encodeURIComponent(id)}`;
        return usageOf(await client.request("get", path, { signal: deadline.signal }));
      } catch {
        return null;
      }
    };
    const usages = await Promise.all(runIds.map((id) => Promise.race([read(id), expired])));
    return new Map(runIds.map((id, i) => [id, usages[i] ?? null]));
  } catch {
    return new Map(runIds.map((id) => [id, null]));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  }
}

/** A run read's `usage`, or null when the answer has none. */
function usageOf(run: unknown): PricedUsage | null {
  if (typeof run !== "object" || run === null || !("usage" in run)) {
    return null;
  }
  const { usage } = run;
  return typeof usage === "object" && usage !== null ? (usage as PricedUsage) : null;
}
