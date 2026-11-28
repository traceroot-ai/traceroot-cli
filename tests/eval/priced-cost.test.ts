import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PricedUsage,
  isPriced,
  pricedCostLines,
  readPricedUsage,
} from "../../src/eval/priced-cost.js";
import type { UploadTarget } from "../../src/eval/spawn.js";
import { makeSecret } from "../../src/setup/secret.js";
import {
  type FetchCall,
  createFakeFetch,
  errorResponse,
  jsonResponse,
} from "../helpers/fakeFetch.js";

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

describe("readPricedUsage", () => {
  const KEY = "tr-fake-upload-0000";
  const target: UploadTarget = { host: "https://api.example/", apiKey: makeSecret(KEY) };

  /** What TraceRoot answers a run read with: the run, its usage among the rest. */
  const runRead = (id: string, u: unknown = usage()) =>
    jsonResponse({ evaluation_run_id: id, status: "completed", usage: u });

  const idOf = (call: FetchCall) => new URL(call.url).pathname.split("/").at(-1) ?? "";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads each run once, at its path, with the upload key as the bearer", async () => {
    const fake = createFakeFetch((call) => runRead(idOf(call)));

    const priced = await readPricedUsage(target, ["evr_1", "evr_2"], {
      fetchImpl: fake.fetchImpl,
    });

    expect(priced).toEqual(
      new Map([
        ["evr_1", usage()],
        ["evr_2", usage()],
      ]),
    );
    expect(fake.calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
      "/api/v1/public/evaluation-runs/evr_1",
      "/api/v1/public/evaluation-runs/evr_2",
    ]);
    for (const call of fake.calls) {
      expect(call.init.method).toBe("GET");
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    }
  });

  it("maps a 500, a run without usage and a failed request each to null, and never throws", async () => {
    const fake = createFakeFetch((call) => {
      switch (idOf(call)) {
        case "evr_500":
          return errorResponse(500, "boom");
        case "evr_bare":
          return jsonResponse({ evaluation_run_id: "evr_bare", status: "completed" });
        case "evr_null":
          return runRead("evr_null", null);
        case "evr_ok":
          return runRead("evr_ok");
        default:
          return Promise.reject(new TypeError(`fetch failed for ${KEY}`));
      }
    });

    const priced = await readPricedUsage(
      target,
      ["evr_500", "evr_bare", "evr_null", "evr_down", "evr_ok"],
      { fetchImpl: fake.fetchImpl },
    );

    expect(priced).toEqual(
      new Map([
        ["evr_500", null],
        ["evr_bare", null],
        ["evr_null", null],
        ["evr_down", null],
        ["evr_ok", usage()],
      ]),
    );
  });

  it("gives null for every run when the host can't be read, without a request", async () => {
    const fake = createFakeFetch((call) => runRead(idOf(call)));

    const priced = await readPricedUsage({ ...target, host: "not a host" }, ["evr_1"], {
      fetchImpl: fake.fetchImpl,
    });

    expect(priced).toEqual(new Map([["evr_1", null]]));
    expect(fake.calls).toEqual([]);
  });

  it("gives null for reads that never answer once the timeout, for all of them together, is up", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch((call) =>
      idOf(call) === "evr_ok" ? runRead("evr_ok") : new Promise<Response>(() => {}),
    );
    let priced: Map<string, PricedUsage | null> | undefined;

    void readPricedUsage(target, ["evr_ok", "evr_slow_1", "evr_slow_2"], {
      fetchImpl: fake.fetchImpl,
      timeoutMs: 3000,
    }).then((result) => {
      priced = result;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(priced).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(priced).toEqual(
      new Map([
        ["evr_ok", usage()],
        ["evr_slow_1", null],
        ["evr_slow_2", null],
      ]),
    );
    // The reads still in flight are aborted, so no socket outlives the deadline.
    const slow = fake.calls.filter((call) => idOf(call) !== "evr_ok");
    expect(slow.map((call) => call.init.signal?.aborted)).toEqual([true, true]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind when every read answers before the timeout", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch((call) => runRead(idOf(call)));

    await readPricedUsage(target, ["evr_1"], { fetchImpl: fake.fetchImpl });

    expect(vi.getTimerCount()).toBe(0);
  });
});
