import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaseLine } from "../../src/eval/protocol.js";
import { type SavedRun, compareRuns, loadRun, partialRunReason } from "../../src/eval/verdict.js";

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

/** A copy of a run with a change made to it, leaving the run itself as it was. */
function changed(run: SavedRun, change: (copy: SavedRun) => void): SavedRun {
  const copy = structuredClone(run);
  change(copy);
  return copy;
}

const SDKS = ["python-0.5.1", "typescript-0.8.1"];

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

describe("compareRuns: whether two runs can be compared", () => {
  it.each(SDKS)("compares two full runs of one dataset on %s", (sdk) => {
    expect(compareRuns(recorded(sdk, "all-pass"), recorded(sdk, "one-fails"))).toMatchObject({
      not_comparable_reason: null,
      payloads: "complete",
    });
  });

  it("compares a run saved by the oldest release with one saved by the newest", () => {
    const python = compareRuns(
      recorded("python-0.3.0", "all-pass"),
      recorded("python-0.5.1", "one-fails"),
    );
    const typescript = compareRuns(
      recorded("typescript-0.8.0", "all-pass"),
      recorded("typescript-0.8.1", "one-fails"),
    );

    expect(python.not_comparable_reason).toBeNull();
    expect(typescript.not_comparable_reason).toBeNull();
  });

  it("refuses two inline datasets of the same size whose rows differ, on both SDKs", () => {
    const typescript = compareRuns(
      recorded("typescript-0.8.1", "inline-rows-a"),
      recorded("typescript-0.8.1", "inline-rows-b"),
    );
    const python = compareRuns(
      recorded("python-0.5.1", "inline-rows-a"),
      recorded("python-0.5.1", "inline-rows-b"),
    );

    // @traceroot-ai/traceroot records local-2 for both, so only the stored rows tell them apart.
    expect(typescript.not_comparable_reason).toBe(
      'case "case-1" has a different stored input and expected in the two runs',
    );
    expect(python.not_comparable_reason).toBe(
      'the runs used different datasets: revision "rev_854c88d1e7648742" in the baseline run and "rev_c975c5d18e3e9e4b" in the new run',
    );
  });

  it("tells traceroot's inline datasets apart by their rows too, whatever the revision says", () => {
    const a = recorded("python-0.5.1", "inline-rows-a");
    const b = changed(recorded("python-0.5.1", "inline-rows-b"), (run) => {
      run.file.dataset = a.file.dataset;
    });

    expect(compareRuns(a, b).not_comparable_reason).toBe(
      'case "case-1" has a different stored input and expected in the two runs',
    );
  });

  it.each(SDKS)("refuses a sampled or interrupted baseline on %s, saying which", (sdk) => {
    const full = recorded(sdk, "all-pass");

    expect(compareRuns(recorded(sdk, "sampled"), full).not_comparable_reason).toBe(
      'the baseline run is sampled (run_mode "sample"), so it ran only some of its cases',
    );
    expect(compareRuns(recorded(sdk, "interrupted"), full).not_comparable_reason).toBe(
      'the baseline run was interrupted before it finished (status "incomplete")',
    );
  });

  it.each(SDKS)("refuses a sampled or interrupted new run on %s", (sdk) => {
    const full = recorded(sdk, "all-pass");

    expect(compareRuns(full, recorded(sdk, "sampled")).not_comparable_reason).toBe(
      'the new run is sampled (run_mode "sample"), so it ran only some of its cases',
    );
    expect(compareRuns(full, recorded(sdk, "interrupted")).not_comparable_reason).toBe(
      'the new run was interrupted before it finished (status "incomplete")',
    );
  });

  it("refuses runs of different evaluations, escaping what it quotes from them", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    const renamed = changed(baseline, (run) => {
      run.file.evaluation_name = "upper\x1b[2Jcase";
    });

    expect(compareRuns(baseline, renamed).not_comparable_reason).toBe(
      'the runs are of different evaluations: "uppercase" in the baseline run and "upper\\u001b[2Jcase" in the new run',
    );
  });

  it("refuses a run that records no dataset", () => {
    const run = recorded("typescript-0.8.1", "all-pass");
    const noDataset = changed(run, (copy) => {
      copy.file.dataset = null;
    });

    expect(compareRuns(noDataset, run).not_comparable_reason).toBe(
      "the baseline run records no dataset revision",
    );
    expect(compareRuns(run, noDataset).not_comparable_reason).toBe(
      "the new run records no dataset revision",
    );
  });

  it("refuses a run with two cases of one id, which can't be paired", () => {
    const run = recorded("python-0.5.1", "inline-rows-a");
    const twice = changed(run, (copy) => {
      copy.cases.push(structuredClone(copy.cases[0] as CaseLine));
    });

    expect(compareRuns(run, twice).not_comparable_reason).toBe(
      'the new run has more than one case with id "case-0", so its cases can\'t be paired by id',
    );
  });

  it("names the case ids only one run has", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    const current = changed(baseline, (run) => {
      run.cases = run.cases.slice(1);
      run.cases.push({ ...(run.cases[0] as CaseLine), case_id: "tc_new" });
    });

    expect(compareRuns(baseline, current).not_comparable_reason).toBe(
      'the runs have different cases: 1 ("tc_7498af1b5adef7e84e04") only in the baseline run, and 1 ("tc_new") only in the new run',
    );
  });

  it("shows the first three of many case ids only one run has", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    const current = changed(baseline, (run) => {
      for (const id of ["e", "d", "c", "b", "a"]) {
        run.cases.push({ ...(run.cases[0] as CaseLine), case_id: id });
      }
    });

    expect(compareRuns(baseline, current).not_comparable_reason).toBe(
      'the runs have different cases: 5 ("a", "b", "c" and 2 more) only in the new run',
    );
  });

  it("counts the other cases whose rows differ", () => {
    const baseline = recorded("typescript-0.8.1", "all-pass");
    const current = changed(baseline, (run) => {
      for (const item of run.cases) {
        item.expected = "?";
      }
    });

    expect(compareRuns(baseline, current).not_comparable_reason).toBe(
      'case "tc_7498af1b5adef7e84e04" has a different stored expected in the two runs, as do 2 other cases',
    );
  });

  it("compares stored truncated values as they are, and says so", () => {
    const truncate = (run: SavedRun) => {
      run.file.artifact.payloads = "truncated";
      for (const item of run.cases) {
        item.input = { truncated: true, preview: `"${String(item.input).slice(0, 2)}` };
      }
    };
    const complete = recorded("python-0.5.1", "all-pass");
    const truncated = changed(complete, truncate);

    expect(compareRuns(truncated, changed(complete, truncate))).toMatchObject({
      not_comparable_reason: null,
      payloads: "truncated",
    });
    expect(compareRuns(complete, truncated)).toEqual({
      not_comparable_reason:
        'case "tc_7498af1b5adef7e84e04" has a different stored input in the two runs, as do 2 other cases (the new run stores truncated payloads, so the stored, truncated values were compared)',
      payloads: "truncated",
    });
  });
});

describe("partialRunReason", () => {
  const full = recorded("python-0.5.1", "all-pass").file;

  it("accepts a full, final run, with or without errors", () => {
    expect(partialRunReason(full, "baseline")).toBeNull();
    expect(partialRunReason(recorded("python-0.5.1", "task-error").file, "baseline")).toBeNull();
  });

  it("refuses a run of the first cases, and one not marked final", () => {
    expect(partialRunReason({ ...full, run_mode: "first", is_final: false }, "baseline")).toBe(
      'the baseline run ran only its first cases (run_mode "first")',
    );
    expect(partialRunReason({ ...full, is_final: false }, "new")).toBe(
      "the new run isn't final (is_final is false)",
    );
  });
});
