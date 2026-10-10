import { describe, expect, it } from "vitest";
import { ExitCode } from "../../src/output.js";
import { makeSecret } from "../../src/setup/secret.js";
import { pollForTrace } from "../../src/setup/trace.js";
import { verifyApplication } from "../../src/setup/verify.js";
import { fakeRunProcess } from "./helpers.js";

describe("running the project's own check twice", () => {
  it("points both runs at the same host, so only the credential differs", async () => {
    // The parent environment may already carry a TRACEROOT_HOST_URL — a
    // developer pointed at staging, say. Inheriting it on only one of the two
    // runs makes the comparison about the host rather than about the key.
    const { run, runs } = fakeRunProcess();
    await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin", TRACEROOT_HOST_URL: "https://stale.example.test" },
      credential: makeSecret("tr-a-long-enough-value"),
      host: "https://api.example.test",
      runProcess: run,
    });

    expect(runs).toHaveLength(2);
    const [withKey, withoutKey] = runs;
    expect(withKey?.env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    expect(withoutKey?.env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    expect(withKey?.env.TRACEROOT_API_KEY).toBe("tr-a-long-enough-value");
    // Deleted, not blanked: absent and empty are different to an SDK.
    expect("TRACEROOT_API_KEY" in (withoutKey?.env ?? {})).toBe(false);
  });
});

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
      ranAt: null,
      timeoutMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(seen[0]?.limit).toBe(200);
  });

  it("stops on an authentication failure instead of waiting it out", async () => {
    // A bad key does not become a good one by waiting, so retrying until the
    // timeout spends the user's whole trace budget on a fixed error. The class
    // comes off the thrown error's exit code, because the message is the
    // backend's own wording and no regex over it can be trusted.
    let calls = 0;
    // A clock that advances, so a version that treats this as transient runs out
    // of budget and fails the call count rather than looping forever.
    let clock = 0;
    const result = await pollForTrace({
      client: {
        listTraces: async () => {
          calls += 1;
          throw Object.assign(new Error("Invalid API key"), { exitCode: ExitCode.auth });
        },
      },
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
      ranAt: null,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => {
        clock += 1_000;
        return clock;
      },
    });

    expect(calls).toBe(1);
    expect(result.found).toBe(false);
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
      ranAt: null,
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
  /** The application ran for ten seconds, five minutes into the setup run. */
  const RAN_AT = {
    from: new Date("2026-07-26T12:05:00.000Z"),
    to: new Date("2026-07-26T12:05:10.000Z"),
  };

  /** A page as the backend returns it: newest first, timestamps without a zone. */
  function page(rows: Array<{ id: string; at: string; name?: string }>) {
    return {
      data: rows.map((r) => ({
        trace_id: r.id,
        trace_url: `https://app.example.test/trace/${r.id}`,
        trace_start_time: r.at,
        name: r.name ?? `${r.id}-root`,
      })),
      meta: { limit: rows.length },
    } as never;
  }

  it("takes the trace the application's own run produced, not the project's other traffic", async () => {
    // The hole this closes: with only a start-time bound, a project that
    // already receives traffic — a second service, a teammate, staging — hands
    // the poll somebody else's trace, and the first poll succeeds even when the
    // instrumentation did nothing. `chooseProject` auto-selects when the user
    // has one project, so this is the ordinary case, not an exotic one.
    const result = await pollForTrace({
      client: {
        listTraces: async () =>
          page([
            { id: "ours", at: "2026-07-26T12:05:05.000000" },
            { id: "a-teammate", at: "2026-07-26T12:00:30.000000" },
          ]),
      },
      startedAt: STARTED,
      ranAt: RAN_AT,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    // The teammate's trace is both earlier and still inside the setup run, so
    // the old poll chose it.
    expect(result.found && result.trace.traceId).toBe("ours");
    expect(result.found && result.attribution.basis).toBe("application-run");
    expect(result.found && result.attribution.candidates).toBe(1);
  });

  it("sends the application's window to the endpoint as both bounds", async () => {
    const seen: Array<{ startAfter?: string; endBefore?: string }> = [];
    await pollForTrace({
      client: {
        listTraces: async (params) => {
          seen.push(params);
          return page([]);
        },
      },
      startedAt: STARTED,
      ranAt: RAN_AT,
      timeoutMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(seen[0]?.startAfter).toBe("2026-07-26T12:05:00.000Z");
    // `end_before` is exclusive, so the run's last millisecond stays in frame.
    expect(seen[0]?.endBefore).toBe("2026-07-26T12:05:10.001Z");
  });

  it("labels a trace it can only place inside the setup run, and waits first", async () => {
    // Reported rather than withheld — the user may well recognise it — but
    // reported for what it is, and only once nothing attributable has turned
    // up. The old poll returned this on its first look and called it "your
    // first trace".
    let clock = 0;
    const result = await pollForTrace({
      client: {
        listTraces: async () => page([{ id: "a-teammate", at: "2026-07-26T12:00:30.000000" }]),
      },
      startedAt: STARTED,
      ranAt: RAN_AT,
      timeoutMs: 6_000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    expect(result.found && result.trace.traceId).toBe("a-teammate");
    expect(result.found && result.attribution.basis).toBe("setup-window");
    expect(result.found && result.trace.waitedMs).toBeGreaterThanOrEqual(6_000);
  });

  it("counts the other traffic that landed in the same window", async () => {
    // Nothing in the list response identifies the process that emitted a trace,
    // so a window shared with other traffic is a choice between candidates. The
    // count and the trace's own name are what let a user judge the link.
    const result = await pollForTrace({
      client: {
        listTraces: async () =>
          page([
            { id: "second", at: "2026-07-26T12:05:08.000000" },
            { id: "first", at: "2026-07-26T12:05:02.000000", name: "checkout.handle" },
          ]),
      },
      startedAt: STARTED,
      ranAt: RAN_AT,
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
      ranAt: RAN_AT,
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
      ranAt: null,
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
      ranAt: null,
      timeoutMs: 5_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result.found).toBe(true);
    expect(result.found && result.trace.traceId).toBe("ours");
  });
});
