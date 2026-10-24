import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExitCode } from "../../src/output.js";
import type { RunProcessOptions, RunProcessResult } from "../../src/setup/exec.js";
import { makeSecret } from "../../src/setup/secret.js";
import { pollForTrace, spanPhrase } from "../../src/setup/trace.js";
import { verifyApplication } from "../../src/setup/verify.js";
import { fakeRunProcess } from "./helpers.js";

const KEY = "tr-a-long-enough-value";

/** Every root this file makes, so none is left in the system tmpdir. */
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

/** A repository with the credential file this run would have written in it. */
function repoWithCredentialFile(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "traceroot-verify-"));
  roots.push(root);
  const file = join(root, ".env.traceroot");
  writeFileSync(file, `TRACEROOT_API_KEY=${KEY}\n`, "utf8");
  return { root, file };
}

const PROCESS_OK: RunProcessResult = {
  exitCode: 0,
  output: "",
  durationMs: 1,
  timedOut: false,
  spawnFailed: false,
};

describe("running the project's own check", () => {
  it("runs it once, with the key absent and TraceRoot switched off", async () => {
    // Both halves, because each closes a different door. The key is gone even
    // when the user's shell exported it, and `TRACEROOT_ENABLED=false` holds
    // against a key the application loads for itself from a file nobody moved
    // aside: `@observe` starts the SDK on its own whenever a key is reachable,
    // and a check that ran with one sent a project's whole test suite into the
    // user's project, where the trace poll took a unit test for the first trace.
    const { run, runs } = fakeRunProcess();
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      TRACEROOT_API_KEY: KEY,
      TRACEROOT_HOST_URL: "https://stale.example.test",
    };
    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv,
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: run,
    });

    expect(runs).toHaveLength(1);
    const env = runs[0]?.env ?? {};
    // Deleted, not blanked: absent and empty are different to an SDK.
    expect("TRACEROOT_API_KEY" in env).toBe(false);
    expect(env.TRACEROOT_ENABLED).toBe("false");
    expect(Object.values(env)).not.toContain(KEY);
    expect(result.verification.run).toEqual({ ran: true, exitCode: 0, durationMs: 1 });
    expect(result.verification.passed).toBe(true);
    // The switch is the child's. The CLI's own environment keeps its key.
    expect(parentEnv.TRACEROOT_API_KEY).toBe(KEY);
  });

  it("reports a failing check with its output", async () => {
    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: fakeRunProcess({
        results: { npm: { exitCode: 1, output: "1 failed" } },
      }).run,
    });

    expect(result.verification.passed).toBe(false);
    expect(result.verification.run).toEqual({ ran: true, exitCode: 1, durationMs: 1 });
    expect(result.failure).toEqual({ output: "1 failed" });
  });
});

describe("proving the application runs without the credential", () => {
  /**
   * An application whose instrumentation hard-fails unless a key is reachable —
   * the failure mode the credential-free run exists to catch — and which reads
   * the credential file from its entry point, as the instrumentation task tells
   * the agent to do.
   */
  function appThatLoadsTheCredentialFile(...files: string[]): {
    run: (o: RunProcessOptions) => Promise<RunProcessResult>;
    fileWasThere: boolean[];
  } {
    const fileWasThere: boolean[] = [];
    const run = async (o: RunProcessOptions): Promise<RunProcessResult> => {
      // Any of them: a dotenv loader reads whichever file is there, so one left
      // behind is enough to hand the run the key.
      const onDisk = files.some(
        (file) => existsSync(file) && readFileSync(file, "utf8").includes("TRACEROOT_API_KEY="),
      );
      fileWasThere.push(onDisk);
      const reachable = o.env.TRACEROOT_API_KEY !== undefined || onDisk;
      return {
        ...PROCESS_OK,
        exitCode: reachable ? 0 : 1,
        output: reachable ? "ok" : "RuntimeError: TRACEROOT_API_KEY is not set",
      };
    };
    return { run, fileWasThere };
  }

  it("fails the check when the application reads the key back off disk", async () => {
    // Deleting TRACEROOT_API_KEY from the child environment is not enough. The
    // instrumentation task tells the agent to add `load_dotenv(".env.traceroot")`
    // to the entry point, so with the file still on disk the credential-free run
    // is a run *with* the credential and the check passes for free.
    const { file } = repoWithCredentialFile();
    const { run, fileWasThere } = appThatLoadsTheCredentialFile(file);

    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [file],
      interpreter: null,
      runProcess: run,
    });

    expect(result.verification.passed).toBe(false);
    expect(result.failure?.output).toContain("TRACEROOT_API_KEY is not set");
    // Gone for the only run there is.
    expect(fileWasThere).toEqual([false]);
    expect(result.withheld).toEqual([file]);
  });

  it("withholds every file the key can be read out of, not only the one it wrote", async () => {
    // The file this run wrote is not the only file the application reads. A key
    // that was already in the project's own `.env` is never written anywhere,
    // so the run has no file of its own to name — and the entry point goes on
    // loading that `.env` and finding the key in it. Withholding only what this
    // run wrote leaves the credential-free run holding the credential, and the
    // check it exists to make passes without being made.
    const { root, file } = repoWithCredentialFile();
    const projectEnv = join(root, ".env");
    writeFileSync(projectEnv, `DATABASE_URL=postgres:///app\nTRACEROOT_API_KEY=${KEY}\n`, "utf8");
    const { run, fileWasThere } = appThatLoadsTheCredentialFile(file, projectEnv);

    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [file, projectEnv],
      interpreter: null,
      runProcess: run,
    });

    expect(result.verification.passed).toBe(false);
    expect(fileWasThere).toEqual([false]);
    expect(result.withheld).toEqual([file, projectEnv]);
    // And the project's file comes back with everything else that was in it.
    expect(readFileSync(projectEnv, "utf8")).toContain("DATABASE_URL=postgres:///app");
  });

  it("refuses to park over a copy an interrupted run left behind", async () => {
    // `rename` replaces its target without a word on POSIX, and the target here
    // holds the user's own file: a run killed outright while the application
    // ran without its credential leaves it parked, and the next run writes a
    // fresh credential file in its place. Parking over it would make the
    // interrupted run's copy the one that disappears.
    const { file } = repoWithCredentialFile();
    const stranded = `${file}.traceroot-setup-hidden`;
    writeFileSync(stranded, `DATABASE_URL=postgres:///app\nTRACEROOT_API_KEY=${KEY}\n`, "utf8");

    await expect(
      verifyApplication({
        command: "npm test",
        cwd: "/repo",
        parentEnv: {},
        credential: makeSecret(KEY),
        credentialFiles: [file],
        interpreter: null,
        runProcess: fakeRunProcess().run,
      }),
    ).rejects.toThrow(/is already there/);

    expect(readFileSync(stranded, "utf8")).toContain("DATABASE_URL=postgres:///app");
    expect(readFileSync(file, "utf8")).toBe(`TRACEROOT_API_KEY=${KEY}\n`);
  });

  it("puts the credential file back, contents intact", async () => {
    const { root, file } = repoWithCredentialFile();
    const { run } = appThatLoadsTheCredentialFile(file);

    await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [file],
      interpreter: null,
      runProcess: run,
    });

    expect(readFileSync(file, "utf8")).toBe(`TRACEROOT_API_KEY=${KEY}\n`);
    // And nothing left parked beside it.
    expect(readdirSync(root)).toEqual([".env.traceroot"]);
  });

  it("puts the credential file back when the run throws", async () => {
    // Losing a user's credential file because verification crashed would be a
    // worse bug than the one the move exists to fix.
    const { root, file } = repoWithCredentialFile();
    const run = async (): Promise<RunProcessResult> => {
      throw new Error("spawn exploded");
    };

    await expect(
      verifyApplication({
        command: "npm test",
        cwd: "/repo",
        parentEnv: {},
        credential: makeSecret(KEY),
        credentialFiles: [file],
        interpreter: null,
        runProcess: run,
      }),
    ).rejects.toThrow("spawn exploded");

    expect(readFileSync(file, "utf8")).toBe(`TRACEROOT_API_KEY=${KEY}\n`);
    expect(readdirSync(root)).toEqual([".env.traceroot"]);
  });

  it("puts the rest back when one credential file cannot be restored", async () => {
    // One failed rename used to end the restoration there and then, leaving
    // every file after it parked under a name its owner never chose — the loss
    // the whole move-aside exists to prevent, inflicted on the files it was not
    // even failing on.
    //
    // A directory in the way of the first file's own path is the cheapest way
    // to make a rename fail for a reason the process cannot talk itself out of,
    // and it is one of the cases `unpark` is deliberately unconditional about:
    // something has appeared at the original path, and the parked copy is still
    // the user's only copy of what was there.
    const { root, file } = repoWithCredentialFile();
    const projectEnv = join(root, ".env");
    writeFileSync(projectEnv, `DATABASE_URL=postgres:///app\nTRACEROOT_API_KEY=${KEY}\n`, "utf8");
    // Both files are parked while the check runs.
    const run = async (): Promise<RunProcessResult> => {
      mkdirSync(file);
      return PROCESS_OK;
    };

    const failure = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [file, projectEnv],
      interpreter: null,
      runProcess: run,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    // The file parked behind the one that could not go back went back, with
    // everything that was in it.
    expect(readFileSync(projectEnv, "utf8")).toContain("DATABASE_URL=postgres:///app");
    expect(existsSync(`${projectEnv}.traceroot-setup-hidden`)).toBe(false);
    // And the failure still surfaces rather than being spent on the files it
    // did not stop, naming the file and where it is now — that one the user has
    // to move back by hand.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not put .*\.env\.traceroot back/);
    expect((failure as Error).message).toContain(`${file}.traceroot-setup-hidden`);
    expect(readFileSync(`${file}.traceroot-setup-hidden`, "utf8")).toBe(
      `TRACEROOT_API_KEY=${KEY}\n`,
    );
  });

  it("reports the file it could not put back even when the run itself failed", async () => {
    // Two failures at once, and they are not equal. A check that crashed is a
    // report this run was going to make either way, while a file left under a
    // name its owner never chose outlives the process and nobody but them can
    // move it back. So the restoration is what the error says, and the crash
    // rides along as its cause rather than being the thing that gets heard.
    const { root, file } = repoWithCredentialFile();
    const projectEnv = join(root, ".env");
    writeFileSync(projectEnv, `TRACEROOT_API_KEY=${KEY}\n`, "utf8");
    const run = async (): Promise<RunProcessResult> => {
      mkdirSync(file);
      throw new Error("spawn exploded");
    };

    const failure = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [file, projectEnv],
      interpreter: null,
      runProcess: run,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect((failure as Error).message).toMatch(/could not put .*\.env\.traceroot back/);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toBe("spawn exploded");
    // And the one it could put back is back, crash or no crash.
    expect(existsSync(`${projectEnv}.traceroot-setup-hidden`)).toBe(false);
    expect(readFileSync(projectEnv, "utf8")).toBe(`TRACEROOT_API_KEY=${KEY}\n`);
  });

  it("moves nothing when this run wrote no credential file", async () => {
    // A key that resolved from the user's own config is never written to a
    // file, and there is nothing to move aside.
    const { root } = repoWithCredentialFile();
    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: fakeRunProcess().run,
    });

    expect(result.withheld).toEqual([]);
    expect(readdirSync(root)).toEqual([".env.traceroot"]);
  });

  it("names a file that is not there without failing the run", async () => {
    const { root, file } = repoWithCredentialFile();
    rmSync(file);
    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [file],
      interpreter: null,
      runProcess: fakeRunProcess().run,
    });

    expect(result.verification.passed).toBe(true);
    expect(result.withheld).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
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
