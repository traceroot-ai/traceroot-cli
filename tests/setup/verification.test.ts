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
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSetupApi } from "../../src/api/setup.js";
import type { RunProcessOptions, RunProcessResult } from "../../src/setup/exec.js";
import { makeSecret } from "../../src/setup/secret.js";
import { pollForTrace, spanPhrase } from "../../src/setup/trace.js";
import { runBaselineCheck, verifyApplication } from "../../src/setup/verify.js";
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

  it("puts the virtualenv on PATH for the check, as for the baseline", async () => {
    // `detect_stack` names the project's check the way the project documents it
    // — `pytest`, not `.venv/bin/pytest` — and that command exists only inside
    // the virtualenv. The baseline was given the virtualenv and the
    // verification was not, so a project whose check is a repo-local `pytest`
    // measured its baseline fine and then ended the run, after the application
    // had been instrumented correctly, on "`pytest` could not be run".
    const { run, runs } = fakeRunProcess();
    await verifyApplication({
      command: "pytest",
      cwd: "/repo/api",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: "/repo/api/.venv/bin/python",
      runProcess: run,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.env.PATH).toBe(`/repo/api/.venv/bin${delimiter}/usr/bin`);
    // And the virtualenv changes nothing about TraceRoot being off.
    expect("TRACEROOT_API_KEY" in (runs[0]?.env ?? {})).toBe(false);
    expect(runs[0]?.env.TRACEROOT_ENABLED).toBe("false");
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
    // No baseline was taken, so this run cannot say the instrumentation is
    // why: with one run, and that one with TraceRoot off, "passed with the key
    // and broke without it" is no longer something it observed. The next test
    // is the case where it can.
    expect(result.verification.outcome).toBe("inconclusive");
    expect(result.failure?.output).toContain("TRACEROOT_API_KEY is not set");
    // Gone for the only run there is.
    expect(fileWasThere).toEqual([false]);
    expect(result.withheld).toEqual([file]);
  });

  it("blames the instrumentation for it when the check passed beforehand", async () => {
    // The agent route measures the check before anything is edited. A suite
    // that passed then and fails with TraceRoot off now is an application that
    // came to depend on TraceRoot being configured, which is the regression
    // this run exists to stop.
    const { file } = repoWithCredentialFile();
    const { run } = appThatLoadsTheCredentialFile(file);

    const result = await verifyApplication({
      command: "npm test",
      baseline: { ran: true, exitCode: 0, durationMs: 10 },
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      credentialFiles: [file],
      interpreter: null,
      runProcess: run,
    });

    expect(result.verification.outcome).toBe("failed");
    expect(result.failure?.output).toContain("TRACEROOT_API_KEY is not set");
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
      // Parking leaves this run's own credential-stripped copy at the
      // original path, so the directory has to replace that copy rather than
      // appear beside it. Without the removal this is EEXIST from `mkdir`,
      // not the EISDIR from `rename` the test is about.
      rmSync(file, { force: true });
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
      // Parking leaves this run's own credential-stripped copy at the
      // original path, so the directory has to replace that copy rather than
      // appear beside it. Without the removal this is EEXIST from `mkdir`,
      // not the EISDIR from `rename` the test is about.
      rmSync(file, { force: true });
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

describe("telling a suite setup broke from one that was already broken", () => {
  /** A runner whose every launch exits with `code`. */
  function exiting(code: number) {
    return fakeRunProcess({ results: { npm: { exitCode: code, output: "1 failed" } } });
  }

  it("measures the check once before anything is instrumented", async () => {
    const { run, runs } = exiting(1);
    const baseline = await runBaselineCheck({
      command: "npm test",
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      interpreter: null,
      runProcess: run,
    });

    expect(baseline).toMatchObject({ ran: true, exitCode: 1 });
    expect(runs).toHaveLength(1);
    // TraceRoot off, exactly as the check has it. A repository that already
    // carries TraceRoot exports from its suite the moment a key is reachable,
    // and a baseline taken with TraceRoot in a different state than the check
    // is not a baseline for it.
    expect("TRACEROOT_API_KEY" in (runs[0]?.env ?? {})).toBe(false);
    expect(runs[0]?.env.TRACEROOT_ENABLED).toBe("false");
  });

  it("reports no baseline for a command it could not parse or spawn", async () => {
    const unparsable = await runBaselineCheck({
      command: "   ",
      cwd: "/repo",
      parentEnv: {},
      interpreter: null,
      runProcess: fakeRunProcess().run,
    });
    expect(unparsable.ran).toBe(false);

    // A missing binary is not evidence about the suite, and reading it as "this
    // project was already broken" would excuse a real failure.
    const missing = await runBaselineCheck({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      interpreter: null,
      runProcess: fakeRunProcess({ results: { npm: { spawnFailed: true, exitCode: 127 } } }).run,
    });
    expect(missing.ran).toBe(false);
  });

  it("runs the baseline with the virtualenv on PATH, as the real check does", async () => {
    // `detect_stack` names the command the way the project documents it —
    // `pytest`, not `.venv/bin/pytest` — because that is what a user types. It
    // resolves for them because their shell has the virtualenv activated; the
    // CLI's own environment does not. Without this the spawn fails with ENOENT
    // before a single test runs, which is the commonest shape of Python project
    // there is, and the measurement never happens at all.
    const { run, runs } = fakeRunProcess();
    const baseline = await runBaselineCheck({
      command: "pytest",
      cwd: "/repo/api",
      parentEnv: { PATH: "/usr/bin" },
      interpreter: "/repo/api/.venv/bin/python",
      runProcess: run,
    });

    expect(baseline.ran).toBe(true);
    expect(runs[0]?.env.PATH).toBe(`/repo/api/.venv/bin${delimiter}/usr/bin`);
  });

  it("runs the baseline without an ambient credential, and leaves the caller's own env alone", async () => {
    // The assertion above covers a parent environment that had no key in it. A
    // developer's shell commonly exports one, and a baseline that inherits it
    // is no longer the run it gets compared against: this measurement exists to
    // say what the project's check did before this run touched anything.
    const { run, runs } = fakeRunProcess();
    const activated = { PATH: "/usr/bin", TRACEROOT_API_KEY: "tr-ambient-shell-value" };
    await runBaselineCheck({
      command: "pytest",
      cwd: "/repo/api",
      parentEnv: activated,
      interpreter: "/repo/api/.venv/bin/python",
      runProcess: run,
    });

    // Deleted rather than blanked, the way the verification does it: an SDK
    // commonly reads an empty string as "configured but blank" and takes a
    // different path than it does for absent.
    expect("TRACEROOT_API_KEY" in (runs[0]?.env ?? {})).toBe(false);
    expect(runs[0]?.env.TRACEROOT_ENABLED).toBe("false");
    expect(runs[0]?.env.PATH).toBe(`/repo/api/.venv/bin${delimiter}/usr/bin`);
    expect(activated.TRACEROOT_API_KEY).toBe("tr-ambient-shell-value");

    // Including on the path with no virtualenv to add, where the environment
    // the baseline is handed is the caller's own object rather than a copy of
    // it. Removing the key in place there would reach back into the run.
    const bare = { PATH: "/usr/bin", TRACEROOT_API_KEY: "tr-ambient-shell-value" };
    const plain = fakeRunProcess();
    await runBaselineCheck({
      command: "npm test",
      cwd: "/repo",
      parentEnv: bare,
      interpreter: null,
      runProcess: plain.run,
    });

    expect("TRACEROOT_API_KEY" in (plain.runs[0]?.env ?? {})).toBe(false);
    expect(bare.TRACEROOT_API_KEY).toBe("tr-ambient-shell-value");
  });

  it("calls a failure inconclusive when the suite was already failing", async () => {
    // The end-to-end run this exists for ended on "pytest failed after
    // instrumentation" for a suite that was red before setup started.
    const { run, runs } = exiting(1);
    const result = await verifyApplication({
      command: "npm test",
      baseline: { ran: true, exitCode: 1, durationMs: 10 },
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: run,
    });

    expect(result.verification.outcome).toBe("inconclusive");
    expect(result.verification.passed).toBe(false);
    // No failure to report, which is what stops the caller naming
    // instrumentation as the cause.
    expect(result.failure).toBeNull();
    expect(result.verification.baseline).toMatchObject({ ran: true, exitCode: 1 });
    expect(runs).toHaveLength(1);
  });

  it("still blames instrumentation when the suite was passing before", async () => {
    const result = await verifyApplication({
      command: "npm test",
      baseline: { ran: true, exitCode: 0, durationMs: 10 },
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: exiting(1).run,
    });

    expect(result.verification.outcome).toBe("failed");
    expect(result.failure?.output).toContain("1 failed");
  });

  it("names no cause when nothing measured the check beforehand", async () => {
    // The routes that hand the instrumentation task over take no baseline, and
    // a checkpoint written before baselines existed carries none. "Nobody
    // looked" is a weaker statement than either answer a baseline gives, and
    // reporting it as a failure of the instrumentation is the same invented
    // cause this mechanism exists to remove, pointed the other way.
    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: exiting(1).run,
    });

    expect(result.verification.baseline).toBeNull();
    expect(result.verification.outcome).toBe("inconclusive");
    expect(result.verification.passed).toBe(false);
    // Not an excuse, though. Unlike a suite already known to be red, this one
    // has explained nothing, so the output still comes back for the caller to
    // show — it is the only diagnostic such a run has.
    expect(result.failure?.output).toContain("1 failed");
  });

  it("treats a baseline that never ran as no baseline at all", async () => {
    // `runBaselineCheck` reports an un-run result for a command it could not
    // spawn, and an un-run result carries `exitCode: null`. Reading that as
    // "did not exit 0" would turn a missing binary into evidence that the
    // project was already broken.
    const result = await verifyApplication({
      command: "npm test",
      baseline: { ran: false, exitCode: null, durationMs: 0 },
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: exiting(1).run,
    });

    expect(result.verification.outcome).toBe("inconclusive");
    expect(result.failure?.output).toContain("1 failed");
  });

  it("passes with a baseline recorded beside the result", async () => {
    const result = await verifyApplication({
      command: "npm test",
      baseline: { ran: true, exitCode: 0, durationMs: 10 },
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: [],
      interpreter: null,
      runProcess: fakeRunProcess().run,
    });

    expect(result.verification.outcome).toBe("passed");
    expect(result.verification.passed).toBe(true);
    expect(result.verification.baseline?.exitCode).toBe(0);
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
