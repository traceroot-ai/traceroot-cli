/**
 * Reads runs the eval runners saved on this machine.
 *
 * A runner saves each evaluation it runs as `<run id>.json` (the run file) and
 * `<run id>.cases.jsonl` (its case lines), side by side in `.traceroot/eval/runs`.
 */

import { readFileSync } from "node:fs";
import {
  type CaseLine,
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
