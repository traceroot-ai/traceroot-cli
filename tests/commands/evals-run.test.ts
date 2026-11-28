import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvalsRunOptions, runEvalsRun } from "../../src/commands/evals-run.js";
import { type CaseLine, parseCaseLines } from "../../src/eval/protocol.js";
import { meanDuration, scoreMeans } from "../../src/eval/report.js";
import { getVersion } from "../../src/version.js";
import { CLEAR_LINE, frames, screen } from "../helpers/screen.js";
import { StringSink } from "../helpers/stringSink.js";
import {
  STUB_API_KEY,
  STUB_PROJECT_ID,
  type TraceRootStub,
  startTraceRootStub,
} from "../helpers/traceRootStub.js";

/**
 * `traceroot evals run`, end to end: the built CLI in a project of its own, with a stub runner
 * (tests/helpers/evalRunnerStub.cjs) standing in for the SDK's. The stub replays the runs recorded
 * from the released SDKs, so what the command reads is what a real runner writes.
 */

const BIN = fileURLToPath(new URL("../../bin/traceroot.mjs", import.meta.url));
const DIST_CLI = new URL("../../dist/cli.js", import.meta.url);
const STUB = fileURLToPath(new URL("../helpers/evalRunnerStub.cjs", import.meta.url));

/** The Git notice traceroot 0.5.1 prints when it finds no Git repository or commit. */
const GIT_NOTICE =
  "TraceRoot: git context incomplete (repo=unset, ref=unset). The AI agent needs both to correlate traces to source. Set TRACEROOT_GIT_REPO / TRACEROOT_GIT_REF — see https://docs.traceroot.ai/tracing/git-context";
const FIXTURES = fileURLToPath(new URL("../fixtures/eval/", import.meta.url));
const PYTHON = "python-0.5.1";
const TYPESCRIPT = "typescript-0.8.1";
/** The run id every recorded fixture saved its run under. */
const RECORDED_RUN_ID = "run_00000000000000000000000001";
/** In the CLI's environment, so a test can check that no process it starts gets it. */
const FAKE_KEY = "tr-fake-0000";

/** The recorded `beta` case, which the recorded regressions break. */
const BETA = "tc_7d6e5d505f6ca7767380";

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "tr-evals-run-")));
});

afterEach(() => {
  const pid = runnerPid();
  if (pid !== null && isRunning(pid)) {
    process.kill(pid, "SIGKILL");
  }
  rmSync(project, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A path as one POSIX shell word. */
function shellWord(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** A project whose `.venv/bin/python` is the stub, reporting `traceroot` as installed. */
function pythonProject(traceroot = "0.5.1"): void {
  const venv = join(project, ".venv");
  write(join(venv, "stub.json"), JSON.stringify({ traceroot }));
  const python = join(venv, "bin", "python");
  write(
    python,
    `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(STUB)} python ${shellWord(venv)} "$@"\n`,
  );
  chmodSync(python, 0o755);
}

/** A project with @traceroot-ai/traceroot, whose runner is the stub, and tsx unless left out. */
function nodeProject(options: { tsx?: boolean } = {}): void {
  const sdk = join(project, "node_modules", "@traceroot-ai", "traceroot");
  write(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@traceroot-ai/traceroot",
      version: "0.8.1",
      exports: { ".": "./dist/index.js" },
    }),
  );
  write(join(sdk, "dist", "index.js"), "");
  write(join(sdk, "dist", "eval", "runner.js"), `require(${JSON.stringify(STUB)});\n`);
  if (options.tsx !== false) {
    const tsx = join(project, "node_modules", "tsx");
    write(
      join(tsx, "package.json"),
      JSON.stringify({ name: "tsx", version: "4.23.15", exports: { ".": "./dist/loader.mjs" } }),
    );
    write(join(tsx, "dist", "loader.mjs"), "");
  }
}

interface RunSpec {
  replay?: string;
  run_id?: string;
  replace?: [string, string][];
  unfinished?: boolean;
  events?: object[];
  exit?: number;
  wait?: boolean;
  chatty?: boolean;
  stderr?: string;
}

/** An evaluation file that tells the stub what to do. `replay` names a recorded scenario. */
function evalFile(name: string, spec: RunSpec): string {
  const replay = spec.replay === undefined ? {} : { replay: join(FIXTURES, spec.replay) };
  write(join(project, name), JSON.stringify({ ...spec, ...replay }));
  return name;
}

/** Saves a recorded run under `.traceroot/eval/runs` as `id`, the way a first run would have. */
function saveRun(scenario: string, id: string, replace: [string, string][] = []): void {
  const runs = join(FIXTURES, scenario, "runs");
  const pairs: [string, string][] = [[RECORDED_RUN_ID, id], ...replace];
  const edit = (text: string) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
  for (const name of readdirSync(runs)) {
    write(
      join(project, ".traceroot", "eval", "runs", edit(name)),
      edit(readFileSync(join(runs, name), "utf8")),
    );
  }
}

/** The CLI's environment: no ambient credentials, a fake key, and a host nothing listens on. */
function cliEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: project,
    TRACEROOT_API_KEY: FAKE_KEY,
    TRACEROOT_HOST_URL: "http://127.0.0.1:9",
    ...(process.env.FORCE_COLOR === undefined ? {} : { FORCE_COLOR: process.env.FORCE_COLOR }),
  };
}

interface Result {
  status: number | null;
  /** stdout and stderr with any color removed. */
  stdout: string;
  stderr: string;
  /** stdout and stderr as written. */
  raw: { stdout: string; stderr: string };
}

function result(status: number | null, stdout: string, stderr: string): Result {
  return {
    status,
    stdout: stripVTControlCharacters(stdout),
    stderr: stripVTControlCharacters(stderr),
    raw: { stdout, stderr },
  };
}

function evalsRun(...args: string[]): Result {
  const run = spawnSync(process.execPath, [BIN, "evals", "run", ...args], {
    cwd: project,
    encoding: "utf8",
    env: cliEnv(),
  });
  return result(run.status, run.stdout, run.stderr);
}

/** Starts the CLI on a waiting stub, sends it `signal` once the runner is running, and waits. */
function interrupt(signal: NodeJS.Signals, ...args: string[]): Promise<Result> {
  return whileRunning((child) => child.kill(signal), ...args);
}

/** Starts the CLI on a waiting stub, does `act` to it once the runner is running, and waits. */
async function whileRunning(
  act: (child: ChildProcessWithoutNullStreams) => void,
  ...args: string[]
): Promise<Result> {
  const child = spawn(process.execPath, [BIN, "evals", "run", ...args], {
    cwd: project,
    env: cliEnv(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  await new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("runner ready")) {
        resolve();
      }
    });
    void closed.then(() => reject(new Error(`the CLI exited first:\n${stdout}${stderr}`)));
  });
  act(child);
  return result(await closed, stdout, stderr);
}

function runnerPid(): number | null {
  const path = join(project, "runner.pid");
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the runner started, which the stub records before anything else. */
function runnerStarted(): boolean {
  return runnerPid() !== null;
}

/** What the runner, or the Python probe, was given. */
function seen(file: string): Record<string, string | null> {
  return JSON.parse(readFileSync(join(project, file), "utf8")) as Record<string, string | null>;
}

function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

/** The one `--json` error envelope on stderr. */
function envelope(stderr: string): { code: string; message: string } {
  const last = stderr.trim().split("\n").at(-1) ?? "";
  return (JSON.parse(last) as { error: { code: string; message: string } }).error;
}

describe("evals run without a baseline", () => {
  it("runs the file, prints each evaluation with its run id, mean case duration, score means and saved files, says no baseline was checked, and exits 0", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/one-fails`, run_id: "run_first" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      [
        "uppercase · run_first · completed",
        "  3 cases · 0 errored · mean 1.5 ms per case",
        "  SCORE        MEAN   SCORED  PASSED  FAILED",
        "  exact_match  0.667  3 of 3  2       1",
        "  not_empty    1      3 of 3  3       0",
        "",
        "Regression check: skipped, because no baseline was given.",
        "",
        "Run file   .traceroot/eval/runs/run_first.json",
        "Case file  .traceroot/eval/runs/run_first.cases.jsonl",
        "",
        "To compare the next run with this one:",
        "  traceroot evals run x_eval.py --baseline run_first",
        "",
      ].join("\n"),
    );
    expect(existsSync(join(project, ".traceroot", "eval", "runs", "run_first.json"))).toBe(true);
  });

  it("sends the runner's own output to stderr, and says which runner it started", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = evalsRun("x_eval.py");

    expect(run.stderr).toContain("runner stdout\n");
    expect(run.stderr).toContain("runner stderr\n");
    expect(run.stderr).toContain(
      `Running x_eval.py with traceroot 0.5.1 on Python 3.12.4 (${join(".venv", "bin", "python")})`,
    );
    expect(run.stdout).not.toContain("runner");
  });

  it("wraps the line saying what runs on a narrow terminal, never inside the file's path", async () => {
    pythonProject();
    const file = evalFile("support triage agent eval.py", { replay: `${PYTHON}/all-pass` });
    // A terminal 30 columns wide; CI keeps the progress line out of what it holds.
    const err = Object.assign(new StringSink(true), { columns: 30 });

    await runEvalsRun({
      file,
      json: false,
      upload: null,
      cwd: project,
      env: { ...cliEnv(), CI: "true" },
      writers: { out: new StringSink(false), err },
    });

    expect(stripVTControlCharacters(err.data).split("\n").slice(0, 4)).toEqual([
      "Running",
      "  support triage agent eval.py",
      "  with traceroot 0.5.1 on",
      "  Python 3.12.4",
    ]);
  });

  it("leaves the SDK's Git notice out of a local run, and passes an application's line that mentions it as written", () => {
    pythonProject();
    const logged = `WARNING:traceroot.client:${GIT_NOTICE}`;
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, stderr: `${GIT_NOTICE}\n${logged}\n` });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(`runner stderr\n${logged}\n`);
    expect(run.stderr).not.toContain(`\n${GIT_NOTICE}`);
    expect(run.stderr).not.toContain("warning: no Git");
  });

  it("gives neither the runner nor the Python probe the API key, and turns tracing off", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    evalsRun("x_eval.py");

    for (const file of ["runner-env.json", join(".venv", "probe-env.json")]) {
      expect(seen(file)).toMatchObject({ api_key: null, enabled: "false", options: "{}" });
    }
    expect(seen(join(".venv", "probe-env.json")).event_file).toBeNull();
    expect(seen("runner-env.json").event_file).not.toBeNull();
  });

  it("leaves the duration out when the runner timed no case", () => {
    pythonProject();
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_first",
      replace: [['"duration_ms": 1.5', '"duration_ms": null']],
    });

    const run = evalsRun("x_eval.py");
    const document = json(evalsRun("x_eval.py", "--json").stdout);

    expect(run.stdout).toContain("uppercase · run_first · completed\n  3 cases · 0 errored\n");
    expect(document).toMatchObject({ runs: [{ duration_ms: { mean: null, count: 0 } }] });
  });

  it("counts the errors of a run that has some, names each errored case, and scores the mean over the cases that gave one", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/task-error`, run_id: "run_first" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      [
        "uppercase · run_first · completed with errors",
        "  3 cases · 1 errored (1 task error, 0 scorer errors) · mean 1.5 ms per case",
        "  SCORE        MEAN  SCORED  PASSED  FAILED",
        "  exact_match  1     2 of 3  2       0",
        "  not_empty    1     2 of 3  2       0",
        "  Errors",
        "    CASE                     ERROR",
        `    ${BETA}  task: ValueError: cannot convert 'beta'`,
        "",
        "Regression check: skipped, because no baseline was given.",
        "",
        "Run file   .traceroot/eval/runs/run_first.json",
      ].join("\n"),
    );
  });

  it("names a scorer that raised apart from the task, without a baseline", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/scorer-error-versioned`, run_id: "run_first" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      [
        "  3 cases · 1 errored (0 task errors, 1 scorer error) · mean 1.5 ms per case",
        "  SCORE        MEAN  SCORED  PASSED  FAILED",
        "  exact_match  1     3 of 3  3       0",
        "  not_empty    1     2 of 3  2       0",
        "  Errors",
        "    CASE                     ERROR",
        `    ${BETA}  not_empty: ValueError: cannot check 'beta'`,
      ].join("\n"),
    );
  });

  it("gives a number from a scorer with no threshold a mean, and neither a pass nor a fail", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/numeric-no-threshold`, run_id: "run_first" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("  output_length  4.67  3 of 3  —       —\n");
  });

  it("says no baseline was checked, and offers no command, for a run that can't be a baseline", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/sampled`, run_id: "run_first" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Regression check: skipped, because no baseline was given.\n");
    expect(run.stdout).not.toContain("--baseline");
  });

  it("writes one document on stdout under --json", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/one-fails`, run_id: "run_first" });

    const run = evalsRun("x_eval.py", "--json");

    expect(run.status).toBe(0);
    expect(json(run.stdout)).toEqual({
      schema_version: 1,
      outcome: "ok",
      file: join(project, "x_eval.py"),
      sdk: { language: "python", name: "traceroot", version: "0.5.1" },
      runtime: {
        name: "Python",
        version: "3.12.4",
        executable: join(project, ".venv", "bin", "python"),
      },
      project_id: null,
      runs: [
        {
          evaluation_name: "uppercase",
          local_run_id: "run_first",
          uploaded_run_id: null,
          uploaded_run_url: null,
          status: "completed",
          path: join(project, ".traceroot", "eval", "runs", "run_first.json"),
          cases_path: join(project, ".traceroot", "eval", "runs", "run_first.cases.jsonl"),
          counts: { cases: 3, errored: 0, task_errors: 0, scorer_errors: 0, not_scored: 3 },
          duration_ms: { mean: 1.5, count: 3 },
          scores: [
            {
              name: "exact_match",
              mean: 2 / 3,
              count: 3,
              mean_count: 3,
              passed: 2,
              failed: 1,
              unjudged: 0,
            },
            {
              name: "not_empty",
              mean: 1,
              count: 3,
              mean_count: 3,
              passed: 3,
              failed: 0,
              unjudged: 0,
            },
          ],
        },
      ],
      baseline: null,
      verdict: null,
      failure: null,
    });
    expect(run.stderr).not.toContain('"error"');
  });
});

describe("evals run with a baseline", () => {
  it.each([
    { ext: ".py", sdk: PYTHON, project: pythonProject },
    { ext: ".ts", sdk: TYPESCRIPT, project: nodeProject },
    { ext: ".js", sdk: TYPESCRIPT, project: nodeProject },
    { ext: ".mjs", sdk: TYPESCRIPT, project: nodeProject },
  ])("exits 18 naming the case that a $ext change broke", ({ ext, sdk, project: setUp }) => {
    setUp();
    const file = `x_eval${ext}`;
    evalFile(file, { replay: `${sdk}/all-pass`, run_id: "run_first" });
    expect(evalsRun(file).status).toBe(0);

    evalFile(file, { replay: `${sdk}/one-fails`, run_id: "run_second" });
    const run = evalsRun(file, "--baseline", "run_first");

    expect(run.status).toBe(18);
    expect(run.stdout).toContain(
      [
        "Regression check: failed against baseline run_first. 1 case and scorer pair newly fails.",
        "",
        "Newly failing",
        "  CASE                     SCORER       RESULT",
        `  ${BETA}  exact_match  failed: false`,
      ].join("\n"),
    );
  });

  it("names the regression in the --json document too, with the reason", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/one-fails`, run_id: "run_second" });

    const run = evalsRun("x_eval.py", "--baseline", "run_first", "--json");

    expect(run.status).toBe(18);
    const document = json(run.stdout);
    expect(document).toMatchObject({
      schema_version: 1,
      outcome: "regressed",
      runs: [{ local_run_id: "run_second" }],
      baseline: {
        local_run_id: "run_first",
        path: join(project, ".traceroot", "eval", "runs", "run_first.json"),
        evaluation_name: "uppercase",
      },
      verdict: {
        newly_failing: [
          {
            case_id: BETA,
            scorer_name: "exact_match",
            reason: "failed",
            value: false,
            error: null,
          },
        ],
        newly_errored: [],
        changed: [],
        not_comparable_reason: null,
        payloads: "complete",
      },
    });
    expect(run.stderr).not.toContain('"error"');
  });

  it("exits 18 for a case that newly errors, naming its error", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/task-error`, run_id: "run_second" });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(18);
    expect(run.stdout).toContain(
      "Regression check: failed against baseline run_first. 2 case and scorer pairs newly fail, and 1 case newly errors.",
    );
    expect(run.stdout).toContain(
      `  ${BETA}  exact_match  task raised: ValueError: cannot convert 'beta'`,
    );
    expect(run.stdout).toContain(
      [
        "Newly errored",
        "  CASE                     ERROR",
        `  ${BETA}  task: ValueError: cannot convert 'beta'`,
      ].join("\n"),
    );
    // Listed once, as newly errored, and not again among the run's errors.
    expect(run.stdout).not.toContain("  Errors\n");
    expect(run.stdout).not.toContain("no baseline was given");
  });

  it("still names an errored case that errored in the baseline too, which isn't new", () => {
    pythonProject();
    saveRun(`${PYTHON}/task-error`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/task-error`, run_id: "run_second" });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      `  Errors\n    CASE                     ERROR\n    ${BETA}  task: ValueError: cannot convert 'beta'\n`,
    );
    expect(run.stdout).toContain("Regression check: passed against baseline run_first");
  });

  it("exits 0 when nothing newly fails, and counts what changed", () => {
    pythonProject();
    saveRun(`${PYTHON}/one-fails`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, run_id: "run_second" });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "Regression check: passed against baseline run_first. Nothing newly fails or newly errors.\n\n1 score changed without regressing; --json lists it.\n",
    );
  });

  it("exits 0 for a pair that passed and fails under a new scorer version, and names it", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", {
      replay: `${PYTHON}/one-fails`,
      run_id: "run_second",
      replace: [
        [
          '"scorer_name": "exact_match", "scorer_version": null',
          '"scorer_name": "exact_match", "scorer_version": "2"',
        ],
      ],
    });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      [
        "Regression check: passed against baseline run_first. Nothing newly fails or newly errors.",
        "",
        "1 case and scorer pair that passed there doesn't pass under a new scorer version, which isn't a regression:",
        "  CASE                     SCORER       RESULT",
        `  ${BETA}  exact_match  failed: false`,
        "",
        "3 scores changed without regressing; --json lists them.",
        "",
      ].join("\n"),
    );
  });

  it("reads a baseline from the path of its run file", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/one-fails`, run_id: "run_second" });

    const run = evalsRun("x_eval.py", "--baseline", ".traceroot/eval/runs/run_first.json");

    expect(run.status).toBe(18);
  });

  it("exits 2 after the run when the baseline used another dataset, and says why", () => {
    pythonProject();
    saveRun(`${PYTHON}/inline-rows-a`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/inline-rows-b`, run_id: "run_second" });

    const human = evalsRun("x_eval.py", "--baseline", "run_first");
    const machine = evalsRun("x_eval.py", "--baseline", "run_first", "--json");

    expect(human.status).toBe(2);
    expect(human.stdout).toContain("uppercase · run_second · completed");
    expect(human.stdout).toContain(
      `Regression check: not run, because the run can't be compared with baseline run_first: the runs used different datasets: revision "rev_854c88d1e7648742" in the baseline run and "rev_c975c5d18e3e9e4b" in the new run.`,
    );
    expect(machine.status).toBe(2);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "not_comparable",
      runs: [{ local_run_id: "run_second" }],
      verdict: {
        newly_failing: [],
        not_comparable_reason: expect.stringContaining("the runs used different datasets"),
      },
    });
    expect(machine.stderr).not.toContain('"error"');
  });

  it("exits 2 after the run when the file didn't run the baseline's evaluation", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first", [["uppercase", "titlecase"]]);
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, run_id: "run_second" });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(2);
    expect(run.stdout).toContain(
      `Regression check: not run, because the run can't be compared with baseline run_first: the file ran no evaluation named "titlecase", which the baseline run is of; it ran "uppercase".`,
    );
  });
});

describe("evals run before the runner starts", () => {
  it("exits 2 for a file that doesn't exist, before reading the baseline", () => {
    pythonProject();

    const run = evalsRun("missing_eval.py", "--baseline", "run_nowhere");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("error: no evaluation file at missing_eval.py");
    expect(existsSync(join(project, ".venv", "probe-env.json"))).toBe(false);
  });

  it("exits 2 for a folder, or a path through a file, given as the evaluation file", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const folder = evalsRun(".venv");
    const throughFile = evalsRun("x_eval.py/inner_eval.py");

    expect(folder.status).toBe(2);
    expect(folder.stderr).toContain("error: .venv is a folder, not an evaluation file");
    expect(throughFile.status).toBe(2);
    expect(throughFile.stderr).toContain("error: no evaluation file at x_eval.py/inner_eval.py");
  });

  it("exits 2 for bad flags, with the error envelope under --json and nothing on stdout", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    for (const args of [
      ["x_eval.py", "--sample", "1"],
      ["x_eval.py", "other_eval.py"],
      ["x_eval.py", "--baseline", "a", "--baseline", "b"],
      ["x_eval.py", "--baseline", ""],
      [],
    ]) {
      const run = evalsRun(...args, "--json");

      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(envelope(run.stderr).code).toBe("usage");
    }
    expect(runnerStarted()).toBe(false);
  });

  it("exits 2 for a file no runner loads", () => {
    write(join(project, "x_eval.rb"), "");

    const run = evalsRun("x_eval.rb");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      "x_eval.rb is not a Python, TypeScript or JavaScript evaluation file.",
    );
  });

  it("exits 4 for a baseline run that doesn't exist, before the runner starts", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const byId = evalsRun("x_eval.py", "--baseline", "run_typo");
    const byPath = evalsRun("x_eval.py", "--baseline", "runs/run_typo.json", "--json");

    expect(byId.status).toBe(4);
    expect(byId.stderr).toContain(
      `error: no baseline run run_typo: nothing at ${join(".traceroot", "eval", "runs", "run_typo.json")} or run_typo under ${project}`,
    );
    expect(byPath.status).toBe(4);
    expect(byPath.stdout).toBe("");
    expect(envelope(byPath.stderr)).toEqual({
      code: "not_found",
      message: `no baseline run runs/run_typo.json: nothing at ${join(project, "runs", "run_typo.json")}`,
    });
    expect(runnerStarted()).toBe(false);
  });

  it("exits 2 for a sampled baseline, before the runner starts", () => {
    pythonProject();
    saveRun(`${PYTHON}/sampled`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      'error: run_first can\'t be a baseline: the baseline run is sampled (run_mode "sample"), so it ran only some of its cases.',
    );
    expect(runnerStarted()).toBe(false);
  });

  it("exits 2 for a baseline that isn't a run file, before the runner starts", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = evalsRun("x_eval.py", "--baseline", ".traceroot/eval/runs/run_first.cases.jsonl");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("error: can't read the baseline run:");
    expect(runnerStarted()).toBe(false);
  });
});

describe("evals run when the evaluation can't run", () => {
  it("exits 17 with the runner's fatal kind and message", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/import-error` });

    const human = evalsRun("x_eval.py");
    const machine = evalsRun("x_eval.py", "--json");

    expect(human.status).toBe(17);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain(
      "error: the eval runner failed with import_error: ModuleNotFoundError: No module named 'helpers'",
    );
    expect(machine.status).toBe(17);
    expect(machine.stdout).toBe("");
    expect(envelope(machine.stderr)).toEqual({
      code: "harness",
      message:
        "the eval runner failed with import_error: ModuleNotFoundError: No module named 'helpers'",
    });
  });

  it("keeps the lines of a message that has several", () => {
    nodeProject();
    evalFile("x_eval.ts", { replay: `${TYPESCRIPT}/import-error` });

    const run = evalsRun("x_eval.ts");

    expect(run.status).toBe(17);
    expect(run.stderr).toContain(
      "import_error: Error: Cannot find module './helpers'\nRequire stack:\n- <project>/eval.ts\n",
    );
  });

  it.each([
    { ext: ".py", setUp: pythonProject, sdk: PYTHON, fix: "Define an Evaluation at module level" },
    {
      ext: ".ts",
      setUp: nodeProject,
      sdk: TYPESCRIPT,
      fix: "Export an Evaluation at module level",
    },
  ])("exits 17 for a $ext file with no evaluation, saying where to define one", (scenario) => {
    scenario.setUp();
    evalFile(`x_eval${scenario.ext}`, { replay: `${scenario.sdk}/no-evaluations` });

    const run = evalsRun(`x_eval${scenario.ext}`);

    expect(run.status).toBe(17);
    expect(run.stderr).toContain("defines no evaluation the runner can find, so nothing ran.");
    expect(run.stderr).toContain(scenario.fix);
  });

  it("exits 17 for a runner that crashes partway", () => {
    pythonProject();
    evalFile("x_eval.py", {
      events: [{ type: "hello", eval_api_version: 1 }, { type: "evaluation_started" }],
      exit: 1,
    });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(17);
    expect(run.stderr).toContain(
      "error: the eval runner exited with status 1; its output is above",
    );
  });

  it("says a runner stopped early only when it exited 0, not after a run it reported the end of", () => {
    pythonProject();
    evalFile("x_eval.py", {
      events: [{ type: "hello", eval_api_version: 1 }, { type: "evaluation_started" }],
      exit: 0,
    });
    const early = evalsRun("x_eval.py");
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, exit: 1 });
    const late = evalsRun("x_eval.py");

    expect(early.status).toBe(17);
    expect(early.stderr).toContain(
      "error: the eval runner exited with status 0 before it reported the end of the run; its output is above",
    );
    expect(late.status).toBe(17);
    expect(late.stdout).toContain(`uppercase · ${RECORDED_RUN_ID} · completed\n`);
    expect(late.stderr).toContain(
      "error: the eval runner exited with status 1; its output is above\n",
    );
  });

  it("exits 17 for a run the runner reported and didn't save", () => {
    pythonProject();
    evalFile("x_eval.py", {
      events: [
        { type: "hello", eval_api_version: 1 },
        {
          type: "evaluation_completed",
          name: "uppercase",
          status: "completed",
          local_run_id: "run_unsaved",
          run_id: null,
          counts: { cases: 0, errored: 0, task_errors: 0, scorer_errors: 0, not_scored: 0 },
        },
        { type: "suite_completed", evaluations: 1, cancelled: false },
      ],
    });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(17);
    expect(run.stderr).toContain(
      'error: the eval runner reported run run_unsaved of "uppercase", but no saved run at',
    );
  });

  it("exits 17 with the fix for an SDK too old to run it, without starting the runner", () => {
    pythonProject("0.2.0");
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = evalsRun("x_eval.py", "--json");

    expect(run.status).toBe(17);
    expect(envelope(run.stderr)).toEqual({
      code: "harness",
      message: `traceroot 0.2.0 is installed for ${join(project, ".venv", "bin", "python")} (Python 3.12.4); running an evaluation needs 0.3.0 or later.\n\n'${join(project, ".venv", "bin", "python")}' -m pip install --upgrade traceroot`,
    });
    expect(runnerStarted()).toBe(false);
  });

  it("exits 17 with the fix when tsx isn't installed", () => {
    nodeProject({ tsx: false });
    evalFile("x_eval.ts", { replay: `${TYPESCRIPT}/all-pass` });

    const run = evalsRun("x_eval.ts");

    expect(run.status).toBe(17);
    expect(run.stderr).toContain("tsx is not installed");
    expect(run.stderr).toContain("npm i -D tsx");
    expect(runnerStarted()).toBe(false);
  });
});

describe("evals run when the runner fails after an evaluation finished", () => {
  /** A failure the runner reports for the file's next evaluation, after the first one finished. */
  const FATAL = {
    type: "fatal",
    kind: "harness_error",
    message: "TypeError: EvalCase.__init__() got an unexpected keyword argument 'expectd'",
  };
  const FATAL_ERROR = `the eval runner failed with harness_error: ${FATAL.message}`;
  const CRASH = "the eval runner exited with status 1; its output is above";

  it("exits 18 when an evaluation that finished regressed, and still reports the failure", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", {
      replay: `${PYTHON}/one-fails`,
      run_id: "run_second",
      unfinished: true,
      events: [FATAL],
    });

    const human = evalsRun("x_eval.py", "--baseline", "run_first");
    const machine = evalsRun("x_eval.py", "--baseline", "run_first", "--json");

    expect(human.status).toBe(18);
    expect(human.stdout).toContain("uppercase · run_second · completed\n");
    expect(human.stdout).toContain(
      [
        "Regression check: failed against baseline run_first. 1 case and scorer pair newly fails.",
        "",
        "Newly failing",
        "  CASE                     SCORER       RESULT",
        `  ${BETA}  exact_match  failed: false`,
      ].join("\n"),
    );
    expect(human.stderr).toContain(`error: ${FATAL_ERROR}\n`);
    expect(machine.status).toBe(18);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "regressed",
      runs: [{ local_run_id: "run_second", status: "completed" }],
      verdict: {
        newly_failing: [{ case_id: BETA, scorer_name: "exact_match", reason: "failed" }],
      },
      failure: { kind: "harness_error", message: FATAL_ERROR },
    });
    expect(machine.stderr).not.toContain('"error"');
  });

  it("exits 17 with the outcome failed when the evaluations that finished didn't regress", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_second",
      unfinished: true,
      events: [FATAL],
    });

    const human = evalsRun("x_eval.py", "--baseline", "run_first");
    const machine = evalsRun("x_eval.py", "--baseline", "run_first", "--json");

    expect(human.status).toBe(17);
    expect(human.stdout).toContain("uppercase · run_second · completed\n");
    expect(human.stdout).toContain(
      "Regression check: passed against baseline run_first. Nothing newly fails or newly errors.\n",
    );
    expect(human.stderr).toContain(`error: ${FATAL_ERROR}\n`);
    expect(machine.status).toBe(17);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "failed",
      runs: [{ local_run_id: "run_second" }],
      verdict: { newly_failing: [], newly_errored: [], not_comparable_reason: null },
      failure: { kind: "harness_error", message: FATAL_ERROR },
    });
    expect(machine.stderr).not.toContain('"error"');
  });

  it("exits 17 and says so when the baseline's evaluation didn't finish before the failure", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first", [['"uppercase"', '"titlecase"']]);
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_second",
      unfinished: true,
      events: [FATAL],
    });

    const human = evalsRun("x_eval.py", "--baseline", "run_first");
    const machine = evalsRun("x_eval.py", "--baseline", "run_first", "--json");

    const reason =
      'no evaluation named "titlecase", which the baseline run is of, finished before the eval runner stopped; it finished "uppercase"';
    expect(human.status).toBe(17);
    expect(human.stdout).toContain(
      `Regression check: not run, because the run can't be compared with baseline run_first: ${reason}.\n`,
    );
    expect(human.stderr).toContain(`error: ${FATAL_ERROR}\n`);
    expect(machine.status).toBe(17);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "failed",
      verdict: { not_comparable_reason: reason },
      failure: { kind: "harness_error", message: FATAL_ERROR },
    });
  });

  it("exits 17 for a runner that crashes after an evaluation finished, and prints it", () => {
    pythonProject();
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_first",
      unfinished: true,
      exit: 1,
    });

    const human = evalsRun("x_eval.py");
    const machine = evalsRun("x_eval.py", "--json");

    expect(human.status).toBe(17);
    expect(human.stdout).toContain("uppercase · run_first · completed\n");
    expect(human.stderr).toContain(`error: ${CRASH}\n`);
    expect(machine.status).toBe(17);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "failed",
      runs: [{ local_run_id: "run_first", status: "completed" }],
      baseline: null,
      verdict: null,
      failure: { kind: "crashed", message: CRASH },
    });
    expect(machine.stderr).not.toContain('"error"');
  });

  it("exits 17 with the error envelope and nothing on stdout when no evaluation finished", () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    const hello = { type: "hello", eval_api_version: 1 };

    evalFile("x_eval.py", { events: [hello, FATAL] });
    const fatal = evalsRun("x_eval.py", "--baseline", "run_first", "--json");
    evalFile("x_eval.py", { events: [hello], exit: 1 });
    const crashed = evalsRun("x_eval.py", "--baseline", "run_first", "--json");

    expect(fatal.status).toBe(17);
    expect(fatal.stdout).toBe("");
    expect(envelope(fatal.stderr)).toEqual({ code: "harness", message: FATAL_ERROR });
    expect(crashed.status).toBe(17);
    expect(crashed.stdout).toBe("");
    expect(envelope(crashed.stderr)).toEqual({ code: "harness", message: CRASH });
  });
});

describe("evals run's progress line", () => {
  /** A terminal 80 columns wide that keeps everything written to it. */
  class TerminalSink extends StringSink {
    readonly columns = 80;

    constructor() {
      super(true);
    }
  }

  /** The spinner's frames, none of which a run without the line writes. */
  const SPINNER = /[◒◐◓◑]/;

  /** Runs the command in this process, with stderr a terminal unless `terminal` is false. */
  async function runHere(
    options: Partial<Pick<EvalsRunOptions, "json">> & {
      env?: NodeJS.ProcessEnv;
      terminal?: boolean;
    } = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const out = new StringSink(false);
    const err = options.terminal === false ? new StringSink(false) : new TerminalSink();
    const code = await runEvalsRun({
      file: "x_eval.py",
      json: options.json ?? false,
      upload: null,
      cwd: project,
      env: { ...cliEnv(), ...options.env },
      writers: { out, err },
    });
    return { code, out: out.data, err: err.data };
  }

  /** What stderr holds without the line: the runner it started, then the runner's output. */
  function plainStderr(): string[] {
    return [
      `Running x_eval.py with traceroot 0.5.1 on Python 3.12.4 (${join(".venv", "bin", "python")})`,
      "runner stdout",
      "runner stderr",
      "",
    ];
  }

  it("draws on a terminal's stderr while the runner runs, and is gone before the summary", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, run_id: "run_first" });

    const run = await runHere();
    const plain = await runHere({ terminal: false });

    expect(run.code).toBe(0);
    expect(frames(run.err).some((frame) => SPINNER.test(frame))).toBe(true);
    // Every row the line drew on is erased: what is left is what a run without it shows.
    const rows = screen(run.err);
    expect(rows.at(-1)).toBe("");
    expect([...rows].sort()).toEqual([...plainStderr()].sort());
    expect(run.err.endsWith(CLEAR_LINE)).toBe(true);
    // The summary on stdout is the same either way.
    expect(run.out).toBe(plain.out);
  });

  it("draws in a CI that says it isn't one", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = await runHere({ env: { CI: "false" } });

    expect(run.err).toContain(CLEAR_LINE);
  });

  it.each([
    { what: "--json", json: true },
    { what: "NO_COLOR", env: { NO_COLOR: "1" } },
    { what: "TERM=dumb", env: { TERM: "dumb" } },
    { what: "CI", env: { CI: "true" } },
    { what: "a stderr that isn't a terminal", terminal: false },
  ])("writes nothing of its own under $what", async ({ json, env, terminal }) => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = await runHere({ json, env, terminal });

    expect(run.code).toBe(0);
    expect(run.err).not.toContain("\x1b[2K");
    expect(run.err).not.toMatch(SPINNER);
    expect(run.err).not.toContain("Waiting for the runner");
    expect(stripVTControlCharacters(run.err).split("\n").sort()).toEqual(plainStderr().sort());
  });

  it("writes nothing of its own from the built CLI, whose stderr here is a pipe", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.raw.stderr).not.toContain("\x1b[2K");
    expect(run.raw.stderr).not.toMatch(SPINNER);
  });
});

describe("evals run interrupted", () => {
  it.each([
    { signal: "SIGINT", status: 130 },
    { signal: "SIGTERM", status: 143 },
    { signal: "SIGHUP", status: 129 },
  ] as const)(
    "exits $status on $signal, names the run the runner saved, and leaves no runner",
    async ({ signal, status }) => {
      pythonProject();
      saveRun(`${PYTHON}/all-pass`, "run_first");
      evalFile("x_eval.py", { wait: true, replay: `${PYTHON}/interrupted`, run_id: "run_second" });

      const run = await interrupt(signal, "x_eval.py", "--baseline", "run_first");

      expect(run.status).toBe(status);
      expect(run.stdout).toContain(
        "uppercase · run_second · incomplete\n  1 case · 0 errored · mean 1.5 ms per case\n",
      );
      expect(run.stdout).toContain(`Interrupted by ${signal}, so nothing was compared.\n`);
      const pid = runnerPid();
      expect(pid).not.toBeNull();
      expect(isRunning(pid as number)).toBe(false);
    },
  );

  it("exits 130 when only the runner was interrupted, and names the run it saved", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/interrupted`, run_id: "run_second" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(130);
    expect(run.stdout).toContain("uppercase · run_second · incomplete\n");
    expect(run.stdout).toContain("The runner was interrupted.\n");
  });

  it("exits 17 and leaves no runner when a reader closes the CLI's output while the runner runs", async () => {
    pythonProject();
    evalFile("x_eval.py", { wait: true, chatty: true, replay: `${PYTHON}/all-pass` });

    // Like `evals run … 2>&1 | head`: the reader goes, and the next line the CLI passes on fails.
    const run = await whileRunning((child) => child.stderr.destroy(), "x_eval.py");

    expect(run.status).toBe(17);
    expect(run.stdout).toBe("");
    const pid = runnerPid() as number;
    // The runner may take a moment to act on its SIGTERM once the CLI has gone.
    const deadline = Date.now() + 5000;
    while (isRunning(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isRunning(pid), `runner ${pid} outlived the CLI`).toBe(false);
  });

  it("names a saved run as complete when the runner finished every case in flight", async () => {
    // @traceroot-ai/traceroot finishes the cases in flight, which can be all of them.
    nodeProject();
    evalFile("x_eval.ts", {
      wait: true,
      replay: `${TYPESCRIPT}/all-pass`,
      run_id: "run_second",
      replace: [['"cancelled":false', '"cancelled":true']],
    });

    const run = await interrupt("SIGINT", "x_eval.ts", "--json");

    expect(run.status).toBe(130);
    expect(json(run.stdout)).toMatchObject({
      outcome: "interrupted",
      signal: "SIGINT",
      runs: [{ local_run_id: "run_second", status: "completed" }],
      verdict: null,
    });
  });
});

describe("evals run --upload", () => {
  let stub: TraceRootStub;

  beforeEach(async () => {
    stub = await startTraceRootStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  /** The CLI's environment with the stub as its host, and the stub's key unless `key` says. */
  function uploadEnv(key: string | null = STUB_API_KEY): NodeJS.ProcessEnv {
    const { TRACEROOT_API_KEY: _key, ...env } = cliEnv();
    return {
      ...env,
      TRACEROOT_HOST_URL: stub.url,
      ...(key === null ? {} : { TRACEROOT_API_KEY: key }),
    };
  }

  /** Runs the CLI without blocking this process, so the stub can answer it. */
  function evalsRunWith(env: NodeJS.ProcessEnv, ...args: string[]): Promise<Result> {
    return evalsRunFrom(BIN, env, ...args);
  }

  /** {@link evalsRunWith}, with the CLI started from `script`. */
  function evalsRunFrom(
    script: string,
    env: NodeJS.ProcessEnv,
    ...args: string[]
  ): Promise<Result> {
    return cliFrom(script, env, "evals", "run", ...args);
  }

  /** Runs any command of the CLI started from `script`, without blocking this process. */
  async function cliFrom(
    script: string,
    env: NodeJS.ProcessEnv,
    ...args: string[]
  ): Promise<Result> {
    const child = spawn(process.execPath, [script, ...args], { cwd: project, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return result(status, stdout, stderr);
  }

  /** A browser login stored for the stub's host, in the credentials file under HOME. */
  function browserLogin(): void {
    write(
      join(project, ".config", "traceroot", "credentials.json"),
      JSON.stringify({ version: 1, hosts: { [stub.url]: { session_token: "session-0000" } } }),
    );
  }

  /**
   * Makes a replayed run report the TraceRoot run id `id`, as a run the runner uploaded does, and
   * save `url` as its link when one is given, as a run TraceRoot gave one does.
   */
  function uploadedAs(id: string, url?: string): [string, string][] {
    return [
      ['"run_id": null', `"run_id": "${id}"`],
      ['"run_id":null', `"run_id":"${id}"`],
      ...(url === undefined ? [] : [['"dashboard_url": null', `"dashboard_url": "${url}"`]]),
    ] as [string, string][];
  }

  const RUN_URL = `https://app.example/projects/${STUB_PROJECT_ID}/evaluations/evr_stub_1`;

  /** What the stub was asked, without what it was sent. */
  function asked(): string[] {
    return stub.requests.map(
      (request) => `${request.method} ${request.path} ${request.authorization}`,
    );
  }

  const WHOAMI = `GET /api/v1/public/whoami Bearer ${STUB_API_KEY}`;

  /** The `fatal` event that ends a recorded run. */
  function recordedFatal(scenario: string): { type: string; kind: string; message: string } {
    const lines = readFileSync(join(FIXTURES, scenario, "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    return JSON.parse(lines.at(-1) ?? "") as { type: string; kind: string; message: string };
  }

  /** The line under "To read the uploaded run…:" in a summary: the command that reads it. */
  function openCommand(stdout: string): string {
    const lines = stdout.split("\n");
    return (lines[lines.findIndex((line) => line.endsWith("from the terminal:")) + 1] ?? "").trim();
  }

  it("puts the SDK's Git notice in a few words for an uploaded run", async () => {
    pythonProject();
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      replace: uploadedAs("evr_stub_1"),
      stderr: `${GIT_NOTICE}\n`,
    });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(
      [
        "runner stderr",
        "warning: no Git repository or commit was found, so the uploaded traces won't link to source code.",
        "  Set TRACEROOT_GIT_REPO and TRACEROOT_GIT_REF: https://docs.traceroot.ai/tracing/git-context",
        "",
      ].join("\n"),
    );
  });

  it("makes no request to TraceRoot without --upload", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py");

    expect(run.status).toBe(0);
    expect(stub.requests).toEqual([]);
    expect(seen("runner-env.json")).toMatchObject({
      api_key: null,
      enabled: "false",
      options: "{}",
    });
  });

  it("checks the key, hands the runner the key and host, and gives the run's link and the command that opens it", async () => {
    pythonProject();
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_first",
      replace: uploadedAs("evr_stub_1", RUN_URL),
    });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(run.status).toBe(0);
    expect(asked()).toEqual([WHOAMI]);
    expect(seen("runner-env.json")).toEqual({
      api_key: STUB_API_KEY,
      host: stub.url,
      enabled: "true",
      options: '{"reporting":true}',
      event_file: expect.any(String),
    });
    expect(seen(join(".venv", "probe-env.json")).api_key).toBeNull();
    expect(run.stderr).toContain(`Uploading to project Stub project at ${stub.url}\n`);
    expect(run.stdout).toContain(
      [
        "uppercase · run_first · completed",
        "  3 cases · 0 errored · mean 1.5 ms per case",
        "  SCORE        MEAN  SCORED  PASSED  FAILED",
        "  exact_match  1     3 of 3  3       0",
        "  not_empty    1     3 of 3  3       0",
        "",
        "Regression check: skipped, because no baseline was given.",
        "",
        "Run file   .traceroot/eval/runs/run_first.json",
        "Case file  .traceroot/eval/runs/run_first.cases.jsonl",
        "Uploaded   run evr_stub_1",
        `           ${RUN_URL}`,
        "",
        "To compare the next run with this one:",
        "  traceroot evals run x_eval.py --baseline run_first",
        "To read the uploaded run from the terminal:",
        `  traceroot evals runs get evr_stub_1 --project ${STUB_PROJECT_ID}`,
        "TraceRoot adds cost and token use once it has processed the traces.",
        "",
      ].join("\n"),
    );
    expect(`${run.raw.stdout}${run.raw.stderr}`).not.toContain(STUB_API_KEY);
  });

  it("adds each run's TraceRoot run id and link to the --json document", async () => {
    nodeProject();
    evalFile("x_eval.ts", {
      replay: `${TYPESCRIPT}/all-pass`,
      run_id: "run_first",
      replace: uploadedAs("evr_stub_1", RUN_URL),
    });

    const run = await evalsRunWith(uploadEnv(), "x_eval.ts", "--upload", "--json");

    expect(run.status).toBe(0);
    expect(json(run.stdout)).toMatchObject({
      outcome: "ok",
      project_id: STUB_PROJECT_ID,
      runs: [
        { local_run_id: "run_first", uploaded_run_id: "evr_stub_1", uploaded_run_url: RUN_URL },
      ],
    });
  });

  it("prints only the command for a run TraceRoot gave no link, as an older host doesn't", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, replace: uploadedAs("evr_stub_1") });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload", "--json");
    const human = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(json(run.stdout)).toMatchObject({ runs: [{ uploaded_run_url: null }] });
    expect(human.stdout).toContain("\nUploaded   run evr_stub_1\n\n");
    expect(human.stdout).toContain(
      "To read the uploaded run from the terminal:\n  traceroot evals runs get evr_stub_1 --project ",
    );
  });

  it("escapes a control character in a run's link", async () => {
    pythonProject();
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      replace: uploadedAs("evr_stub_1", `${RUN_URL}\\u001b[2J`),
    });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(run.raw.stdout).not.toContain("\u001b[2J");
    expect(run.stdout).toContain(`  ${RUN_URL}\\u001b[2J\n`);
  });

  it("uses the API key when a browser login outranks it", async () => {
    pythonProject();
    browserLogin();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, replace: uploadedAs("evr_stub_1") });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(run.status).toBe(0);
    expect(asked()).toEqual([WHOAMI]);
    expect(seen("runner-env.json").api_key).toBe(STUB_API_KEY);
    // A read under a browser login needs a project, so the command names one.
    expect(run.stdout).toContain(
      `  traceroot evals runs get evr_stub_1 --project ${STUB_PROJECT_ID}\n`,
    );
  });

  it("takes the key from --api-key", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, replace: uploadedAs("evr_stub_1") });

    const run = await evalsRunWith(
      uploadEnv(null),
      "x_eval.py",
      "--upload",
      "--api-key",
      STUB_API_KEY,
    );

    expect(run.status).toBe(0);
    expect(asked()).toEqual([WHOAMI]);
  });

  it("exits 3 with only a browser login, before the runner starts", async () => {
    pythonProject();
    browserLogin();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const human = await evalsRunWith(uploadEnv(null), "x_eval.py", "--upload");
    const machine = await evalsRunWith(uploadEnv(null), "x_eval.py", "--upload", "--json");

    const message =
      "`--upload` needs a project API key; a browser login can't upload eval runs. Run `traceroot login --api-key <key>` or set `TRACEROOT_API_KEY`.";
    expect(human.status).toBe(3);
    expect(human.stderr).toBe(`error: ${message}\n`);
    expect(machine.status).toBe(3);
    expect(machine.stdout).toBe("");
    expect(envelope(machine.stderr)).toEqual({ code: "auth", message });
    expect(stub.requests).toEqual([]);
    expect(runnerStarted()).toBe(false);
  });

  it("spells the commands it prints the way npx started the CLI", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, replace: uploadedAs("evr_stub_1") });
    // Where npx starts the CLI from: its own cache, with npm marking the environment as an exec.
    const npx = join(
      project,
      ".npm",
      "_npx",
      "0123456789abcdef",
      "node_modules",
      ".bin",
      "traceroot",
    );
    write(npx, `import(${JSON.stringify(DIST_CLI.href)}).then((cli) => cli.run(process.argv));\n`);
    const pinned = `npx -y traceroot-cli@${getVersion()}`;

    const uploaded = await evalsRunFrom(
      npx,
      { ...uploadEnv(), npm_command: "exec" },
      "x_eval.py",
      "--upload",
    );
    const noKey = await evalsRunFrom(
      npx,
      { ...uploadEnv(null), npm_command: "exec" },
      "x_eval.py",
      "--upload",
    );

    expect(uploaded.status).toBe(0);
    expect(uploaded.stdout).toContain(
      `  ${pinned} evals runs get evr_stub_1 --project ${STUB_PROJECT_ID}\n`,
    );
    expect(noKey.status).toBe(3);
    expect(noKey.stderr).toContain(
      `Run \`${pinned} login --api-key <key>\` or set \`TRACEROOT_API_KEY\`.`,
    );
  });

  it("exits 3 for a key TraceRoot rejects, before the runner starts", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const run = await evalsRunWith(uploadEnv("tr-fake-rejected-0000"), "x_eval.py", "--upload");

    expect(run.status).toBe(3);
    expect(run.stderr).toContain(
      `error: TraceRoot at ${stub.url} rejected the API key, so the evaluation didn't run: Invalid API key\n`,
    );
    expect(asked()).toEqual(["GET /api/v1/public/whoami Bearer tr-fake-rejected-0000"]);
    expect(runnerStarted()).toBe(false);
  });

  it("exits 5 when TraceRoot can't be reached, before the runner starts", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass` });

    const human = evalsRun("x_eval.py", "--upload");
    const machine = evalsRun("x_eval.py", "--upload", "--json");

    expect(human.status).toBe(5);
    expect(human.stderr).toContain(
      "error: couldn't check the API key with TraceRoot at http://127.0.0.1:9, so the evaluation didn't run: request to http://127.0.0.1:9 failed",
    );
    expect(machine.status).toBe(5);
    expect(machine.stdout).toBe("");
    expect(envelope(machine.stderr).code).toBe("network");
    expect(runnerStarted()).toBe(false);
  });

  it.each([
    { ext: ".py", setUp: pythonProject, sdk: PYTHON, example: '`cases = Dataset("cases")`' },
    {
      ext: ".ts",
      setUp: nodeProject,
      sdk: TYPESCRIPT,
      example: '`const cases = new Dataset("cases")`',
    },
  ])(
    "exits 17 for a $ext file whose cases are a plain list, saying to define a Dataset",
    async (scenario) => {
      scenario.setUp();
      const file = `x_eval${scenario.ext}`;
      evalFile(file, { replay: `${scenario.sdk}/upload-plain-list` });

      const human = await evalsRunWith(uploadEnv(), file, "--upload");
      const machine = await evalsRunWith(uploadEnv(), file, "--upload", "--json");

      expect(human.status).toBe(17);
      expect(human.stdout).toBe("");
      expect(human.stderr).toContain(
        `error: ${file} gives an evaluation its cases as a plain list, which can't be uploaded: TraceRoot records an uploaded run against a Dataset, which the runner publishes before the run if TraceRoot doesn't have it yet. No case ran.\n\nDefine the cases as a Dataset, as in ${scenario.example}`,
      );
      expect(human.stderr).toContain(", or run without --upload.\n");
      expect(machine.status).toBe(17);
      expect(envelope(machine.stderr).code).toBe("harness");
    },
  );

  it("exits 17 with the runner's message and the rerun hint when TraceRoot fails to complete the run", async () => {
    pythonProject();
    // What traceroot 0.5.1 reports once every case ran and completing the run failed.
    const message = `EvalCompletionError: the evaluation ran but the run could not be finalized on the platform: RuntimeError: POST ${stub.url}/api/v1/public/evaluation-runs/evr_stub_1/complete -> HTTP 500: {"detail":"the stub fails every completion"}. The run stays 'running' until a retry completes it.`;
    evalFile("x_eval.py", {
      events: [
        { type: "hello", eval_api_version: 1 },
        { type: "evaluation_started" },
        { type: "case_started" },
        { type: "case_completed" },
        { type: "fatal", kind: "harness_error", message },
      ],
    });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(run.status).toBe(17);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      `error: the eval runner failed with harness_error: ${message}\n\nThe runner saved no run on this machine either. To check the evaluation without uploading it, rerun without --upload.\n`,
    );
  });

  it("keeps the hint to a harness error, and prints an import error as it would without --upload", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/import-error` });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(run.status).toBe(17);
    expect(run.stderr).toContain(
      "error: the eval runner failed with import_error: ModuleNotFoundError: No module named 'helpers'\n",
    );
    expect(run.stderr).not.toContain("rerun without --upload");
  });

  it("names the evaluation that finished and uploaded when a later one's cases are a plain list", async () => {
    pythonProject();
    const fatal = recordedFatal(`${PYTHON}/upload-plain-list`);
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_first",
      replace: uploadedAs("evr_stub_1"),
      unfinished: true,
      events: [{ type: "evaluation_started", name: "second" }, fatal],
    });

    const human = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");
    const machine = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload", "--json");

    expect(human.status).toBe(17);
    expect(human.stdout).toContain("uppercase · run_first · completed\n");
    expect(human.stdout).toContain("Uploaded   run evr_stub_1\n");
    expect(openCommand(human.stdout)).toBe(
      `traceroot evals runs get evr_stub_1 --project ${STUB_PROJECT_ID}`,
    );
    const error = `x_eval.py gives an evaluation its cases as a plain list, which can't be uploaded: TraceRoot records an uploaded run against a Dataset, which the runner publishes before the run if TraceRoot doesn't have it yet. None of that evaluation's cases ran. "uppercase" finished before it, and was saved on this machine as run_first and uploaded to TraceRoot as evr_stub_1.\n\nDefine the cases as a Dataset, as in \`cases = Dataset("cases")\`, then \`cases.add(input, expected=...)\` for each case, or run without --upload.`;
    expect(human.stderr).toContain(`error: ${error}\n`);
    expect(human.stderr).not.toContain("No case ran");
    expect(machine.status).toBe(17);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "failed",
      project_id: STUB_PROJECT_ID,
      runs: [
        { evaluation_name: "uppercase", local_run_id: "run_first", uploaded_run_id: "evr_stub_1" },
      ],
      failure: { kind: "harness_error", message: error },
    });
    expect(machine.stderr).not.toContain('"error"');
  });

  it("names the evaluation that finished and uploaded when TraceRoot fails to complete a later one", async () => {
    pythonProject();
    // What traceroot 0.5.1 reports once every case of the second evaluation ran and completing its
    // run failed.
    const message = `EvalCompletionError: the evaluation ran but the run could not be finalized on the platform: RuntimeError: POST ${stub.url}/api/v1/public/evaluation-runs/evr_stub_2/complete -> HTTP 500: {"detail":"the stub fails every completion"}. The run stays 'running' until a retry completes it.`;
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_first",
      replace: uploadedAs("evr_stub_1"),
      unfinished: true,
      events: [
        { type: "evaluation_started", name: "second" },
        { type: "case_started" },
        { type: "case_completed" },
        { type: "fatal", kind: "harness_error", message },
      ],
    });

    const human = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");
    const machine = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload", "--json");

    expect(human.status).toBe(17);
    expect(human.stdout).toContain("Uploaded   run evr_stub_1\n");
    expect(openCommand(human.stdout)).toBe(
      `traceroot evals runs get evr_stub_1 --project ${STUB_PROJECT_ID}`,
    );
    const error = `the eval runner failed with harness_error: ${message}\n\nThe evaluation that failed saved no run on this machine either. "uppercase" finished before it, and was saved on this machine as run_first and uploaded to TraceRoot as evr_stub_1. To check the evaluation that failed without uploading it, rerun without --upload.`;
    expect(human.stderr).toContain(`error: ${error}\n`);
    expect(human.stderr).not.toContain("The runner saved no run");
    expect(machine.status).toBe(17);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "failed",
      runs: [{ local_run_id: "run_first", uploaded_run_id: "evr_stub_1" }],
      failure: { kind: "harness_error", message: error },
    });
  });

  it("names an evaluation that finished before a failure without a TraceRoot run id as not uploaded", async () => {
    pythonProject();
    evalFile("x_eval.py", {
      replay: `${PYTHON}/all-pass`,
      run_id: "run_first",
      unfinished: true,
      events: [recordedFatal(`${PYTHON}/upload-plain-list`)],
    });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");

    expect(run.status).toBe(17);
    expect(run.stdout).toContain('Not uploaded: "uppercase" finished without a TraceRoot run id.');
    expect(run.stderr).toContain(
      'None of that evaluation\'s cases ran. "uppercase" finished before it, and was saved on this machine as run_first but not uploaded.\n',
    );
  });

  it.each([
    {
      given: "--host",
      access: () => ({
        env: { ...uploadEnv(), TRACEROOT_HOST_URL: "http://127.0.0.1:9" },
        args: ["--host", stub.url],
        flags: `--host ${stub.url}`,
      }),
    },
    {
      given: "--env-file",
      access: () => {
        write(
          join(project, "upload.env"),
          `TRACEROOT_API_KEY=${STUB_API_KEY}\nTRACEROOT_HOST_URL=${stub.url}\n`,
        );
        return {
          env: { ...uploadEnv(null), TRACEROOT_HOST_URL: "http://127.0.0.1:9" },
          args: ["--env-file", "upload.env"],
          flags: "--env-file upload.env",
        };
      },
    },
    {
      given: "--api-key",
      access: () => ({
        env: uploadEnv(null),
        args: ["--api-key", STUB_API_KEY],
        flags: "--api-key <key>",
      }),
    },
  ])(
    "prints a command that opens the run when $given gave the key or the host",
    async (scenario) => {
      pythonProject();
      evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, replace: uploadedAs("evr_stub_1") });
      const { env, args, flags } = scenario.access();

      const run = await evalsRunWith(env, "x_eval.py", "--upload", ...args);
      const command = openCommand(run.stdout);
      // Run as printed, in the same shell, with a key placeholder filled in the way a user would.
      const [program, ...words] = command.replace("<key>", STUB_API_KEY).split(" ");
      const opened = await cliFrom(BIN, env, ...words);

      expect(run.status).toBe(0);
      expect(command).toBe(
        `traceroot evals runs get evr_stub_1 --project ${STUB_PROJECT_ID} ${flags}`,
      );
      expect(`${run.raw.stdout}${run.raw.stderr}`).not.toContain(STUB_API_KEY);
      expect(program).toBe("traceroot");
      expect(opened.status).toBe(0);
      expect(asked().at(-1)).toBe(
        `GET /api/v1/public/evaluation-runs/evr_stub_1 Bearer ${STUB_API_KEY}`,
      );
    },
  );

  it("exits 18 for a regression and still says where the run was uploaded", async () => {
    pythonProject();
    saveRun(`${PYTHON}/all-pass`, "run_first");
    evalFile("x_eval.py", {
      replay: `${PYTHON}/one-fails`,
      run_id: "run_second",
      replace: uploadedAs("evr_stub_2"),
    });

    const run = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload", "--baseline", "run_first");

    expect(run.status).toBe(18);
    expect(run.stdout).toContain(
      "Regression check: failed against baseline run_first. 1 case and scorer pair newly fails.",
    );
    expect(run.stdout).toContain("Uploaded   run evr_stub_2\n");
    expect(openCommand(run.stdout)).toBe(
      `traceroot evals runs get evr_stub_2 --project ${STUB_PROJECT_ID}`,
    );
  });

  it("exits 17 naming an evaluation that finished without a TraceRoot run id", async () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, run_id: "run_first" });

    const human = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload");
    const machine = await evalsRunWith(uploadEnv(), "x_eval.py", "--upload", "--json");

    expect(human.status).toBe(17);
    expect(human.stdout).toContain("uppercase · run_first · completed\n");
    expect(human.stdout).toContain(
      'Not uploaded: "uppercase" finished without a TraceRoot run id. An evaluation defined with `local=True` or `report_to=` runs without uploading.\n',
    );
    expect(machine.status).toBe(17);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "not_uploaded",
      runs: [{ local_run_id: "run_first", uploaded_run_id: null }],
    });
    expect(machine.stderr).not.toContain('"error"');
  });

  it("exits 18, not 17, when a case regressed in a run that wasn't uploaded", async () => {
    nodeProject();
    saveRun(`${TYPESCRIPT}/all-pass`, "run_first");
    evalFile("x_eval.ts", { replay: `${TYPESCRIPT}/one-fails`, run_id: "run_second" });

    const run = await evalsRunWith(uploadEnv(), "x_eval.ts", "--upload", "--baseline", "run_first");

    expect(run.status).toBe(18);
    expect(run.stdout).toContain(
      'Not uploaded: "uppercase" finished without a TraceRoot run id. An evaluation defined with `local: true` or `transport` runs without uploading.\n',
    );
  });
});

describe("evals run's escaping", () => {
  /** Sets the terminal's title, then clears the screen. */
  const ESCAPE = "\u001b]0;pwned\u0007\u001b[2J";
  /** The same, escaped: as the CLI prints it, and as it is written inside a JSON string. */
  const ESCAPED = "\\u001b]0;pwned\\u0007\\u001b[2J";

  it("prints a case id and an evaluation name with escape sequences escaped", () => {
    pythonProject();
    const replace: [string, string][] = [
      [BETA, `tc_${ESCAPED}`],
      ['"uppercase"', `"upper${ESCAPED}"`],
    ];
    saveRun(`${PYTHON}/all-pass`, "run_first", replace);
    evalFile("x_eval.py", { replay: `${PYTHON}/one-fails`, run_id: "run_second", replace });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(18);
    expect(run.raw.stdout).not.toContain(ESCAPE);
    expect(run.stdout).toContain(`  tc_${ESCAPED}  exact_match  failed: false`);
    expect(run.stdout).toContain(`upper${ESCAPED} · run_second · completed`);
  });

  it("keeps a failure's message as written in the --json document, and escapes it on the error line", () => {
    pythonProject();
    const fatal = { type: "fatal", kind: "harness_error", message: `boom${ESCAPE}` };
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, unfinished: true, events: [fatal] });

    const human = evalsRun("x_eval.py");
    const machine = evalsRun("x_eval.py", "--json");

    const message = "the eval runner failed with harness_error: boom";
    expect(human.status).toBe(17);
    expect(human.raw.stderr).not.toContain(ESCAPE);
    expect(human.stderr).toContain(`error: ${message}${ESCAPED}\n`);
    expect(machine.status).toBe(17);
    expect(json(machine.stdout)).toMatchObject({
      outcome: "failed",
      failure: { kind: "harness_error", message: `${message}${ESCAPE}` },
    });
  });

  it("prints a fatal message with escape sequences escaped", () => {
    pythonProject();
    evalFile("x_eval.py", {
      events: [
        { type: "hello", eval_api_version: 1 },
        { type: "fatal", kind: "import_error", message: `boom${ESCAPE}` },
      ],
    });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(17);
    expect(run.raw.stderr).not.toContain(ESCAPE);
    expect(run.stderr).toContain(`import_error: boom${ESCAPED}`);
  });
});

describe("scoreMeans", () => {
  const recordings = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((sdk) =>
      readdirSync(join(FIXTURES, sdk.name)).map((scenario) => join(sdk.name, scenario)),
    )
    .filter((scenario) => existsSync(join(FIXTURES, scenario, "runs")));

  it.each(recordings)("gives the means the runner reported for %s", (scenario) => {
    const dir = join(FIXTURES, scenario);
    const completed = readFileSync(join(dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.includes('"evaluation_completed"'))
      .map((line) => JSON.parse(line) as { score_summary: Record<string, unknown> });
    const cases = parseCaseLines(
      readFileSync(join(dir, "runs", `${RECORDED_RUN_ID}.cases.jsonl`), "utf8"),
    );

    expect(completed).toHaveLength(1);
    const means = scoreMeans(cases);
    expect(means.map(({ name, mean, count }) => ({ name, mean, count }))).toEqual(
      Object.values(completed[0]?.score_summary ?? {}),
    );
    for (const score of means) {
      expect(score.passed + score.failed + score.unjudged).toBe(score.count);
      expect(score.mean_count).toBeLessThanOrEqual(score.count);
    }
  });

  it("averages numbers and booleans, and counts any other value without a mean", () => {
    const item = (scores: [string, unknown][]): CaseLine => ({
      case_id: "case-0",
      status: "not_scored",
      input: null,
      expected: null,
      task_error: null,
      scorer_errors: [],
      duration_ms: null,
      scores: scores.map(([scorer_name, value]) => ({
        scorer_name,
        scorer_version: null,
        value,
        passed: typeof value === "boolean" ? value : null,
      })),
    });

    expect(
      scoreMeans([
        item([
          ["label", "good"],
          ["passed", true],
          ["length", 4],
        ]),
        item([
          ["label", "bad"],
          ["passed", false],
          ["length", 6],
        ]),
        item([
          ["length", Number.NaN],
          ["passed", true],
        ]),
      ]),
    ).toEqual([
      { name: "label", mean: null, count: 2, mean_count: 0, passed: 0, failed: 0, unjudged: 2 },
      { name: "passed", mean: 2 / 3, count: 3, mean_count: 3, passed: 2, failed: 1, unjudged: 0 },
      { name: "length", mean: 5, count: 3, mean_count: 2, passed: 0, failed: 0, unjudged: 3 },
    ]);
  });
});

describe("meanDuration", () => {
  const timed = (duration_ms: number | null): CaseLine => ({
    case_id: "case-0",
    status: "not_scored",
    input: null,
    expected: null,
    task_error: null,
    scorer_errors: [],
    duration_ms,
    scores: [],
  });

  it("averages the cases that were timed, and counts them", () => {
    expect(meanDuration([timed(1), timed(null), timed(4)])).toEqual({ mean: 2.5, count: 2 });
  });

  it("has no mean when no case was timed", () => {
    expect(meanDuration([timed(null)])).toEqual({ mean: null, count: 0 });
    expect(meanDuration([])).toEqual({ mean: null, count: 0 });
  });
});
