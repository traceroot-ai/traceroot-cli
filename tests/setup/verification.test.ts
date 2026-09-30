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
});

describe("choosing which trace the run produced", () => {
  const STARTED = new Date("2026-07-26T12:00:00.000Z");

  /** A page as the backend returns it: newest first, timestamps without a zone. */
  function page(rows: Array<{ id: string; at: string }>) {
    return {
      data: rows.map((r) => ({
        trace_id: r.id,
        trace_url: `https://app.example.test/trace/${r.id}`,
        trace_start_time: r.at,
      })),
      meta: { limit: rows.length },
    } as never;
  }

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
