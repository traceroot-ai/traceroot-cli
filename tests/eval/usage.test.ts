import { describe, expect, it } from "vitest";
import {
  type UsageBucket,
  addBuckets,
  emptyBucket,
  readCaseUsage,
  runUsage,
} from "../../src/eval/usage.js";

function bucket(changes: Partial<UsageBucket>): UsageBucket {
  return { ...emptyBucket(), ...changes };
}

describe("readCaseUsage", () => {
  it("tells an SDK that records no usage from one that captured none", () => {
    expect(readCaseUsage({ case_id: "a" })).toBeUndefined();
    expect(readCaseUsage({ case_id: "a", usage: null })).toBeNull();
  });

  it("reads a case's task and scorer calls, each sum with the calls it covers", () => {
    const usage = readCaseUsage({
      usage: {
        task: {
          llm_calls: 3,
          input_tokens: 1200,
          llm_calls_with_input_tokens: 3,
          output_tokens: 80,
          llm_calls_with_output_tokens: 2,
          total_tokens: 1280,
          llm_calls_with_total_tokens: 2,
          cache_read_tokens: 0,
          llm_calls_with_cache_read_tokens: 3,
          cache_write_tokens: null,
          llm_calls_with_cache_write_tokens: 0,
          reasoning_tokens: null,
          llm_calls_with_reasoning_tokens: 0,
          cost: null,
          llm_calls_with_cost: 0,
          currency: null,
        },
        scorers: { llm_calls: 0 },
      },
    });

    expect(usage?.task).toEqual(
      bucket({
        llm_calls: 3,
        input_tokens: 1200,
        llm_calls_with_input_tokens: 3,
        output_tokens: 80,
        llm_calls_with_output_tokens: 2,
        total_tokens: 1280,
        llm_calls_with_total_tokens: 2,
        cache_read_tokens: 0,
        llm_calls_with_cache_read_tokens: 3,
      }),
    );
    expect(usage?.scorers).toEqual(emptyBucket());
  });

  it("reads a value it can't trust as not reported, never as 0, and a malformed usage as none", () => {
    const usage = readCaseUsage({
      usage: {
        task: {
          llm_calls: 2,
          input_tokens: -1,
          llm_calls_with_input_tokens: 2,
          output_tokens: "80",
          llm_calls_with_output_tokens: 2,
          total_tokens: Number.NaN,
          llm_calls_with_total_tokens: 2,
          cost: 0.5,
          llm_calls_with_cost: 2,
          currency: "USD",
        },
        scorers: { llm_calls: 0 },
      },
    });

    expect(usage?.task).toEqual(
      bucket({ llm_calls: 2, cost: 0.5, llm_calls_with_cost: 2, currency: "USD" }),
    );
    expect(readCaseUsage({ usage: { task: { llm_calls: "3" }, scorers: {} } })).toBeNull();
    expect(readCaseUsage({ usage: [] })).toBeNull();
  });

  it("reads a sum whose count of calls is missing or out of range as not reported", () => {
    const usage = readCaseUsage({
      usage: {
        task: {
          llm_calls: 2,
          input_tokens: 120,
          output_tokens: 8,
          llm_calls_with_output_tokens: 0,
          total_tokens: 28,
          llm_calls_with_total_tokens: 3,
          reasoning_tokens: 4,
          llm_calls_with_reasoning_tokens: 1,
          cost: 0.5,
          llm_calls_with_cost: 9,
          currency: "USD",
        },
        scorers: { llm_calls: 0 },
      },
    });

    expect(usage?.task).toEqual(
      bucket({ llm_calls: 2, reasoning_tokens: 4, llm_calls_with_reasoning_tokens: 1 }),
    );
  });
});

describe("addBuckets", () => {
  it("sums each figure with the calls it covers, null only when no side reported it", () => {
    const sum = addBuckets(
      bucket({
        llm_calls: 2,
        input_tokens: 10,
        llm_calls_with_input_tokens: 1,
        cost: 0.25,
        llm_calls_with_cost: 1,
        currency: "USD",
      }),
      bucket({
        llm_calls: 1,
        input_tokens: 5,
        llm_calls_with_input_tokens: 1,
        output_tokens: 7,
        llm_calls_with_output_tokens: 1,
      }),
    );

    expect(sum).toEqual(
      bucket({
        llm_calls: 3,
        input_tokens: 15,
        llm_calls_with_input_tokens: 2,
        output_tokens: 7,
        llm_calls_with_output_tokens: 1,
        cost: 0.25,
        llm_calls_with_cost: 1,
        currency: "USD",
      }),
    );
  });

  it("has no single cost for two currencies", () => {
    const sum = addBuckets(
      bucket({ llm_calls: 1, cost: 1, llm_calls_with_cost: 1, currency: "USD" }),
      bucket({ llm_calls: 1, cost: 1, llm_calls_with_cost: 1, currency: "EUR" }),
    );

    expect(sum.cost).toBeNull();
    expect(sum.llm_calls_with_cost).toBe(0);
    expect(sum.currency).toBeNull();
  });
});

describe("runUsage", () => {
  const usage = {
    task: bucket({ llm_calls: 2, input_tokens: 10, llm_calls_with_input_tokens: 2 }),
    scorers: emptyBucket(),
  };

  it("sums the cases that recorded usage and counts the ones that didn't", () => {
    expect(runUsage([usage, usage, null])).toMatchObject({
      status: "reported",
      task: { llm_calls: 4, input_tokens: 20 },
      scorers: { llm_calls: 0 },
      cases: 3,
      cases_with_usage: 2,
    });
  });

  it("says whether the SDK captured none or records none", () => {
    expect(runUsage([null, null]).status).toBe("not_captured");
    expect(runUsage([undefined, undefined]).status).toBe("not_recorded");
    expect(runUsage([]).status).toBe("not_recorded");
  });
});
