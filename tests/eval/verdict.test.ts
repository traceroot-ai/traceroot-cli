import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaseLine, CaseScore } from "../../src/eval/protocol.js";
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

/** One case's score from one scorer, to change in a copied run. */
function scoreOn(run: SavedRun, caseId: string, scorer: string): CaseScore {
  const score = run.cases
    .find((item) => item.case_id === caseId)
    ?.scores.find((item) => item.scorer_name === scorer);
  if (score === undefined) {
    throw new Error(`the run has no ${scorer} score on ${caseId}`);
  }
  return score;
}

const SDKS = ["python-0.5.1", "typescript-0.8.1"];

const ALPHA = "tc_7498af1b5adef7e84e04";
const BETA = "tc_7d6e5d505f6ca7767380";
const GAMMA = "tc_a361d792d474d4c2e312";

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

  it("reports either file as invalid, naming it, when a folder is in its place", () => {
    const folder = join(dir, `${RUN_ID}.json`);
    mkdirSync(folder);

    expect(loadRun(folder)).toEqual({
      ok: false,
      reason: "invalid",
      message: expect.stringContaining(`${folder}: EISDIR`),
    });

    rmSync(folder, { recursive: true });
    const { run, cases } = copyRecorded("python-0.5.1", "all-pass");
    rmSync(cases);
    mkdirSync(cases);

    expect(loadRun(run)).toEqual({
      ok: false,
      reason: "invalid",
      message: expect.stringContaining(`${cases}: EISDIR`),
    });
  });

  // Root reads a file whatever its mode, and Windows has no such mode.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a run file the CLI may not read as invalid, naming it",
    () => {
      const { run } = copyRecorded("python-0.5.1", "all-pass");
      chmodSync(run, 0o000);

      expect(loadRun(run)).toEqual({
        ok: false,
        reason: "invalid",
        message: expect.stringContaining(`${run}: EACCES`),
      });
    },
  );

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

  it("refuses a run that lists one score name twice on a case, so neither score can hide a failure", () => {
    const run = recorded("python-0.5.1", "all-pass");
    // Two scorers can each give a score named exact_match. On beta, the second one fails now.
    const withSecond = (passed: boolean) =>
      changed(run, (copy) => {
        const beta = copy.cases.find((item) => item.case_id === BETA) as CaseLine;
        beta.scores.push({
          scorer_name: "exact_match",
          scorer_version: null,
          value: passed,
          passed,
        });
      });

    expect(compareRuns(withSecond(true), withSecond(false))).toEqual({
      outcome: "not_comparable",
      newly_failing: [],
      newly_errored: [],
      changed: [],
      not_comparable_reason: `the baseline run has more than one score named "exact_match" on case "${BETA}", so its scores can't be paired by scorer`,
      payloads: "complete",
    });
    expect(compareRuns(run, withSecond(false)).not_comparable_reason).toBe(
      `the new run has more than one score named "exact_match" on case "${BETA}", so its scores can't be paired by scorer`,
    );
  });

  it("refuses a run that lists one scorer error name twice on a case", () => {
    const run = recorded("python-0.5.1", "scorer-error-unversioned");
    const twice = changed(run, (copy) => {
      const beta = copy.cases.find((item) => item.case_id === BETA) as CaseLine;
      beta.scorer_errors.push({
        scorer_name: "exact_match",
        scorer_version: null,
        message: "other",
      });
    });

    expect(compareRuns(recorded("python-0.5.1", "all-pass"), twice).not_comparable_reason).toBe(
      `the new run has more than one scorer error named "exact_match" on case "${BETA}", so its scorer errors can't be paired by scorer`,
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
      outcome: "not_comparable",
      newly_failing: [],
      newly_errored: [],
      changed: [],
      not_comparable_reason:
        'case "tc_7498af1b5adef7e84e04" has a different stored input in the two runs, as do 2 other cases (the new run stores truncated payloads, so the stored, truncated values were compared)',
      payloads: "truncated",
    });
  });
});

describe("compareRuns: what regressed", () => {
  it.each(SDKS)("finds nothing in two runs that both pass on %s", (sdk) => {
    expect(compareRuns(recorded(sdk, "all-pass"), recorded(sdk, "all-pass"))).toEqual({
      outcome: "ok",
      newly_failing: [],
      newly_errored: [],
      changed: [],
      not_comparable_reason: null,
      payloads: "complete",
    });
  });

  it.each(SDKS)("lists exactly the recorded pair that newly fails on %s", (sdk) => {
    expect(compareRuns(recorded(sdk, "all-pass"), recorded(sdk, "one-fails"))).toEqual({
      outcome: "regressed",
      newly_failing: [
        { case_id: BETA, scorer_name: "exact_match", reason: "failed", value: false, error: null },
      ],
      newly_errored: [],
      changed: [],
      not_comparable_reason: null,
      payloads: "complete",
    });
  });

  it.each(SDKS)("lists a case whose task raises as newly errored on %s", (sdk) => {
    const verdict = compareRuns(recorded(sdk, "all-pass"), recorded(sdk, "task-error"));
    const raised = expect.stringContaining("cannot convert");

    expect(verdict.outcome).toBe("regressed");
    expect(verdict.newly_errored).toEqual([
      { case_id: BETA, task_error: raised, scorer_errors: [] },
    ]);
    // No scorer ran on the case, so each pair that passed there is newly failing too.
    expect(verdict.newly_failing).toEqual([
      {
        case_id: BETA,
        scorer_name: "exact_match",
        reason: "task_error",
        value: null,
        error: raised,
      },
      { case_id: BETA, scorer_name: "not_empty", reason: "task_error", value: null, error: raised },
    ]);
    expect(verdict.changed).toEqual([]);
  });

  it.each(SDKS)(
    "counts a raising scorer as newly failing, never as a version change, on %s",
    (sdk) => {
      const baseline = recorded(sdk, "all-pass");
      const unversioned = compareRuns(baseline, recorded(sdk, "scorer-error-unversioned"));
      // not_empty declares version 2, and its error is recorded with no version.
      const versioned = compareRuns(baseline, recorded(sdk, "scorer-error-versioned"));

      expect(unversioned.newly_failing).toEqual([
        {
          case_id: BETA,
          scorer_name: "exact_match",
          reason: "scorer_error",
          value: null,
          error: expect.stringContaining("cannot compare"),
        },
      ]);
      expect(versioned.newly_failing).toEqual([
        {
          case_id: BETA,
          scorer_name: "not_empty",
          reason: "scorer_error",
          value: null,
          error: expect.stringContaining("cannot check"),
        },
      ]);
      for (const verdict of [unversioned, versioned]) {
        expect(verdict.outcome).toBe("regressed");
        expect(verdict.changed).toEqual([]);
        expect(verdict.newly_errored).toMatchObject([{ case_id: BETA, task_error: null }]);
      }
    },
  );

  it("doesn't count a case that already errored in the baseline as newly errored", () => {
    const taskError = recorded("python-0.5.1", "task-error");
    const scorerError = recorded("python-0.5.1", "scorer-error-unversioned");

    expect(compareRuns(taskError, taskError).outcome).toBe("ok");
    // The task raised on beta in the baseline, so no pair passed there to newly fail.
    expect(compareRuns(taskError, scorerError)).toMatchObject({
      outcome: "ok",
      newly_failing: [],
      newly_errored: [],
    });
  });

  it("lists a pair whose scorer is gone from the new run as newly failing", () => {
    const baseline = recorded("typescript-0.8.1", "all-pass");
    const removed = changed(baseline, (run) => {
      run.file.scorers = run.file.scorers.filter((scorer) => scorer.name !== "not_empty");
      for (const item of run.cases) {
        item.scores = item.scores.filter((score) => score.scorer_name !== "not_empty");
      }
    });
    const renamed = changed(baseline, (run) => {
      for (const item of run.cases) {
        for (const score of item.scores) {
          if (score.scorer_name === "not_empty") {
            score.scorer_name = "non_empty";
          }
        }
      }
    });
    const missing = (caseId: string) => ({
      case_id: caseId,
      scorer_name: "not_empty",
      reason: "missing",
      value: null,
      error: null,
    });

    for (const current of [removed, renamed]) {
      expect(compareRuns(baseline, current)).toMatchObject({
        outcome: "regressed",
        newly_failing: [missing(ALPHA), missing(BETA), missing(GAMMA)],
        changed: [],
      });
    }
  });

  it("blames a raising scorer for the pairs whose scores it gives under other names", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    // One scorer, check_doc, gives both scores. A scorer that raises is recorded under its own name.
    const raised = changed(baseline, (run) => {
      const beta = run.cases.find((item) => item.case_id === BETA) as CaseLine;
      beta.status = "errored";
      beta.scores = [];
      beta.scorer_errors = [
        { scorer_name: "check_doc", scorer_version: null, message: "KeyError: 'title'" },
      ];
    });
    const twoRaised = changed(raised, (run) => {
      const beta = run.cases.find((item) => item.case_id === BETA) as CaseLine;
      beta.scorer_errors.unshift({
        scorer_name: "check_title",
        scorer_version: null,
        message: "ValueError: empty",
      });
    });
    const blamed = (scorer: string, error: string) => ({
      case_id: BETA,
      scorer_name: scorer,
      reason: "scorer_error",
      value: null,
      error,
    });

    const one = "check_doc: KeyError: 'title'";
    expect(compareRuns(baseline, raised)).toMatchObject({
      outcome: "regressed",
      newly_failing: [blamed("exact_match", one), blamed("not_empty", one)],
      newly_errored: [{ case_id: BETA }],
    });
    const both = "check_doc: KeyError: 'title'; check_title: ValueError: empty";
    expect(compareRuns(baseline, twoRaised).newly_failing).toEqual([
      blamed("exact_match", both),
      blamed("not_empty", both),
    ]);
  });

  it.each(SDKS)(
    "reports a changed numeric score with no threshold, without calling it a regression, on %s",
    (sdk) => {
      const baseline = recorded(sdk, "numeric-no-threshold");
      const longer = changed(baseline, (run) => {
        scoreOn(run, BETA, "output_length").value = 7;
      });

      expect(compareRuns(baseline, longer)).toEqual({
        outcome: "ok",
        newly_failing: [],
        newly_errored: [],
        changed: [
          {
            case_id: BETA,
            scorer_name: "output_length",
            change: "value",
            baseline: { scorer_version: null, value: 4, passed: null },
            current: { scorer_version: null, value: 7, passed: null },
          },
        ],
        not_comparable_reason: null,
        payloads: "complete",
      });
    },
  );

  it("lists a pair that passed and now neither passes nor fails as newly failing", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    const unjudged = (version: string | null) =>
      changed(baseline, (run) => {
        const score = scoreOn(run, BETA, "exact_match");
        score.scorer_version = version;
        score.value = 0.5;
        score.passed = null;
      });

    expect(compareRuns(baseline, unjudged(null))).toMatchObject({
      outcome: "regressed",
      newly_failing: [
        { case_id: BETA, scorer_name: "exact_match", reason: "unjudged", value: 0.5, error: null },
      ],
      changed: [],
    });
    // Under another version, the two scores may not mean the same thing.
    expect(compareRuns(baseline, unjudged("2"))).toMatchObject({
      outcome: "ok",
      newly_failing: [],
      changed: [{ case_id: BETA, scorer_name: "exact_match", change: "scorer_version" }],
    });
  });

  it.each(SDKS)(
    "reports a scorer that raised in the baseline and has a score now, without calling it a regression, on %s",
    (sdk) => {
      const allPass = recorded(sdk, "all-pass");
      const unversioned = compareRuns(recorded(sdk, "scorer-error-unversioned"), allPass);
      const versioned = compareRuns(recorded(sdk, "scorer-error-versioned"), allPass);

      expect(unversioned).toEqual({
        outcome: "ok",
        newly_failing: [],
        newly_errored: [],
        changed: [
          {
            case_id: BETA,
            scorer_name: "exact_match",
            change: "scorer_recovered",
            baseline: { scorer_version: null, message: expect.stringContaining("cannot compare") },
            current: { scorer_version: null, value: true, passed: true },
          },
        ],
        not_comparable_reason: null,
        payloads: "complete",
      });
      // The error carries no version and the score carries version 2: not a version change.
      expect(versioned.changed).toEqual([
        {
          case_id: BETA,
          scorer_name: "not_empty",
          change: "scorer_recovered",
          baseline: { scorer_version: null, message: expect.stringContaining("cannot check") },
          current: { scorer_version: "2", value: true, passed: true },
        },
      ]);
    },
  );

  it("keeps a case's changes in scorer order, whether the baseline scored a scorer or saw it raise", () => {
    // On beta, the baseline saw exact_match raise and scored not_empty.
    const baseline = recorded("python-0.5.1", "scorer-error-unversioned");
    const current = changed(recorded("python-0.5.1", "all-pass"), (run) => {
      scoreOn(run, BETA, "not_empty").scorer_version = "3";
    });

    expect(
      compareRuns(baseline, current).changed.map((pair) => [pair.scorer_name, pair.change]),
    ).toEqual([
      ["exact_match", "scorer_recovered"],
      ["not_empty", "scorer_version"],
    ]);
  });

  it("reports a pair that went from failing to passing, without calling it a regression", () => {
    const verdict = compareRuns(
      recorded("python-0.5.1", "one-fails"),
      recorded("python-0.5.1", "all-pass"),
    );

    expect(verdict).toMatchObject({ outcome: "ok", newly_failing: [], newly_errored: [] });
    expect(verdict.changed).toEqual([
      {
        case_id: BETA,
        scorer_name: "exact_match",
        change: "passed",
        baseline: { scorer_version: null, value: false, passed: false },
        current: { scorer_version: null, value: true, passed: true },
      },
    ]);
  });

  it("reports a scorer whose version changed, even where its score now fails", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    const bumped = changed(baseline, (run) => {
      for (const item of run.cases) {
        for (const score of item.scores) {
          if (score.scorer_name === "not_empty") {
            score.scorer_version = "3";
            if (item.case_id === BETA) {
              score.value = false;
              score.passed = false;
            }
          }
        }
      }
    });

    const verdict = compareRuns(baseline, bumped);

    expect(verdict).toMatchObject({ outcome: "ok", newly_failing: [], newly_errored: [] });
    expect(verdict.changed).toEqual(
      [ALPHA, BETA, GAMMA].map((caseId) => ({
        case_id: caseId,
        scorer_name: "not_empty",
        change: "scorer_version",
        baseline: { scorer_version: "2", value: true, passed: true },
        current: {
          scorer_version: "3",
          value: caseId !== BETA,
          passed: caseId !== BETA,
        },
      })),
    );
  });

  it("gives the same verdict, sorted by case id then scorer, whatever order the runs list things in", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    const failing = changed(baseline, (run) => {
      for (const item of run.cases) {
        for (const score of item.scores) {
          score.value = false;
          score.passed = false;
        }
      }
    });
    const reversed = (run: SavedRun) =>
      changed(run, (copy) => {
        copy.cases.reverse();
        for (const item of copy.cases) {
          item.scores.reverse();
        }
      });

    const verdict = compareRuns(baseline, failing);

    expect(compareRuns(reversed(baseline), reversed(failing))).toEqual(verdict);
    expect(compareRuns(baseline, reversed(failing))).toEqual(verdict);
    expect(verdict.newly_failing.map((pair) => [pair.case_id, pair.scorer_name])).toEqual([
      [ALPHA, "exact_match"],
      [ALPHA, "not_empty"],
      [BETA, "exact_match"],
      [BETA, "not_empty"],
      [GAMMA, "exact_match"],
      [GAMMA, "not_empty"],
    ]);
  });

  it("lists a newly errored case's scorer errors by scorer name", () => {
    const baseline = recorded("python-0.5.1", "all-pass");
    const twoErrors = changed(baseline, (run) => {
      const beta = run.cases.find((item) => item.case_id === BETA) as CaseLine;
      beta.status = "errored";
      beta.scores = [];
      beta.scorer_errors = [
        { scorer_name: "not_empty", scorer_version: null, message: "second" },
        { scorer_name: "exact_match", scorer_version: null, message: "first" },
      ];
    });

    expect(compareRuns(baseline, twoErrors).newly_errored).toEqual([
      {
        case_id: BETA,
        task_error: null,
        scorer_errors: [
          { scorer_name: "exact_match", scorer_version: null, message: "first" },
          { scorer_name: "not_empty", scorer_version: null, message: "second" },
        ],
      },
    ]);
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
