import { describe, expect, it } from "vitest";
import { type PricedUsage, isPriced, pricedCostLines } from "../../src/eval/priced-cost.js";

type Bucket = PricedUsage["task"];

const bucket = (b: Partial<Bucket> = {}): Bucket => ({
  cost: 0.0035,
  llm_calls: 20,
  priced_llm_calls: 20,
  state: "complete",
  ...b,
});

function usage(over: Partial<PricedUsage> = {}): PricedUsage {
  return {
    currency: "USD",
    results_processed: 6,
    results_pending: 0,
    results_without_trace: 0,
    task: bucket(),
    scorers: bucket({ cost: 0.0012, llm_calls: 6, priced_llm_calls: 6 }),
    combined: bucket({ cost: 0.0047, llm_calls: 26, priced_llm_calls: 26 }),
    ...over,
  };
}

describe("pricedCostLines", () => {
  it("prints task, scorer and total cost when everything is priced", () => {
    expect(pricedCostLines(usage())).toEqual(["task $0.0035, scorers $0.0012, total $0.0047"]);
  });

  it("says how many calls were priced when the task is partial", () => {
    const u = usage({
      task: bucket({ priced_llm_calls: 18, state: "partial" }),
      combined: bucket({ cost: 0.0047, llm_calls: 26, priced_llm_calls: 24, state: "partial" }),
    });
    expect(pricedCostLines(u)).toEqual([
      "task $0.0035 (18 of 20 calls priced), scorers $0.0012, total $0.0047 (24 of 26 calls priced)",
    ]);
  });

  it("calls unpriced scorers unknown, never zero", () => {
    const u = usage({
      scorers: bucket({ cost: null, llm_calls: 6, priced_llm_calls: 0, state: "unpriced" }),
      combined: bucket({ cost: 0.0035, llm_calls: 26, priced_llm_calls: 20, state: "partial" }),
    });
    expect(pricedCostLines(u)).toEqual([
      "task $0.0035, scorers unknown (0 of 6 calls priced), total $0.0035 (20 of 26 calls priced)",
    ]);
  });

  it("does not claim $0 or no calls for scorers with no recorded LLM calls", () => {
    const u = usage({
      scorers: bucket({ cost: null, llm_calls: 0, priced_llm_calls: 0, state: "no_calls" }),
      combined: bucket({ cost: 0.0035, llm_calls: 20, priced_llm_calls: 20 }),
    });
    expect(pricedCostLines(u)).toEqual([
      "task $0.0035, scorers no LLM calls recorded, total $0.0035",
    ]);
  });

  it("asks for a re-run while any bucket is still processing", () => {
    const u = usage({
      results_pending: 2,
      results_processed: 4,
      combined: bucket({ state: "processing" }),
    });
    expect(pricedCostLines(u)).toEqual([
      "TraceRoot is still processing 2 of the run's 6 traced cases; run this command again for the full cost.",
    ]);
  });

  it("says unknown when there is no trace for any case", () => {
    const empty = bucket({ cost: null, llm_calls: 0, priced_llm_calls: 0, state: "unavailable" });
    const u = usage({
      results_processed: 0,
      results_without_trace: 7,
      task: empty,
      scorers: empty,
      combined: empty,
    });
    expect(pricedCostLines(u)).toEqual(["unknown: TraceRoot has no trace for this run's cases."]);
  });

  it("says once that a run recorded no LLM calls", () => {
    const none = bucket({ cost: null, llm_calls: 0, priced_llm_calls: 0, state: "no_calls" });
    const u = usage({ task: none, scorers: none, combined: none });
    expect(pricedCostLines(u)).toEqual(["no LLM calls recorded"]);
    expect(pricedCostLines({ ...u, results_without_trace: 1 })).toEqual([
      "no LLM calls recorded",
      "1 of 7 cases has no trace in TraceRoot, so its calls aren't counted.",
    ]);
  });

  it("adds a note for results without a trace, singular and plural", () => {
    expect(pricedCostLines(usage({ results_processed: 6, results_without_trace: 1 }))).toEqual([
      "task $0.0035, scorers $0.0012, total $0.0047",
      "1 of 7 cases has no trace in TraceRoot, so its calls aren't counted.",
    ]);
    expect(pricedCostLines(usage({ results_processed: 5, results_without_trace: 2 }))[1]).toBe(
      "2 of 7 cases have no trace in TraceRoot, so their calls aren't counted.",
    );
  });

  it("keeps a priced zero as $0", () => {
    const u = usage({ task: bucket({ cost: 0 }) });
    expect(pricedCostLines(u)[0]).toMatch(/^task \$0,/);
  });
});

describe("isPriced", () => {
  it("is true when nothing is processing and a result was processed", () => {
    expect(isPriced(usage())).toBe(true);
  });
  it("is false while a bucket is processing", () => {
    expect(isPriced(usage({ task: bucket({ state: "processing" }) }))).toBe(false);
  });
  it("is false when no result was processed", () => {
    expect(isPriced(usage({ results_processed: 0 }))).toBe(false);
  });
});
