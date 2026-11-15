import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TSX_FLOOR, TS_SDK_FLOOR } from "../../../src/eval/node.js";
import { PYTHON_SDK_FLOOR } from "../../../src/eval/python.js";
import {
  STUB_API_KEY,
  type StubRequest,
  type TraceRootStub,
  startTraceRootStub,
} from "../../helpers/traceRootStub.js";

/**
 * `traceroot evals run` through the eval runners of released SDKs. The command's own tests stand a
 * stub in for the runner, which can't show how a real SDK loads an evaluation file. This installs
 * each pinned release into a copy of a fixture project and runs the built CLI on its files:
 * - the passing evaluation exits 0 and its `--json` document parses: a `.py` file, and a `.ts`,
 *   `.js` and `.mjs` file in a monorepo package, with the CLI run from the repository root;
 * - the regressed variant exits 18 against a run of the passing one;
 * - a file with no module-level evaluation exits 17;
 * - every run gets a fake project key and a stub TraceRoot host. Without `--upload` the stub
 *   receives nothing; with it, the runner's upload requests reach the stub carrying the key.
 *
 * It isn't part of `npm test`, because installing the SDKs needs the package registries. Run it
 * from the repository root, with python3 and npm on PATH:
 *
 *   npx vitest run --config tests/smoke/evals/vitest.config.ts
 */

/**
 * The releases checked for each language: the oldest `evals run` supports, and the newest. Pinned
 * rather than `latest`, so a new release can't fail an unrelated change; moving a pin is a one-line
 * change.
 */
const PYTHON_SDK_VERSIONS = [PYTHON_SDK_FLOOR, "0.5.1"];
const TYPESCRIPT_SDK_VERSIONS = [TS_SDK_FLOOR, "0.8.1"];

const BIN = fileURLToPath(new URL("../../../bin/traceroot.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL(".", import.meta.url));

/** The case the regressed variant breaks. Every release derives the same id from its content. */
const BETA = "tc_7d6e5d505f6ca7767380";

/** What an uploaded run sends, in each release. `whoami` is the CLI's key check. */
const UPLOAD_ROUTES = [
  "GET /api/v1/public/whoami",
  "GET /api/v1/public/datasets/{id}",
  "POST /api/v1/public/datasets",
  "POST /api/v1/public/datasets/{id}/versions",
  "POST /api/v1/public/evaluation-runs",
  "POST /api/v1/public/evaluation-runs/{id}/results",
  "POST /api/v1/public/evaluation-runs/{id}/complete",
  "POST /api/v1/public/traces",
];

let work: string;
let stub: TraceRootStub;

beforeAll(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "traceroot-evals-smoke-")));
  mkdirSync(join(work, "home"));
  mkdirSync(join(work, "tmp"));
  stub = await startTraceRootStub();
});

afterAll(async () => {
  await stub.close();
  rmSync(work, { recursive: true, force: true });
});

describe.each(PYTHON_SDK_VERSIONS)("traceroot %s", (version) => {
  const project = (): string => join(work, `python-${version}`);

  beforeAll(() => {
    cpSync(join(FIXTURES, "python"), project(), { recursive: true });
    // At the project root, where the lookup finds it for a file under evals/.
    const venv = join(project(), ".venv");
    install("python3", ["-m", "venv", venv]);
    install(join(venv, "bin", "python"), [
      "-m",
      "pip",
      "install",
      "--quiet",
      "--disable-pip-version-check",
      `traceroot==${version}`,
    ]);
  });

  checkEvalsRun({
    version,
    root: project,
    passing: ["evals/passing_eval.py"],
    regressed: "evals/regressed_eval.py",
    noEvaluation: "evals/no_evaluation_eval.py",
  });
});

describe.each(TYPESCRIPT_SDK_VERSIONS)(
  `@traceroot-ai/traceroot %s, tsx ${TSX_FLOOR}`,
  (version) => {
    /** The monorepo's root, where the CLI runs. The project is packages/app. */
    const root = (): string => join(work, `typescript-${version}`);

    beforeAll(() => {
      cpSync(join(FIXTURES, "typescript"), root(), { recursive: true });
      install(
        "npm",
        [
          "install",
          "--no-save",
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          "--loglevel=error",
          `@traceroot-ai/traceroot@${version}`,
          `tsx@${TSX_FLOOR}`,
        ],
        join(root(), "packages", "app"),
      );
      // Nothing is installed at the root, so neither the SDK nor tsx resolves from where the CLI runs.
      expect(existsSync(join(root(), "node_modules"))).toBe(false);
    });

    checkEvalsRun({
      version,
      root,
      passing: [
        "packages/app/evals/passing.eval.ts",
        "packages/app/evals/passing.eval.js",
        "packages/app/evals/passing.eval.mjs",
      ],
      regressed: "packages/app/evals/regressed.eval.ts",
      noEvaluation: "packages/app/evals/no-evaluation.eval.ts",
    });
  },
);

interface Fixture {
  /** The SDK release installed. */
  version: string;
  /** Where the CLI runs; each file is relative to it. */
  root: () => string;
  /**
   * The passing evaluation, once per file type. The first is the baseline the regressed variant is
   * compared with, and the file that is uploaded.
   */
  passing: [string, ...string[]];
  regressed: string;
  noEvaluation: string;
}

function checkEvalsRun(fixture: Fixture): void {
  const [first] = fixture.passing;

  it.each(fixture.passing)("exits 0 for %s, with a --json document that parses", async (file) => {
    const run = await evalsRun(fixture.root(), file, "--json");

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      outcome: "ok",
      sdk: { version: fixture.version },
      runs: [
        {
          evaluation_name: "uppercase",
          status: "completed",
          counts: { cases: 3, errored: 0 },
          scores: [
            { name: "exact_match", mean: 1, count: 3 },
            { name: "not_empty", mean: 1, count: 3 },
          ],
        },
      ],
    });
    expect(run.requests).toEqual([]);
  });

  it(`exits 18 for ${fixture.regressed} against a run of ${first}`, async () => {
    const baseline = await evalsRun(fixture.root(), first, "--json");
    expect(baseline.status, baseline.stderr).toBe(0);
    const id = (JSON.parse(baseline.stdout) as RunDocument).runs[0]?.local_run_id ?? "";

    const run = await evalsRun(fixture.root(), fixture.regressed, "--baseline", id, "--json");

    expect(run.status, run.stderr).toBe(18);
    expect(JSON.parse(run.stdout)).toMatchObject({
      outcome: "regressed",
      baseline: { local_run_id: id },
      verdict: {
        newly_failing: [{ case_id: BETA, scorer_name: "exact_match", reason: "failed" }],
        newly_errored: [],
      },
    });
    expect([...baseline.requests, ...run.requests]).toEqual([]);
  });

  it(`exits 17 for ${fixture.noEvaluation}, which has no module-level evaluation`, async () => {
    const run = await evalsRun(fixture.root(), fixture.noEvaluation, "--json");

    expect(run.status, run.stderr).toBe(17);
    expect(run.stdout).toBe("");
    expect(envelope(run.stderr)).toMatchObject({
      code: "harness",
      message: expect.stringContaining("defines no evaluation"),
    });
    expect(run.requests).toEqual([]);
  });

  it(`uploads a run of ${first} with --upload, with the key on every request`, async () => {
    const run = await evalsRun(fixture.root(), first, "--upload", "--json");

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      outcome: "ok",
      runs: [{ uploaded_run_id: expect.stringMatching(/^evr_stub_\d+$/) }],
    });
    expect([...new Set(run.requests.map(route))].sort()).toEqual([...UPLOAD_ROUTES].sort());
    expect(
      run.requests.filter((request) => request.authorization !== `Bearer ${STUB_API_KEY}`),
    ).toEqual([]);
  });
}

/** The parts of the `--json` document read here. */
interface RunDocument {
  runs: { local_run_id: string }[];
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** What the stub received while the command ran. */
  requests: StubRequest[];
}

/**
 * Runs the built CLI's `evals run` from `cwd`, in an environment of its own: a scratch HOME, a fake
 * project key and the stub as the TraceRoot host. Started without blocking, so the stub can answer.
 */
async function evalsRun(cwd: string, ...args: string[]): Promise<Run> {
  const before = stub.requests.length;
  const child = spawn(process.execPath, [BIN, "evals", "run", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(work, "home"),
      TMPDIR: join(work, "tmp"),
      TRACEROOT_API_KEY: STUB_API_KEY,
      TRACEROOT_HOST_URL: stub.url,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stdout, stderr, requests: stub.requests.slice(before) };
}

/** Runs one step of installing an SDK, with its output in the log. */
function install(program: string, args: string[], cwd?: string): void {
  execFileSync(program, args, { cwd, stdio: "inherit" });
}

/** The `--json` error envelope: the last line on stderr, after the runner's own output. */
function envelope(stderr: string): { code: string; message: string } {
  const last = stderr.trim().split("\n").at(-1) ?? "";
  return (JSON.parse(last) as { error: { code: string; message: string } }).error;
}

/** A request's method and path, without its query, and with each dataset or run id as `{id}`. */
function route({ method, path }: StubRequest): string {
  const bare = path.split("?")[0] ?? path;
  return `${method} ${bare.replace(/^(\/api\/v1\/public\/(?:datasets|evaluation-runs))\/[^/]+/, "$1/{id}")}`;
}
