import { spawn, spawnSync } from "node:child_process";
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
import { scoreMeans } from "../../src/commands/evals-run.js";
import { type CaseLine, parseCaseLines } from "../../src/eval/protocol.js";

/**
 * `traceroot evals run`, end to end: the built CLI in a project of its own, with a stub runner
 * (tests/helpers/evalRunnerStub.cjs) standing in for the SDK's. The stub replays the runs recorded
 * from the released SDKs, so what the command reads is what a real runner writes.
 */

const BIN = fileURLToPath(new URL("../../bin/traceroot.mjs", import.meta.url));
const STUB = fileURLToPath(new URL("../helpers/evalRunnerStub.cjs", import.meta.url));
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
  events?: object[];
  exit?: number;
  wait?: boolean;
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
async function interrupt(signal: NodeJS.Signals, ...args: string[]): Promise<Result> {
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
  child.kill(signal);
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
  it("runs the file, prints each evaluation with its run id and score means, and exits 0", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/one-fails`, run_id: "run_first" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      [
        "uppercase · run_first · completed",
        "  3 cases · 0 errored",
        "  SCORE        MEAN   CASES",
        "  exact_match  0.667  3",
        "  not_empty    1      3",
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
      `Running x_eval.py with traceroot 0.5.1 (${join(project, ".venv", "bin", "python")})`,
    );
    expect(run.stdout).not.toContain("runner");
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

  it("counts the errors of a run that has some", () => {
    pythonProject();
    evalFile("x_eval.py", { replay: `${PYTHON}/task-error`, run_id: "run_first" });

    const run = evalsRun("x_eval.py");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("uppercase · run_first · completed with errors\n");
    expect(run.stdout).toContain("  3 cases · 1 errored (1 task error, 0 scorer errors)\n");
    expect(run.stdout).toContain("  exact_match  1     2\n");
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
      runs: [
        {
          evaluation_name: "uppercase",
          local_run_id: "run_first",
          status: "completed",
          path: join(project, ".traceroot", "eval", "runs", "run_first.json"),
          counts: { cases: 3, errored: 0, task_errors: 0, scorer_errors: 0, not_scored: 3 },
          scores: [
            { name: "exact_match", mean: 2 / 3, count: 3 },
            { name: "not_empty", mean: 1, count: 3 },
          ],
        },
      ],
      baseline: null,
      verdict: null,
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
        "Regressed against baseline run_first: 1 case and scorer pair newly fails.",
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
      "Regressed against baseline run_first: 2 case and scorer pairs newly fail, and 1 case newly errors.",
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
  });

  it("exits 0 when nothing that passed fails, and counts what changed", () => {
    pythonProject();
    saveRun(`${PYTHON}/one-fails`, "run_first");
    evalFile("x_eval.py", { replay: `${PYTHON}/all-pass`, run_id: "run_second" });

    const run = evalsRun("x_eval.py", "--baseline", "run_first");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "No regression against baseline run_first: nothing that passed there fails now.\n\n1 score changed without regressing; --json lists it.\n",
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
      'Not compared with baseline run_first: the runs used different datasets: revision "rev_854c88d1e7648742" in the baseline run and "rev_c975c5d18e3e9e4b" in the new run.',
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
      'Not compared with baseline run_first: the file ran no evaluation named "titlecase", which the baseline run is of; it ran "uppercase".',
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
      "error: the eval runner exited with status 1 before it reported the end of the run; its output is above",
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
      expect(run.stdout).toContain("uppercase · run_second · incomplete\n  1 case · 0 errored\n");
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
    expect(scoreMeans(cases)).toEqual(Object.values(completed[0]?.score_summary ?? {}));
  });

  it("averages numbers and booleans, and counts any other value without a mean", () => {
    const item = (scores: [string, unknown][]): CaseLine => ({
      case_id: "case-0",
      status: "not_scored",
      input: null,
      expected: null,
      task_error: null,
      scorer_errors: [],
      scores: scores.map(([scorer_name, value]) => ({
        scorer_name,
        scorer_version: null,
        value,
        passed: null,
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
      ]),
    ).toEqual([
      { name: "label", mean: null, count: 2 },
      { name: "passed", mean: 0.5, count: 2 },
      { name: "length", mean: 5, count: 2 },
    ]);
  });
});
