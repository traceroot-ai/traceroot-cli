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

  it("reads a case's task and scorer calls", () => {
    const usage = readCaseUsage({
      usage: {
        task: {
          llm_calls: 3,
          llm_calls_with_usage: 3,
          input_tokens: 1200,
          output_tokens: 80,
          total_tokens: 1280,
          cache_read_tokens: 0,
          cache_write_tokens: null,
          reasoning_tokens: null,
          cost: null,
          llm_calls_with_cost: 0,
          currency: null,
        },
        scorers: { llm_calls: 0, llm_calls_with_usage: 0 },
      },
    });

    expect(usage?.task).toEqual(
      bucket({
        llm_calls: 3,
        llm_calls_with_usage: 3,
        input_tokens: 1200,
        output_tokens: 80,
        total_tokens: 1280,
        cache_read_tokens: 0,
      }),
    );
    expect(usage?.scorers).toEqual(emptyBucket());
  });

  it("reads a value it can't trust as not reported, never as 0, and a malformed usage as none", () => {
    const usage = readCaseUsage({
      usage: {
        task: {
          llm_calls: 2,
          llm_calls_with_usage: 5,
          input_tokens: -1,
          output_tokens: "80",
          total_tokens: Number.NaN,
          cost: 0.5,
          llm_calls_with_cost: 9,
          currency: "USD",
        },
        scorers: { llm_calls: 0 },
      },
    });

    expect(usage?.task).toMatchObject({
      llm_calls: 2,
      llm_calls_with_usage: 2,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cost: 0.5,
      llm_calls_with_cost: 2,
      currency: "USD",
    });
    expect(readCaseUsage({ usage: { task: { llm_calls: "3" }, scorers: {} } })).toBeNull();
    expect(readCaseUsage({ usage: [] })).toBeNull();
  });
});

describe("addBuckets", () => {
  it("sums counts, and keeps a token or cost sum null only when no side reported it", () => {
    const sum = addBuckets(
      bucket({
        llm_calls: 2,
        llm_calls_with_usage: 1,
        input_tokens: 10,
        cost: 0.25,
        llm_calls_with_cost: 1,
        currency: "USD",
      }),
      bucket({ llm_calls: 1, llm_calls_with_usage: 1, input_tokens: 5, output_tokens: 7 }),
    );

    expect(sum).toMatchObject({
      llm_calls: 3,
      llm_calls_with_usage: 2,
      input_tokens: 15,
      output_tokens: 7,
      total_tokens: null,
      cost: 0.25,
      llm_calls_with_cost: 1,
      currency: "USD",
    });
  });

  it("has no single cost for two currencies", () => {
    const sum = addBuckets(
      bucket({ llm_calls: 1, cost: 1, llm_calls_with_cost: 1, currency: "USD" }),
      bucket({ llm_calls: 1, cost: 1, llm_calls_with_cost: 1, currency: "EUR" }),
    );

    expect(sum.cost).toBeNull();
    expect(sum.currency).toBeNull();
  });
});

describe("runUsage", () => {
  const usage = {
    task: bucket({ llm_calls: 2, llm_calls_with_usage: 2, input_tokens: 10 }),
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
