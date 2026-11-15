/**
 * Reads runs the eval runners saved on this machine, and compares a new run with a baseline run:
 * whether the two can be compared at all, and if they can, which cases regressed.
 *
 * A runner saves each evaluation it runs as `<run id>.json` (the run file) and
 * `<run id>.cases.jsonl` (its case lines), side by side in `.traceroot/eval/runs`.
 *
 * A comparison that is quietly wrong is worse than none, so two runs are compared only when each
 * case id names the same row in both. Every way that can fail has its own reason, and nothing is
 * guessed past.
 */

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  type CaseLine,
  type CaseScore,
  type Payloads,
  ProtocolError,
  type RunFile,
  type ScorerError,
  parseCaseLines,
  parseRunFile,
} from "./protocol.js";

/** A saved run: its run file and one case line per case, in the order the runner wrote them. */
export interface SavedRun {
  file: RunFile;
  cases: CaseLine[];
}

/**
 * A saved run, or why it couldn't be read.
 *
 * `missing` means nothing is at the path. `invalid` means something is, but it isn't a run this
 * CLI can read: the path doesn't name a run file, the case lines beside it are gone, or either file
 * lacks a field the CLI reads. The message names the file and, for a parse error, the field.
 */
export type RunLoad =
  | { ok: true; run: SavedRun }
  | { ok: false; reason: "missing" | "invalid"; message: string };

const RUN_FILE_SUFFIX = ".json";
const CASES_FILE_SUFFIX = ".cases.jsonl";

/**
 * Reads a saved run from the path of its run file, `<run id>.json`, and the case lines saved beside
 * it as `<run id>.cases.jsonl`.
 *
 * A missing or unreadable run is a {@link RunLoad} failure, never a thrown error, so the caller
 * decides what each means: a missing baseline and a broken new run call for different exit codes.
 * Any other file system error, such as a permission error, is thrown as it is.
 */
export function loadRun(path: string): RunLoad {
  if (!path.endsWith(RUN_FILE_SUFFIX)) {
    return invalid(`${path} is not a run file: a saved run is read from its <run id>.json file`);
  }
  const runText = readIfPresent(path);
  if (runText === null) {
    return { ok: false, reason: "missing", message: `no saved run at ${path}` };
  }
  const casesPath = `${path.slice(0, -RUN_FILE_SUFFIX.length)}${CASES_FILE_SUFFIX}`;
  const casesText = readIfPresent(casesPath);
  if (casesText === null) {
    return invalid(`the saved run ${path} has no case lines: ${casesPath} is missing`);
  }

  let file: RunFile;
  try {
    file = parseRunFile(runText);
  } catch (error) {
    return parseFailure(path, error);
  }
  let cases: CaseLine[];
  try {
    cases = parseCaseLines(casesText);
  } catch (error) {
    return parseFailure(casesPath, error);
  }
  return { ok: true, run: { file, cases } };
}

function invalid(message: string): RunLoad {
  return { ok: false, reason: "invalid", message };
}

/** A {@link ProtocolError} as an `invalid` load that names the file. Anything else is rethrown. */
function parseFailure(path: string, error: unknown): RunLoad {
  if (error instanceof ProtocolError) {
    return invalid(`${path}: ${error.message}`);
  }
  throw error;
}

/** The file's text, or null when there is no file at the path. */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Which of the two compared runs a reason is about. */
export type RunSide = "baseline" | "new";

/**
 * Why a case and scorer pair that passed in the baseline run doesn't pass in the new run:
 * - `failed`: the scorer ran under the same version, and its score doesn't pass.
 * - `unjudged`: the scorer ran under the same version, and its score now neither passes nor fails,
 *   as when its threshold was removed. Removing a threshold can't hide a failure.
 * - `scorer_error`: the scorer raised. A raising scorer may be recorded without the version it
 *   declares, so this counts whatever version it records. A raising scorer is recorded under its
 *   own name, even one whose scores carry other names, such as one that gives several named scores.
 *   So a pair with no score is also blamed on any scorer error on the case named after none of the
 *   baseline's pairs.
 * - `task_error`: the task raised on the case, so no scorer ran on it.
 * - `missing`: the new run has no score for the pair, no scorer error that could be its scorer's,
 *   and no task error, as when the scorer was removed or renamed.
 */
export type FailingReason = "failed" | "unjudged" | "scorer_error" | "task_error" | "missing";

/** A case and scorer pair that passed in the baseline run, and doesn't in the new run. */
export interface NewlyFailingPair {
  case_id: string;
  scorer_name: string;
  reason: FailingReason;
  /** The new run's score when the reason is `failed` or `unjudged`, otherwise null. */
  value: unknown;
  /**
   * What raised when the reason is `scorer_error` or `task_error`, otherwise null. An error from a
   * scorer named after none of the baseline's pairs starts with that scorer's name, as in
   * `check_doc: KeyError: 'title'`, and several are joined with `; `.
   */
  error: string | null;
}

/** A case whose status is `errored` in the new run and wasn't in the baseline run. */
export interface NewlyErroredCase {
  case_id: string;
  /** What the task raised, or null when only scorers raised. */
  task_error: string | null;
  scorer_errors: ScorerError[];
}

/**
 * What changed about a pair, without making it a regression:
 * - `scorer_version`: the scorer's version changed, so its two scores may not mean the same thing.
 *   This holds whatever the scores are, failing ones included.
 * - `passed`: a score that didn't pass in the baseline changed whether it passes. From failing to
 *   passing is the usual one.
 * - `value`: a score that neither passes nor fails, such as a number from a scorer with no
 *   threshold, has a new value.
 * - `scorer_recovered`: the scorer raised in the baseline, and has a score in the new run.
 */
export type PairChange = "scorer_version" | "passed" | "value" | "scorer_recovered";

/** A score, without the scorer name its pair already gives. */
export type PairScore = Omit<CaseScore, "scorer_name">;

/** A scorer error, without the scorer name its pair already gives. */
export type PairError = Omit<ScorerError, "scorer_name">;

/** A case and scorer pair scored in both runs whose score changed in a way that isn't a regression. */
export interface ChangedScore {
  case_id: string;
  scorer_name: string;
  change: Exclude<PairChange, "scorer_recovered">;
  baseline: PairScore;
  current: PairScore;
}

/** A case and scorer pair whose scorer raised in the baseline run, and has a score in the new run. */
export interface RecoveredScorer {
  case_id: string;
  scorer_name: string;
  change: "scorer_recovered";
  /** What the scorer raised in the baseline run. */
  baseline: PairError;
  current: PairScore;
}

/** A pair whose result changed in a way that isn't a regression. `change` tells which kind. */
export type ChangedPair = ChangedScore | RecoveredScorer;

/**
 * What comparing a new run with a baseline run found.
 *
 * Every list is sorted by case id, then scorer name, and is empty when the runs can't be compared.
 */
export interface Verdict {
  /**
   * `not_comparable` when the runs can't be compared, `regressed` when a pair newly fails or a case
   * newly errors, and `ok` otherwise.
   */
  outcome: "ok" | "regressed" | "not_comparable";
  newly_failing: NewlyFailingPair[];
  newly_errored: NewlyErroredCase[];
  /** Reported, but never a regression. */
  changed: ChangedPair[];
  /** Why the two runs can't be compared, or null when they can. */
  not_comparable_reason: string | null;
  /**
   * `truncated` when either run stores truncated payloads. The check that each case id names the
   * same row in both runs then compared the stored values as they are, so two long values that
   * differ only past their stored preview pass it.
   */
  payloads: Payloads;
}

/**
 * Compares a new run with a baseline run of the same evaluation. Reads nothing but its arguments,
 * and gives the same verdict for the same runs, whatever order they list their cases and scores in.
 *
 * Two runs can be compared when all of these hold, checked in this order:
 * - they are runs of the same evaluation;
 * - each ran every case to the end ({@link partialRunReason});
 * - they record the same dataset revision;
 * - neither lists a case id twice, or a scorer name twice on one case, among the case's scores or
 *   among its scorer errors;
 * - they have the same case ids, and each case id has the same stored input and expected in both.
 *
 * The last check is needed because @traceroot-ai/traceroot records an inline dataset's revision as
 * `local-<case count>`, and both SDKs give its rows positional ids. Two inline datasets of the same
 * size then share a revision, and a case id would pair unrelated rows. A scorer name is checked
 * because two scorers can give scores of the same name, and a pair matched by that name would
 * stand for only one of them, so a failing score could hide behind a passing one.
 *
 * The new run regressed when a case and scorer pair that passed in the baseline doesn't pass now
 * ({@link FailingReason}), or a case errors now that didn't. A pair is matched by scorer name, the
 * name a raising scorer is recorded under too. A case whose task raises now counts both ways: the
 * case newly errors, and each of its pairs that passed is newly failing.
 */
export function compareRuns(baseline: SavedRun, current: SavedRun): Verdict {
  const truncated =
    baseline.file.artifact.payloads === "truncated" ||
    current.file.artifact.payloads === "truncated";
  const verdict: Verdict = {
    outcome: "ok",
    newly_failing: [],
    newly_errored: [],
    changed: [],
    not_comparable_reason: null,
    payloads: truncated ? "truncated" : "complete",
  };
  const pairs = pairCases(baseline, current);
  if (typeof pairs === "string") {
    verdict.outcome = "not_comparable";
    verdict.not_comparable_reason = pairs;
    return verdict;
  }
  for (const pair of pairs) {
    compareCase(pair, verdict);
  }
  if (verdict.newly_failing.length > 0 || verdict.newly_errored.length > 0) {
    verdict.outcome = "regressed";
  }
  return verdict;
}

/**
 * Why a run covers only part of its evaluation, or null when it ran every case to the end.
 *
 * A run of some of the cases (`sample` or `first`) and an interrupted run are partial, and no run
 * can be compared with one. The command checks a baseline with this before it starts the runner, so
 * a partial baseline doesn't cost a full run.
 */
export function partialRunReason(file: RunFile, side: RunSide): string | null {
  const run = `the ${side} run`;
  if (file.run_mode === "sample") {
    return `${run} is sampled (run_mode "sample"), so it ran only some of its cases`;
  }
  if (file.run_mode === "first") {
    return `${run} ran only its first cases (run_mode "first")`;
  }
  if (file.status === "incomplete") {
    return `${run} was interrupted before it finished (status "incomplete")`;
  }
  if (!file.is_final) {
    return `${run} isn't final (is_final is false)`;
  }
  return null;
}

/** A case of the baseline run and the case with the same id in the new run. */
interface CasePair {
  baseline: CaseLine;
  current: CaseLine;
}

/**
 * Pairs each case of the baseline run with the case that has the same id in the new run, sorted
 * by case id. When the runs can't be compared, returns why instead: the first reason found, from
 * the broadest (another evaluation) to the narrowest (another row).
 */
function pairCases(baseline: SavedRun, current: SavedRun): CasePair[] | string {
  const runReason = runFilesReason(baseline.file, current.file);
  if (runReason !== null) {
    return runReason;
  }
  const baselineCases = indexCases(baseline.cases, "baseline");
  if (typeof baselineCases === "string") {
    return baselineCases;
  }
  const currentCases = indexCases(current.cases, "new");
  if (typeof currentCases === "string") {
    return currentCases;
  }
  const repeated =
    repeatedNameReason(baseline.cases, "baseline") ?? repeatedNameReason(current.cases, "new");
  if (repeated !== null) {
    return repeated;
  }

  const onlyBaseline = [...baselineCases.keys()].filter((id) => !currentCases.has(id));
  const onlyNew = [...currentCases.keys()].filter((id) => !baselineCases.has(id));
  if (onlyBaseline.length > 0 || onlyNew.length > 0) {
    return differentCasesReason(onlyBaseline, onlyNew);
  }
  const pairs = [...baseline.cases]
    .sort((a, b) => byCodeUnit(a.case_id, b.case_id))
    .flatMap((item) => {
      const match = currentCases.get(item.case_id);
      return match === undefined ? [] : [{ baseline: item, current: match }];
    });
  return differentRowsReason(pairs, baseline.file, current.file) ?? pairs;
}

/** Why the run files alone rule out a comparison, or null when they don't. */
function runFilesReason(baseline: RunFile, current: RunFile): string | null {
  if (baseline.evaluation_name !== current.evaluation_name) {
    return `the runs are of different evaluations: ${quote(baseline.evaluation_name)} in the baseline run and ${quote(current.evaluation_name)} in the new run`;
  }
  const partial = partialRunReason(baseline, "baseline") ?? partialRunReason(current, "new");
  if (partial !== null) {
    return partial;
  }
  const before = baseline.dataset?.revision ?? null;
  const after = current.dataset?.revision ?? null;
  if (before === null) {
    return "the baseline run records no dataset revision";
  }
  if (after === null) {
    return "the new run records no dataset revision";
  }
  if (before !== after) {
    return `the runs used different datasets: revision ${quote(before)} in the baseline run and ${quote(after)} in the new run`;
  }
  return null;
}

/** A run's cases by id, or why its cases can't be paired by id. */
function indexCases(cases: CaseLine[], side: RunSide): Map<string, CaseLine> | string {
  const index = new Map<string, CaseLine>();
  for (const item of cases) {
    if (index.has(item.case_id)) {
      return `the ${side} run has more than one case with id ${quote(item.case_id)}, so its cases can't be paired by id`;
    }
    index.set(item.case_id, item);
  }
  return index;
}

/**
 * Why a run's scores can't be paired by scorer name, or null when they can: a case, taken in case
 * id order, lists one name twice among its scores, or among its scorer errors.
 */
function repeatedNameReason(cases: CaseLine[], side: RunSide): string | null {
  for (const item of [...cases].sort((a, b) => byCodeUnit(a.case_id, b.case_id))) {
    const score = repeatedName(item.scores);
    if (score !== null) {
      return `the ${side} run has more than one score named ${quote(score)} on case ${quote(item.case_id)}, so its scores can't be paired by scorer`;
    }
    const error = repeatedName(item.scorer_errors);
    if (error !== null) {
      return `the ${side} run has more than one scorer error named ${quote(error)} on case ${quote(item.case_id)}, so its scorer errors can't be paired by scorer`;
    }
  }
  return null;
}

/** The first, in name order, of the scorer names listed more than once, or null when none is. */
function repeatedName(items: { scorer_name: string }[]): string | null {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const { scorer_name: name } of items) {
    if (seen.has(name)) {
      repeated.push(name);
    }
    seen.add(name);
  }
  return repeated.sort(byCodeUnit)[0] ?? null;
}

/** Names the case ids that only one run has. */
function differentCasesReason(onlyBaseline: string[], onlyNew: string[]): string {
  const sides = [
    onlyBaseline.length > 0 ? `${someIds(onlyBaseline)} only in the baseline run` : null,
    onlyNew.length > 0 ? `${someIds(onlyNew)} only in the new run` : null,
  ];
  return `the runs have different cases: ${sides.filter((side) => side !== null).join(", and ")}`;
}

/**
 * Names the first case, by id, whose stored input or expected differs between the runs, and how
 * many others differ. Null when every case id names the same row in both runs.
 */
function differentRowsReason(
  pairs: CasePair[],
  baseline: RunFile,
  current: RunFile,
): string | null {
  const differing = pairs.flatMap((pair) => {
    const fields = rowDifference(pair.baseline, pair.current);
    return fields === null ? [] : [{ id: pair.baseline.case_id, fields }];
  });
  const [first] = differing;
  if (first === undefined) {
    return null;
  }
  const others = differing.length - 1;
  let reason = `case ${quote(first.id)} has a different stored ${first.fields} in the two runs`;
  if (others === 1) {
    reason += ", as does 1 other case";
  } else if (others > 1) {
    reason += `, as do ${others} other cases`;
  }
  const note = truncationNote(baseline, current);
  return note === null ? reason : `${reason} (${note})`;
}

/** Which stored fields of a case differ between the runs, or null when neither does. */
function rowDifference(baseline: CaseLine, current: CaseLine): string | null {
  const input = !isDeepStrictEqual(baseline.input, current.input);
  const expected = !isDeepStrictEqual(baseline.expected, current.expected);
  if (input && expected) {
    return "input and expected";
  }
  if (input) {
    return "input";
  }
  return expected ? "expected" : null;
}

/** Says which runs store truncated payloads, or null when neither does. */
function truncationNote(baseline: RunFile, current: RunFile): string | null {
  const before = baseline.artifact.payloads === "truncated";
  const after = current.artifact.payloads === "truncated";
  const note = "truncated payloads, so the stored, truncated values were compared";
  if (before && after) {
    return `both runs store ${note}`;
  }
  if (before) {
    return `the baseline run stores ${note}`;
  }
  if (after) {
    return `the new run stores ${note}`;
  }
  return null;
}

/** How many ids there are, and the first three of them in order. */
function someIds(ids: string[]): string {
  const sorted = [...ids].sort(byCodeUnit);
  const shown = sorted.slice(0, 3).map(quote).join(", ");
  const more = sorted.length > 3 ? ` and ${sorted.length - 3} more` : "";
  return `${sorted.length} (${shown}${more})`;
}

/**
 * Adds what regressed or changed on one case to the verdict. The scorers the baseline scored or
 * saw raise are taken in name order, so the verdict's lists stay sorted.
 */
function compareCase({ baseline, current }: CasePair, verdict: Verdict): void {
  if (current.status === "errored" && baseline.status !== "errored") {
    verdict.newly_errored.push({
      case_id: current.case_id,
      task_error: current.task_error,
      scorer_errors: [...current.scorer_errors].sort(byScorerName),
    });
  }
  const oldScores = byScorer(baseline.scores);
  const oldErrors = byScorer(baseline.scorer_errors);
  const scores = byScorer(current.scores);
  const errors = byScorer(current.scorer_errors);
  const names = new Set([...oldScores.keys(), ...oldErrors.keys()]);
  const unmatched = unmatchedErrors(current.scorer_errors, names);
  for (const name of [...names].sort(byCodeUnit)) {
    const pair = { case_id: baseline.case_id, scorer_name: name };
    const old = oldScores.get(name);
    const now = scores.get(name);
    if (old === undefined) {
      // The scorer raised in the baseline, which never counts as passing.
      const raised = oldErrors.get(name);
      if (raised !== undefined && now !== undefined) {
        verdict.changed.push({
          ...pair,
          change: "scorer_recovered",
          baseline: { scorer_version: raised.scorer_version, message: raised.message },
          current: pairScore(now),
        });
      }
      continue;
    }
    if (now === undefined) {
      if (old.passed === true) {
        verdict.newly_failing.push({ ...pair, ...unscored(current, errors.get(name), unmatched) });
      }
      continue;
    }
    const change = scoreChange(old, now);
    if (change === "failed" || change === "unjudged") {
      verdict.newly_failing.push({ ...pair, reason: change, value: now.value, error: null });
    } else if (change !== null) {
      verdict.changed.push({ ...pair, change, baseline: pairScore(old), current: pairScore(now) });
    }
  }
}

/**
 * The case's scorer errors named after none of the baseline's pairs, each after its scorer's name
 * and in name order, or null when there are none. Such a scorer gives its scores under other names,
 * so any of them may be the scorer behind a pair that has no score now.
 */
function unmatchedErrors(errors: ScorerError[], names: Set<string>): string | null {
  const unmatched = errors.filter((error) => !names.has(error.scorer_name)).sort(byScorerName);
  if (unmatched.length === 0) {
    return null;
  }
  return unmatched.map((error) => `${error.scorer_name}: ${error.message}`).join("; ");
}

/**
 * Why a pair that passed in the baseline has no score in the new run: its scorer's error, the
 * task's error, or else the case's {@link unmatchedErrors}. `missing` only when none of them is
 * there.
 */
function unscored(
  current: CaseLine,
  error: ScorerError | undefined,
  unmatched: string | null,
): Pick<NewlyFailingPair, "reason" | "value" | "error"> {
  if (error !== undefined) {
    return { reason: "scorer_error", value: null, error: error.message };
  }
  if (current.task_error !== null) {
    return { reason: "task_error", value: null, error: current.task_error };
  }
  if (unmatched !== null) {
    return { reason: "scorer_error", value: null, error: unmatched };
  }
  return { reason: "missing", value: null, error: null };
}

/**
 * How a pair's score changed between the runs. Under the same scorer version, a score that passed
 * and now fails is `failed`, and one that now neither passes nor fails is `unjudged`. Anything else
 * is a change that isn't a regression, or null when nothing worth reporting changed.
 */
function scoreChange(
  old: CaseScore,
  now: CaseScore,
): "failed" | "unjudged" | ChangedScore["change"] | null {
  if (old.scorer_version !== now.scorer_version) {
    return "scorer_version";
  }
  if (old.passed === true && now.passed !== true) {
    return now.passed === false ? "failed" : "unjudged";
  }
  if (old.passed !== now.passed) {
    return "passed";
  }
  return now.passed === null && !isDeepStrictEqual(old.value, now.value) ? "value" : null;
}

function pairScore(score: CaseScore): PairScore {
  return { scorer_version: score.scorer_version, value: score.value, passed: score.passed };
}

/**
 * A case's scores or scorer errors by scorer name. Runs that list a name twice on a case are never
 * compared ({@link repeatedNameReason}), so each name is listed once.
 */
function byScorer<T extends { scorer_name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.scorer_name, item]));
}

/**
 * Text from a run, quoted, with any control character escaped, so a reason that quotes it can't
 * repaint a terminal.
 */
function quote(text: string): string {
  return JSON.stringify(text);
}

/**
 * Compares by code unit. Not `localeCompare`: collation follows the runtime's locale data, and the
 * order has to be the same on every machine.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byScorerName(a: { scorer_name: string }, b: { scorer_name: string }): number {
  return byCodeUnit(a.scorer_name, b.scorer_name);
}
