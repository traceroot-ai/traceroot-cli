/**
 * The LLM use a run recorded: how many LLM calls each case's task and scorers made, the tokens
 * they reported and what they cost, as the SDK's runner counted them from the calls its
 * instrumentation saw. The runner records it in each case's line and the CLI adds it up per run.
 *
 * Nothing here is ever a guess. A token count no call reported is null, never 0; a cost no call
 * reported is unknown, never free; and a run whose SDK records no usage says so rather than
 * reading as a run that made no calls.
 *
 * The case line is read leniently: an SDK that predates usage writes no `usage` key, and a
 * malformed value reads as unreadable rather than failing the read of a run whose scores are fine.
 */

/**
 * The LLM calls of one role, the task or the scorers, in one case or summed over a run.
 *
 * Every sum carries the number of calls it covers, right after it: `llm_calls_with_<field>`. A sum
 * covers only the calls that reported that field, so below `llm_calls` it is a lower bound. A
 * count is 0 exactly when its sum is null.
 */
export interface UsageBucket {
  /** The LLM calls counted. */
  llm_calls: number;
  input_tokens: number | null;
  llm_calls_with_input_tokens: number;
  output_tokens: number | null;
  llm_calls_with_output_tokens: number;
  /** A call's reported total, or its input and output added when it reports both and no total. */
  total_tokens: number | null;
  llm_calls_with_total_tokens: number;
  cache_read_tokens: number | null;
  llm_calls_with_cache_read_tokens: number;
  cache_write_tokens: number | null;
  llm_calls_with_cache_write_tokens: number;
  reasoning_tokens: number | null;
  llm_calls_with_reasoning_tokens: number;
  /** The sum of the costs the calls reported; null when none did. */
  cost: number | null;
  llm_calls_with_cost: number;
  /** The cost's currency, `USD` from both SDKs; null without a cost. */
  currency: string | null;
}

/** A case's LLM use: its task's calls, and its scorers' calls apart from them. */
export interface CaseUsage {
  task: UsageBucket;
  scorers: UsageBucket;
}

/** The token fields of a bucket, each a sum that stays null until a call reports it. */
export const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
] as const;

export type TokenField = (typeof TOKEN_FIELDS)[number];

/** The sums of a bucket: its token fields and its cost. */
export type SumField = TokenField | "cost";

/** The name of the count of calls a sum covers. */
export function coverageOf<F extends SumField>(field: F): `llm_calls_with_${F}` {
  return `llm_calls_with_${field}`;
}

/** A case line's `usage` that can't be read, a value no released SDK writes. */
export type Unreadable = "unreadable";

/**
 * A case line's `usage`: undefined when the line has no `usage` key, which an SDK that doesn't
 * record usage writes; null when the SDK captured none for the run (it instrumented no LLM client);
 * `unreadable` when the value can't be read; otherwise the case's usage.
 */
export function readCaseUsage(
  line: Record<string, unknown>,
): CaseUsage | Unreadable | null | undefined {
  if (!("usage" in line)) {
    return undefined;
  }
  const usage = line.usage;
  if (usage === null) {
    return null;
  }
  if (!isRecord(usage)) {
    return "unreadable";
  }
  const task = readBucket(usage.task);
  const scorers = readBucket(usage.scorers);
  return task === null || scorers === null ? "unreadable" : { task, scorers };
}

function readBucket(raw: unknown): UsageBucket | null {
  if (!isRecord(raw)) {
    return null;
  }
  const llmCalls = count(raw.llm_calls);
  if (llmCalls === null) {
    return null;
  }
  const bucket = emptyBucket();
  bucket.llm_calls = llmCalls;
  for (const field of TOKEN_FIELDS) {
    const [sum, calls] = covered(count(raw[field]), raw[coverageOf(field)], llmCalls);
    bucket[field] = sum;
    bucket[coverageOf(field)] = calls;
  }
  const [cost, priced] = covered(amount(raw.cost), raw.llm_calls_with_cost, llmCalls);
  bucket.cost = cost;
  bucket.llm_calls_with_cost = priced;
  bucket.currency = cost === null || typeof raw.currency !== "string" ? null : raw.currency;
  return bucket;
}

/**
 * A sum with the number of calls it covers. A sum whose count isn't a number of calls between 1
 * and `llm_calls` can't be read as complete or as partial, so it reads as not reported.
 */
function covered(sum: number | null, rawCalls: unknown, llmCalls: number): [number | null, number] {
  const calls = count(rawCalls);
  if (sum === null || calls === null || calls < 1 || calls > llmCalls) {
    return [null, 0];
  }
  return [sum, calls];
}

/** A whole, non-negative count, or null for anything else. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A finite, non-negative amount, or null for anything else. */
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A bucket with no calls. */
export function emptyBucket(): UsageBucket {
  return {
    llm_calls: 0,
    input_tokens: null,
    llm_calls_with_input_tokens: 0,
    output_tokens: null,
    llm_calls_with_output_tokens: 0,
    total_tokens: null,
    llm_calls_with_total_tokens: 0,
    cache_read_tokens: null,
    llm_calls_with_cache_read_tokens: 0,
    cache_write_tokens: null,
    llm_calls_with_cache_write_tokens: 0,
    reasoning_tokens: null,
    llm_calls_with_reasoning_tokens: 0,
    cost: null,
    llm_calls_with_cost: 0,
    currency: null,
  };
}

/** Buckets added: counts summed, and each sum null only when null in every bucket. */
export function sumBuckets(buckets: readonly UsageBucket[]): UsageBucket {
  const sum = (x: number | null, y: number | null): number | null =>
    x === null ? y : y === null ? x : x + y;
  const total = emptyBucket();
  for (const bucket of buckets) {
    total.llm_calls += bucket.llm_calls;
    for (const field of TOKEN_FIELDS) {
      total[field] = sum(total[field], bucket[field]);
      total[coverageOf(field)] += bucket[coverageOf(field)];
    }
  }
  // Both SDKs report USD. Buckets in more than one currency have no single sum, so the cost reads
  // as unknown, whatever order they come in.
  const currencies = new Set(
    buckets.flatMap(({ currency }) => (currency === null ? [] : [currency])),
  );
  if (currencies.size <= 1) {
    for (const bucket of buckets) {
      total.cost = sum(total.cost, bucket.cost);
      total.llm_calls_with_cost += bucket.llm_calls_with_cost;
    }
    total.currency = [...currencies][0] ?? null;
  }
  return total;
}

/**
 * What a run's cases say about its LLM use:
 * - `reported`: at least one case recorded usage;
 * - `not_captured`: the SDK records usage, but captured none, because the evaluation instrumented
 *   no LLM client;
 * - `not_recorded`: the SDK that ran it doesn't record usage;
 * - `unreadable`: no case recorded usage the CLI can read, and at least one recorded a value it
 *   can't.
 */
export type UsageStatus = "reported" | "not_captured" | "not_recorded" | "unreadable";

/** A run's LLM use: its cases' usage summed per role, and how many cases it covers. */
export interface RunUsage {
  status: UsageStatus;
  /** null unless `status` is `reported`. */
  task: UsageBucket | null;
  scorers: UsageBucket | null;
  /** The run's cases. */
  cases: number;
  /** How many of them recorded usage. */
  cases_with_usage: number;
}

/** A run's LLM use, from its case lines' `usage`. */
export function runUsage(
  usages: ReadonlyArray<CaseUsage | Unreadable | null | undefined>,
): RunUsage {
  const recorded = usages.filter(
    (usage): usage is CaseUsage => typeof usage === "object" && usage !== null,
  );
  if (recorded.length === 0) {
    const status = usages.includes("unreadable")
      ? "unreadable"
      : usages.some((usage) => usage !== undefined)
        ? "not_captured"
        : "not_recorded";
    return {
      status,
      task: null,
      scorers: null,
      cases: usages.length,
      cases_with_usage: 0,
    };
  }
  return {
    status: "reported",
    task: sumBuckets(recorded.map((usage) => usage.task)),
    scorers: sumBuckets(recorded.map((usage) => usage.scorers)),
    cases: usages.length,
    cases_with_usage: recorded.length,
  };
}
