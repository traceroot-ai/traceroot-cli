import { describe, expect, it } from "vitest";
import { createSetupApi } from "../../src/api/setup.js";
import { pollForTrace, spanPhrase } from "../../src/setup/trace.js";

describe("polling for the first trace", () => {
  it("asks for a page wide enough to still hold the run's earliest trace", async () => {
    // One page, newest-first, no ascending order and no cursor: a narrow page on
    // a busy project pushes the trace this run is waiting for off the end.
    const seen: Array<{ limit?: number }> = [];
    await pollForTrace({
      client: {
        listTraces: async (params) => {
          seen.push(params ?? {});
          return { data: [], meta: { limit: 0 } } as never;
        },
      },
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
      timeoutMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(seen[0]?.limit).toBe(200);
  });

  it.each([
    [401, "Invalid API key"],
    [401, "API key has expired"],
    [401, "Project has been deleted"],
    [401, "Authentication failed"],
    [401, "Invalid token"],
    [403, "No access to project 'p1'"],
  ])("stops on the server's %i %s instead of waiting it out", async (status, detail) => {
    // A bad key does not become a good one by waiting, so retrying until the
    // timeout spends the user's whole trace budget on a fixed error. Built
    // through the real client, whose message is the server's own `detail`: the
    // class has to come off the error's exit code, and a faked error carrying
    // one hid that the client never set it.
    let calls = 0;
    const client = createSetupApi({
      host: "https://api.example.test",
      apiKey: "tr-revoked",
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ detail }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
    });
    // A clock that advances, so a version that treats this as transient runs
    // out of budget and fails the call count rather than looping forever.
    let clock = 0;
    const result = await pollForTrace({
      client,
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => {
        clock += 1_000;
        return clock;
      },
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({ found: false, lastError: detail });
  });

  it("holds the schedule's last step rather than a ceiling it never reaches", async () => {
    // There was a 10s cap in here that nothing could reach: the schedule tops
    // out at 5s and the cap could only ever lower a value, so it documented a
    // backoff this poll does not have. The last interval is the remaining
    // budget, which is the only clamp that does anything.
    const sleeps: number[] = [];
    let clock = 0;
    await pollForTrace({
      client: { listTraces: async () => ({ data: [], meta: { limit: 0 } }) as never },
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
      timeoutMs: 20_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    expect(sleeps).toEqual([2000, 2000, 3000, 5000, 5000, 3000]);
  });
});

describe("choosing which trace the run produced", () => {
  const STARTED = new Date("2026-07-26T12:00:00.000Z");

  /** A page as the backend returns it: newest first, timestamps without a zone. */
  function page(rows: Array<{ id: string; at: string; name?: string; spans?: number }>) {
    return {
      data: rows.map((r) => ({
        trace_id: r.id,
        trace_url: `https://app.example.test/trace/${r.id}`,
        trace_start_time: r.at,
        name: r.name ?? `${r.id}-root`,
        ...(r.spans === undefined ? {} : { span_count: r.spans }),
      })),
      meta: { limit: rows.length },
    } as never;
  }

  it("takes the earliest trace since setup started, ahead of a burst that lands after it", async () => {
    // The run this replays. The agent ran the application, which sent one
    // trace of twenty-one spans; nineteen seconds later the project's tests
    // sent six more, the earliest a one-span unit test of a single tool. The
    // poll used to search the tests' window first and opened that unit test as
    // "your first trace", with the application's own trace outside the window.
    const result = await pollForTrace({
      client: {
        listTraces: async () =>
          page([
            { id: "test-demo-run", at: "2026-07-26T12:00:40.400000", name: "demo.run", spans: 3 },
            { id: "test-agent-run", at: "2026-07-26T12:00:40.300000", name: "agent.run", spans: 2 },
            {
              id: "test-tool",
              at: "2026-07-26T12:00:40.200000",
              name: "agent.execute_tool",
              spans: 1,
            },
            { id: "test-calculate", at: "2026-07-26T12:00:40.100000", name: "calculate", spans: 1 },
            { id: "app", at: "2026-07-26T12:00:21.000000", name: "demo.run", spans: 21 },
          ]),
      },
      startedAt: STARTED,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result.found && result.trace.traceId).toBe("app");
    expect(result.found && result.attribution.spanCount).toBe(21);
    // The burst is still counted: it is traffic in the same frame, and the count
    // is what lets a user see there was a choice.
    expect(result.found && result.attribution.candidates).toBe(5);
  });

  it("bounds the search by the start of setup and nothing else", async () => {
    // There is no narrower window to search first. The only bound is the one
    // that keeps traces from before setup out.
    const seen: Array<Record<string, unknown>> = [];
    await pollForTrace({
      client: {
        listTraces: async (params) => {
          seen.push({ ...params });
          return page([]);
        },
      },
      startedAt: STARTED,
      timeoutMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(seen).toEqual([{ limit: 200, startAfter: "2026-07-26T12:00:00.000Z" }]);
  });

  it("counts the other traffic that landed since setup started", async () => {
    // Nothing in the list response identifies the process that emitted a trace,
    // so a project with other traffic is a choice between candidates. The count
    // and the trace's own name are what let a user judge the link.
    const result = await pollForTrace({
      client: {
        listTraces: async () =>
          page([
            { id: "second", at: "2026-07-26T12:05:08.000000" },
            { id: "first", at: "2026-07-26T12:05:02.000000", name: "checkout.handle" },
          ]),
      },
      startedAt: STARTED,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result.found && result.trace.traceId).toBe("first");
    expect(result.found && result.attribution.candidates).toBe(2);
    expect(result.found && result.attribution.name).toBe("checkout.handle");
  });

  it("says when the page came back full, because then earliest is only earliest-seen", async () => {
    // Newest-first, one page, no cursor: on a busy project the run's earliest
    // trace can be off the end of it, and "your first trace" then names the
    // earliest of the newest 200.
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `t_${i}`,
      at: `2026-07-26T12:05:0${i % 10}.000000`,
    }));
    const result = await pollForTrace({
      client: { listTraces: async () => page(rows) },
      startedAt: STARTED,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result.found && result.attribution.truncated).toBe(true);
  });

  it("takes the earliest eligible row, not the first one the page happens to list", async () => {
    // The backend orders newest-first and has no ascending mode, so row zero is
    // the most recent trace while both this poll and the browser call what they
    // show "your first trace". Without the sort the two disagree.
    const result = await pollForTrace({
      client: {
        listTraces: async () =>
          page([
            { id: "later", at: "2026-07-26T12:01:30.000000" },
            { id: "earliest", at: "2026-07-26T12:00:30.000000" },
          ]),
      },
      startedAt: STARTED,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result.found).toBe(true);
    expect(result.found && result.trace.traceId).toBe("earliest");
  });

  it("reads a zone-less timestamp as UTC, so a pre-existing trace stays excluded", async () => {
    // The API returns `trace_start_time` without a zone. Parsing it as local time
    // shifts every row by the machine's offset — which either claims a trace that
    // predates the run or discards the one it just produced, depending on which
    // side of UTC the developer is on.
    const result = await pollForTrace({
      client: {
        listTraces: async () =>
          page([
            { id: "ours", at: "2026-07-26T12:00:30.000000" },
            { id: "pre-existing", at: "2026-07-26T11:59:30.000000" },
          ]),
      },
      startedAt: STARTED,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result.found).toBe(true);
    expect(result.found && result.trace.traceId).toBe("ours");
  });
});

describe("whether the project had traces before setup started", () => {
  const STARTED = new Date("2026-07-26T12:00:00.000Z");
  const OURS = {
    trace_id: "ours",
    trace_url: "https://app.example.test/trace/ours",
    trace_start_time: "2026-07-26T12:00:30.000000",
    name: "demo.run",
  };

  /** The poll over one trace since setup started, with `earlier` answering the look before it. */
  function look(earlier: unknown[] | Error) {
    const seen: Array<Record<string, unknown>> = [];
    const result = pollForTrace({
      client: {
        listTraces: async (params) => {
          seen.push({ ...params });
          if (params.endBefore === undefined) {
            return { data: [OURS], meta: { limit: 200 } } as never;
          }
          if (earlier instanceof Error) {
            throw earlier;
          }
          return { data: earlier, meta: { limit: 1 } } as never;
        },
      },
      startedAt: STARTED,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });
    return { seen, result };
  }

  it("asks once, after the trace is found, for one trace from before setup started", async () => {
    const { seen, result } = look([]);
    await result;

    expect(seen).toEqual([
      { limit: 200, startAfter: "2026-07-26T12:00:00.000Z" },
      { limit: 1, endBefore: "2026-07-26T12:00:00.000Z" },
    ]);
  });

  it("calls the trace attributed when the project had none", async () => {
    const outcome = await look([]).result;

    expect(outcome.found && outcome.attribution.attributed).toBe(true);
    expect(outcome.found && outcome.trace).toMatchObject({
      name: "demo.run",
      candidates: 1,
      truncated: false,
      attributed: true,
    });
  });

  it("calls it unattributed when the project already had traffic", async () => {
    const outcome = await look([
      { ...OURS, trace_id: "old", trace_start_time: "2026-07-25T09:00:00.000000" },
    ]).result;

    expect(outcome.found && outcome.trace.traceId).toBe("ours");
    expect(outcome.found && outcome.attribution.attributed).toBe(false);
    expect(outcome.found && outcome.trace.attributed).toBe(false);
  });

  it("leaves it unknown, and the trace found, when that look fails", async () => {
    // The run has its trace. A second read that fails must neither undo that
    // nor be read as "someone else sent it".
    const outcome = await look(new Error("request to host failed: fetch failed")).result;

    expect(outcome.found).toBe(true);
    expect(outcome.found && outcome.attribution.attributed).toBeNull();
    expect(outcome.found && "attributed" in outcome.trace).toBe(false);
  });

  it("leaves it unknown when the backend ignored the bound", async () => {
    // A row from after setup started can only mean `end_before` was not
    // applied, which says nothing about what came before.
    const outcome = await look([OURS]).result;

    expect(outcome.found && outcome.attribution.attributed).toBeNull();
  });
});

describe("how much of the application the trace covers", () => {
  const STARTED = new Date("2026-07-26T12:00:00.000Z");

  /** The poll over a page holding one row, which leaves the span count as the only thing under test. */
  function look(rows: unknown[]) {
    return pollForTrace({
      client: { listTraces: async () => ({ data: rows, meta: { limit: rows.length } }) as never },
      startedAt: STARTED,
      timeoutMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });
  }

  /** A row as the list endpoint returns one, with whatever `span_count` says. */
  function row(spanCount: unknown): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      trace_id: "t_1",
      trace_url: "https://app.example.test/trace/t_1",
      trace_start_time: "2026-07-26T12:00:30.000000",
      name: "agent.solve",
    };
    // Absent when the case says `undefined`, which is how a deployment that
    // does not report the field is distinguished from one reporting zero.
    return spanCount === undefined ? fields : { ...fields, span_count: spanCount };
  }

  it("carries the count the response reported rather than discarding it", async () => {
    // The response has always said how many spans the trace holds. The poll
    // read four fields out of a row of seventeen and dropped this one, so a run
    // had nothing in hand to say how much of the application its trace showed.
    const result = await look([row(7)]);

    expect(result.found && result.attribution.spanCount).toBe(7);
  });

  it("reports no count rather than no spans when the response omits the field", async () => {
    // The distinction the null exists for. A deployment that does not carry
    // `span_count` has told this process nothing, and printing that silence as
    // a trace with nothing in it would say the opposite of the truth.
    const result = await look([row(undefined)]);

    expect(result.found).toBe(true);
    expect(result.found && result.attribution.spanCount).toBeNull();
  });

  it("copies the count onto the record the report reads, not only the attribution", async () => {
    // The report's trace row reads the count off the verification, and the
    // poll filled in only the attribution's copy, so the count never arrived.
    // `--resume` renders the report from the checkpointed trace as well, which
    // is the other half of why the count belongs on the record rather than
    // only in the invocation that polled.
    const single = await look([row(1)]);
    expect(single.found && single.trace.spanCount).toBe(1);

    const covered = await look([row(7)]);
    expect(covered.found && covered.trace.spanCount).toBe(7);
  });

  it("leaves the count off the record when the response reported none", async () => {
    // Absent and zero are different answers and have to stay different.
    // `TraceVerification` spells "the response did not say" as a missing field,
    // so a row without `span_count` leaves it missing rather than carrying a
    // zero the report would print as "no spans".
    const result = await look([row(undefined)]);

    expect(result.found).toBe(true);
    expect(result.found && "spanCount" in result.trace).toBe(false);
  });

  it("refuses a count that is not a whole number of spans", async () => {
    // Nothing in the published response produces any of these. They are here
    // because the row is read structurally, and a value that cannot be a span
    // count has to come back as "the response did not say" rather than as a
    // number the report would then print.
    for (const value of [2.5, -1, "3", null, Number.NaN]) {
      const result = await look([row(value)]);
      expect(result.found && result.attribution.spanCount).toBeNull();
    }
  });

  it("writes the count as prose, so one span does not read as '1 spans'", () => {
    // These strings reach a user: the report's trace row and the line the poll
    // closes on both print them, which is why there is one of each rather than
    // two.
    expect(spanPhrase(1)).toBe("a single span");
    expect(spanPhrase(7)).toBe("7 spans");
    expect(spanPhrase(0)).toBe("no spans");
  });
});
