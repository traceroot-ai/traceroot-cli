/**
 * Reads runs the eval runners saved on this machine, and decides whether a new run can be compared
 * with a baseline run.
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
  type Payloads,
  ProtocolError,
  type RunFile,
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

/** What comparing a new run with a baseline run found. */
export interface Verdict {
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
 * Compares a new run with a baseline run of the same evaluation. Reads nothing but its arguments.
 *
 * Two runs can be compared when all of these hold, checked in this order:
 * - they are runs of the same evaluation;
 * - each ran every case to the end ({@link partialRunReason});
 * - they record the same dataset revision;
 * - they have the same case ids, and each case id has the same stored input and expected in both.
 *
 * The last check is needed because @traceroot-ai/traceroot records an inline dataset's revision as
 * `local-<case count>`, and both SDKs give its rows positional ids. Two inline datasets of the same
 * size then share a revision, and a case id would pair unrelated rows.
 */
export function compareRuns(baseline: SavedRun, current: SavedRun): Verdict {
  const truncated =
    baseline.file.artifact.payloads === "truncated" ||
    current.file.artifact.payloads === "truncated";
  const pairs = pairCases(baseline, current);
  return {
    not_comparable_reason: typeof pairs === "string" ? pairs : null,
    payloads: truncated ? "truncated" : "complete",
  };
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
  const reason = `case ${quote(first.id)} has a different stored ${first.fields} in the two runs${
    others === 0 ? "" : others === 1 ? ", as does 1 other case" : `, as do ${others} other cases`
  }`;
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
  if (!before && !after) {
    return null;
  }
  const which =
    before && after ? "both runs store" : before ? "the baseline run stores" : "the new run stores";
  return `${which} truncated payloads, so the stored, truncated values were compared`;
}

/** How many ids there are, and the first three of them in order. */
function someIds(ids: string[]): string {
  const sorted = [...ids].sort(byCodeUnit);
  const shown = sorted.slice(0, 3).map(quote).join(", ");
  const more = sorted.length > 3 ? ` and ${sorted.length - 3} more` : "";
  return `${sorted.length} (${shown}${more})`;
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
