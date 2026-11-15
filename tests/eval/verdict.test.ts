import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SavedRun, loadRun } from "../../src/eval/verdict.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/eval/", import.meta.url));
const RUN_ID = "run_00000000000000000000000001";

/** The path of the run file a runner saved in a recorded scenario. */
function recordedPath(sdk: string, scenario: string): string {
  return join(FIXTURES, sdk, scenario, "runs", `${RUN_ID}.json`);
}

/** The run a runner saved in a recorded scenario, read the way the command reads it. */
function recorded(sdk: string, scenario: string): SavedRun {
  const load = loadRun(recordedPath(sdk, scenario));
  if (!load.ok) {
    throw new Error(load.message);
  }
  return load.run;
}

describe("loadRun", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tr-eval-verdict-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Copies a recorded run into the test's folder, so a test can change or remove its files. */
  function copyRecorded(sdk: string, scenario: string): { run: string; cases: string } {
    const source = recordedPath(sdk, scenario);
    const run = join(dir, `${RUN_ID}.json`);
    const cases = join(dir, `${RUN_ID}.cases.jsonl`);
    writeFileSync(run, readFileSync(source));
    writeFileSync(cases, readFileSync(source.replace(/\.json$/, ".cases.jsonl")));
    return { run, cases };
  }

  it("reads a run file and the case lines beside it", () => {
    const run = recorded("python-0.5.1", "one-fails");

    expect(run.file).toMatchObject({ evaluation_name: "uppercase", status: "completed" });
    expect(run.cases.map((item) => item.input)).toEqual(["alpha", "beta", "gamma"]);
    expect(run.cases[1]?.scores).toContainEqual({
      scorer_name: "exact_match",
      scorer_version: null,
      value: false,
      passed: false,
    });
  });

  it("reports a run file that isn't there as missing", () => {
    const path = join(dir, "run_nope.json");

    expect(loadRun(path)).toEqual({
      ok: false,
      reason: "missing",
      message: `no saved run at ${path}`,
    });
  });

  it("reports a run whose case lines are gone as invalid, naming the missing file", () => {
    const { run, cases } = copyRecorded("typescript-0.8.1", "all-pass");
    rmSync(cases);

    expect(loadRun(run)).toEqual({
      ok: false,
      reason: "invalid",
      message: `the saved run ${run} has no case lines: ${cases} is missing`,
    });
  });

  it("names the file and the field when either file can't be parsed", () => {
    const { run, cases } = copyRecorded("python-0.5.1", "all-pass");
    const text = readFileSync(run, "utf8");
    writeFileSync(run, text.replace('"run_mode": "full"', '"run_mode": "partial"'));

    expect(loadRun(run)).toMatchObject({
      ok: false,
      reason: "invalid",
      message: `${run}: run file: "run_mode" should be one of full, first, sample, found "partial"`,
    });

    writeFileSync(run, text);
    writeFileSync(cases, `${readFileSync(cases, "utf8")}{"case_id": "tc_1"}\n`);

    expect(loadRun(run)).toMatchObject({
      ok: false,
      reason: "invalid",
      message: `${cases}: case line 4: "status" is missing`,
    });
  });

  it("refuses a path that doesn't name a run file", () => {
    const { cases } = copyRecorded("python-0.5.1", "all-pass");

    expect(loadRun(cases)).toEqual({
      ok: false,
      reason: "invalid",
      message: `${cases} is not a run file: a saved run is read from its <run id>.json file`,
    });
  });
});
