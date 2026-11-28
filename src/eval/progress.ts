/**
 * What a running evaluation file has done so far, as the progress line says it.
 *
 * It is read from the events the runner writes as it works: `evaluation_started` names the
 * evaluation and, in `dataset.case_count`, says how many cases it runs, and `case_started` and
 * `case_completed` mark each case. Every field is optional here. A runner that leaves one out, or
 * writes a line that can't be read, costs that part of the line and nothing else: what the run came
 * to is read from the whole event file once the runner has exited.
 *
 * The line says only what the events say. There is no estimate of the time left and no percentage
 * of work the events don't count, and once an evaluation has finished, the line says that and that
 * the runner is still working, which is all its events say until the next one.
 */

import { clean } from "../registry/enhancers/eval-reads.js";
import type { StackLanguage } from "../setup/types.js";
import { eventObject } from "./protocol.js";

/** An event the progress line reads, with only the fields it shows. */
export type ProgressEvent =
  | { type: "evaluation_started"; name: string | null; caseCount: number | null }
  | { type: "case_started" }
  | { type: "case_completed"; errored: boolean }
  | { type: "evaluation_completed"; name: string | null }
  | { type: "suite_completed" };

/**
 * One event line as the progress line reads it, or null for a line it doesn't show or can't read.
 * A field that is missing or of the wrong type reads as unknown.
 */
export function readProgressEvent(line: string): ProgressEvent | null {
  const raw = eventObject(line);
  if (raw === null) {
    return null;
  }
  switch (raw.type) {
    case "evaluation_started": {
      const dataset = isRecord(raw.dataset) ? raw.dataset : {};
      return { type: raw.type, name: nameOf(raw.name), caseCount: countOf(dataset.case_count) };
    }
    case "case_started":
    case "suite_completed":
      return { type: raw.type };
    case "case_completed":
      return { type: raw.type, errored: erroredCase(raw) };
    case "evaluation_completed":
      return { type: raw.type, name: nameOf(raw.name) };
    default:
      return null;
  }
}

/**
 * Whether a runner's `dataset.case_count` is the number of cases it goes on to run.
 *
 * traceroot counts the cases left once both the evaluation's `select` and the run's sampling are
 * applied, in every release `evals run` supports. @traceroot-ai/traceroot counts them before the
 * evaluation's `select`, through 0.8.1 at least: an evaluation whose `select` keeps two of its five
 * cases starts with a count of 5 and ends after 2. Its count is left out, so the line never shows a
 * total the run won't reach.
 */
export function countsCasesItRuns(language: StackLanguage): boolean {
  return language === "python";
}

/** Where the runner is: before its first evaluation, in one, past one, or past its last. */
export type ProgressPhase = "starting" | "running" | "finished" | "done";

export interface RunProgress {
  phase: ProgressPhase;
  /** The current, or last, evaluation's name as the runner wrote it, when it gave one. */
  name: string | null;
  /** How many cases the current evaluation runs, or null when that isn't known. */
  total: number | null;
  /** Cases of the current evaluation that started. */
  started: number;
  /** Cases of the current evaluation that finished, with or without an error. */
  completed: number;
  /** Finished cases whose task or a scorer raised. */
  errored: number;
  /** True once the run was interrupted and the runner is stopping. */
  stopping: boolean;
}

/** The progress of a runner that has written nothing yet. */
export function startingProgress(): RunProgress {
  return {
    phase: "starting",
    name: null,
    total: null,
    started: 0,
    completed: 0,
    errored: 0,
    stopping: false,
  };
}

/**
 * The progress after one more event.
 *
 * Each `evaluation_started` starts the counts again, so a file with several evaluations shows one
 * at a time. Its case count becomes the total only when `exactCount` says the runner counts the
 * cases it runs (see {@link countsCasesItRuns}), and it stops being the total as soon as more cases
 * than that start: past that point it is plainly wrong.
 */
export function advance(
  progress: RunProgress,
  event: ProgressEvent,
  exactCount: boolean,
): RunProgress {
  switch (event.type) {
    case "evaluation_started":
      return {
        ...startingProgress(),
        phase: "running",
        name: event.name,
        total: exactCount ? event.caseCount : null,
        stopping: progress.stopping,
      };
    case "case_started":
      return withinTotal({ ...progress, phase: "running", started: progress.started + 1 });
    case "case_completed":
      return withinTotal({
        ...progress,
        phase: "running",
        completed: progress.completed + 1,
        errored: progress.errored + (event.errored ? 1 : 0),
      });
    case "evaluation_completed":
      return { ...progress, phase: "finished", name: event.name ?? progress.name };
    case "suite_completed":
      return { ...progress, phase: "done" };
  }
}

/** The progress with its total dropped once the counted cases go past it. */
function withinTotal(progress: RunProgress): RunProgress {
  const counted = Math.max(progress.started, progress.completed);
  return progress.total !== null && counted > progress.total
    ? { ...progress, total: null }
    : progress;
}

/** The progress line's text, in two parts so a long name can be shortened on its own. */
export interface ProgressText {
  /** The evaluation's name, escaped for the terminal, or null when the line names none. */
  subject: string | null;
  /** The rest of the line, after the name. */
  detail: string;
}

/** What the progress line says, without its spinner and elapsed time. */
export function describeProgress(progress: RunProgress): ProgressText {
  const subject = progress.name === null ? null : clean(progress.name);
  switch (progress.phase) {
    case "starting":
      return {
        subject: null,
        detail: progress.stopping
          ? "Stopping the run"
          : "Waiting for the runner to start an evaluation",
      };
    case "running":
      return { subject, detail: caseCounts(progress) };
    case "finished":
      return {
        subject,
        detail: progress.stopping
          ? "finished · stopping"
          : "finished · the runner is still working",
      };
    case "done":
      return { subject: null, detail: "Waiting for the runner to exit" };
  }
}

/**
 * The case counts: how many finished, out of the total when it is known, how many are running now,
 * and how many errored. Once the run is stopping, the cases in flight may never finish, so the line
 * says it is stopping instead of how many run.
 */
function caseCounts(progress: RunProgress): string {
  const { total, completed } = progress;
  const done =
    total === null
      ? `${completed} ${cases(completed)} done`
      : `${completed}/${total} ${cases(total)} done`;
  const running = Math.max(0, progress.started - completed);
  const errored = `${progress.errored} errored`;
  return progress.stopping
    ? `${done} · ${errored} · stopping`
    : `${done} · ${running} running · ${errored}`;
}

function cases(count: number): string {
  return count === 1 ? "case" : "cases";
}

/** A name the runner wrote, or null for a missing or empty one. */
function nameOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A count the runner wrote, or null for anything but a whole number of zero or more. */
function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Whether a finished case errored: its status says so, or it carries the task's error or a
 * scorer's. An errored case still counts as finished.
 */
function erroredCase(raw: Record<string, unknown>): boolean {
  return (
    raw.status === "errored" ||
    (typeof raw.task_error === "string" && raw.task_error !== "") ||
    (Array.isArray(raw.scorer_errors) && raw.scorer_errors.length > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
