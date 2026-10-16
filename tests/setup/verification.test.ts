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
import { ExitCode } from "../../src/output.js";
import type { RunProcessOptions, RunProcessResult } from "../../src/setup/exec.js";
import { makeSecret } from "../../src/setup/secret.js";
import {
  THIN_TRACE_MAX_SPANS,
  WINDOW_GRACE_MS,
  isThinTrace,
  pollForTrace,
  spanPhrase,
  thinTraceFinding,
} from "../../src/setup/trace.js";
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
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [],
      interpreter: null,
      runProcess: run,
    });

    expect(runs).toHaveLength(2);
    const [withKey, withoutKey] = runs;
    expect(withKey?.env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    expect(withoutKey?.env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    expect(withKey?.env.TRACEROOT_API_KEY).toBe(KEY);
    // Deleted, not blanked: absent and empty are different to an SDK.
    expect("TRACEROOT_API_KEY" in (withoutKey?.env ?? {})).toBe(false);
  });

  it("puts the virtualenv on PATH for both runs, not only the baseline", async () => {
    // `detect_stack` names the project's check the way the project documents it
    // — `pytest`, not `.venv/bin/pytest` — and that command exists only inside
    // the virtualenv. The baseline was given the virtualenv and these two runs
    // were not, so a project whose check is a repo-local `pytest` measured its
    // baseline fine and then ended the run, after the application had been
    // instrumented correctly, on "`pytest` could not be run".
    const { run, runs } = fakeRunProcess();
    await verifyApplication({
      command: "pytest",
      cwd: "/repo/api",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [],
      interpreter: "/repo/api/.venv/bin/python",
      runProcess: run,
    });

    // Both of them. One run reaching the command and the other not would make
    // the credential-free comparison about which binary was found.
    expect(runs).toHaveLength(2);
    const onPath = `/repo/api/.venv/bin${delimiter}/usr/bin`;
    expect(runs[0]?.env.PATH).toBe(onPath);
    expect(runs[1]?.env.PATH).toBe(onPath);
    // And the virtualenv changes nothing about what the two runs differ by.
    expect(runs[0]?.env.TRACEROOT_API_KEY).toBe(KEY);
    expect("TRACEROOT_API_KEY" in (runs[1]?.env ?? {})).toBe(false);
  });

  it("reports the window the application ran in, so a trace can be tied to it", async () => {
    // The only thing that separates this run's trace from the project's other
    // traffic. Measured around the run that had the credential, because that is
    // the only one that can have emitted anything.
    let clock = Date.parse("2026-07-26T12:00:00.000Z");
    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [],
      interpreter: null,
      runProcess: fakeRunProcess().run,
      now: () => {
        clock += 1000;
        return clock;
      },
    });

    expect(result.ranAt?.from.toISOString()).toBe("2026-07-26T12:00:01.000Z");
    expect(result.ranAt?.to.toISOString()).toBe("2026-07-26T12:00:02.000Z");
  });
});

describe("running the check in the environment the SDK was installed into", () => {
  it("puts the virtualenv's scripts on PATH for both runs", async () => {
    // `detect_stack` names the project's own check as the project documents it
    // — `pytest`, not `.venv/bin/pytest`. That command exists only inside the
    // virtualenv, so without this the spawn fails with ENOENT and the run
    // reports a suite that broke after instrumentation without running one.
    const { run, runs } = fakeRunProcess();
    await verifyApplication({
      command: "pytest",
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [],
      interpreter: "/repo/.venv/bin/python",
      runProcess: run,
    });

    expect(runs).toHaveLength(2);
    for (const recorded of runs) {
      expect(recorded.env.PATH).toBe(`/repo/.venv/bin${delimiter}/usr/bin`);
    }
  });

  it("says a command could not be spawned, rather than reporting an empty failure", async () => {
    // A command that is not installed produces no output at all, so a caller
    // that only knows "it failed" shows the user an empty log and sends them
    // looking through instrumentation that is fine.
    const result = await verifyApplication({
      command: "pytest",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [],
      interpreter: null,
      runProcess: async () => ({
        exitCode: 127,
        output: "",
        durationMs: 4,
        timedOut: false,
        spawnFailed: true,
        spawnErrorCode: "ENOENT",
      }),
    });

    expect(result.verification.passed).toBe(false);
    expect(result.failure?.spawnFailed).toBe(true);
    expect(result.failure?.program).toBe("pytest");
    expect(result.failure?.spawnErrorCode).toBe("ENOENT");
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
    // is a second run *with* the credential and the check passes for free.
    const { file } = repoWithCredentialFile();
    const { run, fileWasThere } = appThatLoadsTheCredentialFile(file);

    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [file],
      interpreter: null,
      runProcess: run,
    });

    expect(result.verification.passed).toBe(false);
    expect(result.failure?.phase).toBe("without");
    // Still a failure, and no baseline was taken. This run established both
    // halves itself — passed with the credential, broke without it — so the
    // claim is self-contained and must not soften into "nobody looked".
    expect(result.verification.outcome).toBe("failed");
    expect(result.failure?.output).toContain("TRACEROOT_API_KEY is not set");
    // In place for the run that is supposed to have the key, gone for the run
    // that is supposed not to.
    expect(fileWasThere).toEqual([true, false]);
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
      host: "https://api.example.test",
      credentialFiles: [file, projectEnv],
      interpreter: null,
      runProcess: run,
    });

    expect(result.verification.passed).toBe(false);
    expect(result.failure?.phase).toBe("without");
    expect(fileWasThere).toEqual([true, false]);
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
        host: "https://api.example.test",
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
      host: "https://api.example.test",
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
    let calls = 0;
    const run = async (): Promise<RunProcessResult> => {
      calls += 1;
      if (calls === 2) {
        throw new Error("spawn exploded");
      }
      return PROCESS_OK;
    };

    await expect(
      verifyApplication({
        command: "npm test",
        cwd: "/repo",
        parentEnv: {},
        credential: makeSecret(KEY),
        host: "https://api.example.test",
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
    let calls = 0;
    const run = async (): Promise<RunProcessResult> => {
      calls += 1;
      // The second run is the credential-free one, with both files parked.
      if (calls === 2) {
        // Parking leaves this run's own credential-stripped copy at the
        // original path, so the directory has to replace that copy rather than
        // appear beside it. Without the removal this is EEXIST from `mkdir`,
        // not the EISDIR from `rename` the test is about.
        rmSync(file, { force: true });
        mkdirSync(file);
      }
      return PROCESS_OK;
    };

    const failure = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      host: "https://api.example.test",
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
    let calls = 0;
    const run = async (): Promise<RunProcessResult> => {
      calls += 1;
      if (calls === 2) {
        // Parking leaves this run's own credential-stripped copy at the
        // original path, so the directory has to replace that copy rather than
        // appear beside it. Without the removal this is EEXIST from `mkdir`,
        // not the EISDIR from `rename` the test is about.
        rmSync(file, { force: true });
        mkdirSync(file);
        throw new Error("spawn exploded");
      }
      return PROCESS_OK;
    };

    const failure = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      host: "https://api.example.test",
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
      host: "https://api.example.test",
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
      host: "https://api.example.test",
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
    // A plain environment: nothing is instrumented yet, so a credential here
    // could not reach any SDK and would only make this run differ from the
    // question being asked.
    expect("TRACEROOT_API_KEY" in (runs[0]?.env ?? {})).toBe(false);
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

    // Deleted rather than blanked, the way the two verification runs do it: an
    // SDK commonly reads an empty string as "configured but blank" and takes a
    // different path than it does for absent.
    expect("TRACEROOT_API_KEY" in (runs[0]?.env ?? {})).toBe(false);
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
      host: "https://api.example.test",
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
    // And the credential-free run is not attempted: it exists to prove the app
    // works without TraceRoot, which a suite failing either way cannot prove.
    expect(runs).toHaveLength(1);
  });

  it("still blames instrumentation when the suite was passing before", async () => {
    const result = await verifyApplication({
      command: "npm test",
      baseline: { ran: true, exitCode: 0, durationMs: 10 },
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [],
      interpreter: null,
      runProcess: exiting(1).run,
    });

    expect(result.verification.outcome).toBe("failed");
    expect(result.failure?.phase).toBe("with");
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
      host: "https://api.example.test",
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
    expect(result.failure).toMatchObject({ phase: "with" });
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
      host: "https://api.example.test",
      credentialFiles: [],
      interpreter: null,
      runProcess: exiting(1).run,
    });

    expect(result.verification.outcome).toBe("inconclusive");
    expect(result.failure).toMatchObject({ phase: "with" });
  });

  it("passes with a baseline recorded beside the result", async () => {
    const result = await verifyApplication({
      command: "npm test",
      baseline: { ran: true, exitCode: 0, durationMs: 10 },
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      host: "https://api.example.test",
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

  it("labels a trace it can only place inside the setup run, and waits for the run's window first", async () => {
    // Reported rather than withheld — the user may well recognise it — but
    // reported for what it is, and not before the run's own window has had the
    // time a trace of its own would need to arrive. The old poll returned this
    // on its first look and called it "your first trace".
    //
    // What it waits is that grace and not the trace budget. A window that
    // closed empty stays empty when the application was never run inside it,
    // which is what a check that exercises instrumented code without reaching
    // the entry point leaves behind — and the whole budget spent waiting for it
    // is two minutes of a spinner over a trace already in the list.
    const TIMEOUT_MS = 120_000;
    let clock = RAN_AT.to.getTime();
    const result = await pollForTrace({
      client: {
        listTraces: async () => page([{ id: "a-teammate", at: "2026-07-26T12:00:30.000000" }]),
      },
      startedAt: STARTED,
      ranAt: RAN_AT,
      timeoutMs: TIMEOUT_MS,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    expect(result.found && result.trace.traceId).toBe("a-teammate");
    expect(result.found && result.attribution.basis).toBe("setup-window");
    // Two kinds of bound, because they catch different mistakes.
    //
    // The first pair is derived from the grace, so tuning the poll schedule
    // cannot leave this test asserting a number the code no longer uses: the
    // lower one proves the wider look was not taken immediately, which would
    // defeat the point of having a window at all, and the upper one proves it
    // followed the grace promptly rather than drifting past it.
    expect(result.found && result.trace.waitedMs).toBeGreaterThanOrEqual(WINDOW_GRACE_MS);
    expect(result.found && result.trace.waitedMs).toBeLessThan(WINDOW_GRACE_MS * 2);
    // The second states the property a user would describe — it did not spend
    // the wait it was given — against this run's own timeout rather than
    // against the grace. Defence in depth rather than a distinct trap: a grace
    // wrong in either direction trips one of the pair above first. It is here
    // so the test still reads as pinning the user-visible outcome, and not only
    // a relationship to an internal constant.
    expect(result.found && result.trace.waitedMs).toBeLessThan(TIMEOUT_MS / 2);
  });

  it("keeps a trace that started after the window out of the run's own frame", async () => {
    // The timestamps carry six fractional digits and `Date.parse` keeps three,
    // so a trace four hundred microseconds after the application stopped parses
    // as having started exactly when it stopped — and the window's upper bound
    // is inclusive, because a trace in the run's last millisecond is the run's.
    // Dropped microseconds therefore do not blur the edge of the window, they
    // move traces across it, and this one belongs on the far side.
    const result = await pollForTrace({
      client: {
        listTraces: async () => page([{ id: "just-after", at: "2026-07-26T12:05:10.000400" }]),
      },
      startedAt: STARTED,
      ranAt: RAN_AT,
      timeoutMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });

    // Still worth showing, and shown for what it is rather than as this run's.
    expect(result.found && result.trace.traceId).toBe("just-after");
    expect(result.found && result.attribution.basis).toBe("setup-window");
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

describe("how much of the application the trace covers", () => {
  const STARTED = new Date("2026-07-26T12:00:00.000Z");

  /**
   * The poll over a run with no window to narrow to, which is the shape that
   * leaves the span count as the only thing under test here.
   */
  function look(rows: unknown[]) {
    return pollForTrace({
      client: { listTraces: async () => ({ data: rows, meta: { limit: rows.length } }) as never },
      startedAt: STARTED,
      ranAt: null,
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
    // could report a trace of a single function as a verified first trace and
    // have nothing in hand to say otherwise with.
    const result = await look([row(7)]);

    expect(result.found && result.attribution.spanCount).toBe(7);
    expect(isThinTrace(result.found ? result.attribution.spanCount : null)).toBe(false);
  });

  it("says a one-span trace is thin, and reports the count that makes it so", async () => {
    const result = await look([row(1)]);

    expect(result.found && result.attribution.spanCount).toBe(1);
    expect(isThinTrace(result.found ? result.attribution.spanCount : null)).toBe(true);
  });

  it("reports no count rather than no spans when the response omits the field", async () => {
    // The distinction the null exists for. A deployment that does not carry
    // `span_count` has told this process nothing, and reading that silence as a
    // trace with nothing in it would make the run say the opposite of the truth
    // about the one case it is meant to catch.
    const result = await look([row(undefined)]);

    expect(result.found).toBe(true);
    expect(result.found && result.attribution.spanCount).toBeNull();
    expect(isThinTrace(result.found ? result.attribution.spanCount : null)).toBe(false);
  });

  it("copies the count onto the record the report reads, not only the attribution", async () => {
    // The thin-trace machinery is wired over `trace.spanCount`: the report's
    // verdict and its trace row both read the count off the verification, and
    // the poll filled in only the attribution's copy. So every surface that can
    // remark on a thin trace existed and the count never arrived at any of
    // them. `--resume` renders the report from the checkpointed trace as well,
    // which is the other half of why the count belongs on the record rather
    // than only in the invocation that polled.
    const thin = await look([row(1)]);
    expect(thin.found && thin.trace.spanCount).toBe(1);
    expect(isThinTrace(thin.found ? thin.trace.spanCount : null)).toBe(true);

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
    expect(isThinTrace(result.found ? result.trace.spanCount : null)).toBe(false);
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

  it("puts the threshold at one span, which needs nothing known about the program", async () => {
    // Bounds derived from the constant rather than written out, so moving the
    // threshold moves this test with it instead of leaving it asserting a
    // number the code no longer uses. The absolute assertion is what stops the
    // relationship from holding vacuously at some other value.
    expect(THIN_TRACE_MAX_SPANS).toBe(1);
    expect(isThinTrace(THIN_TRACE_MAX_SPANS)).toBe(true);
    expect(isThinTrace(THIN_TRACE_MAX_SPANS + 1)).toBe(false);
    // Unknown is not small, and neither spelling of unknown is.
    expect(isThinTrace(null)).toBe(false);
    expect(isThinTrace(undefined)).toBe(false);
  });

  it("writes the count as prose, so one span does not read as '1 spans'", () => {
    // These strings reach a user: the report's verdict, the report's trace row
    // and the line the poll closes on all print them, which is why there is one
    // of each rather than three.
    expect(spanPhrase(1)).toBe("a single span");
    expect(spanPhrase(7)).toBe("7 spans");
    expect(spanPhrase(0)).toBe("no spans");
    expect(thinTraceFinding(1)).toBe(
      "holds a single span: one instrumented function ran, and nothing instrumented ran inside it",
    );
    // No claim about the application in it, in either branch. What the run
    // knows is the count; what the program's shape is, it does not.
    expect(thinTraceFinding(0)).toBe("holds no spans: the response reports nothing in it at all");
  });
});
