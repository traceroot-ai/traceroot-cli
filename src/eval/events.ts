/**
 * Reduces what an eval runner left behind to one outcome.
 *
 * The runner's exit status can't say whether a run worked. Both SDK runners exit 0 after a file
 * that fails to import, a failure of the harness itself, and a file with no evaluation, and report
 * each only as an event. So the outcome is read from the event stream, and the exit status and the
 * signals the CLI received cover what a stream that stopped early can't say.
 */

import {
  type EvaluationCompletedEvent,
  ProtocolError,
  type RunnerEvent,
  parseEvents,
} from "./protocol.js";

/** The status a runner exits with once it has handled SIGINT, and a shell's status for SIGINT. */
const INTERRUPTED_STATUS = 130;

/** The `kind` of a `fatal` event that reports an interrupt rather than a failure. */
const CANCELLED_KIND = "cancelled";

/** The `kind` of the `fatal` outcome for an event stream the CLI can't read. */
export const PROTOCOL_ERROR_KIND = "protocol_error";

/** A signal that cancels the run when the CLI receives it while the runner is running. */
export type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** How the runner process ended, as the CLI saw it. */
export interface RunnerExit {
  /** The runner's exit status, or 128 + n when signal n ended it. */
  status: number;
  /** The first interrupting signal the CLI received while the runner was running, if any. */
  signal: InterruptSignal | null;
  /** The last lines the runner wrote, its stdout and stderr together. */
  outputTail: string[];
}

/**
 * What one run of the runner came to.
 *
 * - `interrupted`: the run was cancelled. `signal` is the signal the CLI received, or null when
 *   only the runner's events or its exit status said so. `evaluations` has the
 *   `evaluation_completed` events the runner wrote before it stopped, an evaluation it saved as
 *   `incomplete` included.
 * - `fatal`: the runner reported a failure of its own, such as a file that fails to import. The
 *   CLI reports an event stream it can't read the same way, with `kind` {@link PROTOCOL_ERROR_KIND}.
 * - `crashed`: the runner stopped before it finished its stream, or exited with a non-zero status.
 * - `no_evaluations`: the runner found no evaluation in the file.
 * - `completed`: every evaluation ran, and `evaluations` has each one's `evaluation_completed`
 *   event, in the order they ran.
 */
export type RunOutcome =
  | {
      outcome: "interrupted";
      signal: InterruptSignal | null;
      evaluations: EvaluationCompletedEvent[];
    }
  | { outcome: "fatal"; kind: string; message: string }
  | { outcome: "crashed"; exitStatus: number; outputTail: string[] }
  | { outcome: "no_evaluations" }
  | { outcome: "completed"; evaluations: EvaluationCompletedEvent[] };

/**
 * Reduces a runner's event stream and exit to one outcome. The first rule that matches wins:
 *
 * 1. `interrupted` when the CLI received SIGINT, SIGTERM or SIGHUP, the runner exited 130, the suite
 *    ended cancelled, an evaluation ended `incomplete`, or a `fatal` event has kind `cancelled`. A
 *    runner stops early on an interrupt, so this has to come before the rules that read an early
 *    stop as a failure. traceroot drops the case in flight and @traceroot-ai/traceroot finishes it,
 *    but both end the stream the same way.
 * 2. `fatal` for any other `fatal` event, or for a stream the CLI can't read, including one from a
 *    runner that speaks another `eval_api_version`.
 * 3. `crashed` when the stream has no `suite_completed`, or the runner exited non-zero.
 * 4. `no_evaluations` when the suite ran no evaluation.
 * 5. `completed` otherwise.
 *
 * @param eventText the event file as the runner left it; empty when it wrote none.
 */
export function outcomeOf(eventText: string, exit: RunnerExit): RunOutcome {
  // A stream the CLI can't read is reported under rule 2, so an interrupt still wins over it.
  let events: RunnerEvent[] = [];
  let unreadable: ProtocolError | null = null;
  try {
    events = parseEvents(eventText);
  } catch (error) {
    if (!(error instanceof ProtocolError)) {
      throw error;
    }
    unreadable = error;
  }

  const [suite] = ofType(events, "suite_completed");
  const evaluations = ofType(events, "evaluation_completed");
  const fatals = ofType(events, "fatal");

  if (
    exit.signal !== null ||
    exit.status === INTERRUPTED_STATUS ||
    suite?.cancelled === true ||
    evaluations.some((evaluation) => evaluation.status === "incomplete") ||
    fatals.some((fatal) => fatal.kind === CANCELLED_KIND)
  ) {
    return { outcome: "interrupted", signal: exit.signal, evaluations };
  }
  if (unreadable !== null) {
    return { outcome: "fatal", kind: PROTOCOL_ERROR_KIND, message: unreadable.message };
  }
  const [fatal] = fatals;
  if (fatal !== undefined) {
    return { outcome: "fatal", kind: fatal.kind, message: fatal.message };
  }
  if (suite === undefined || exit.status !== 0) {
    return { outcome: "crashed", exitStatus: exit.status, outputTail: exit.outputTail };
  }
  if (suite.evaluations === 0) {
    return { outcome: "no_evaluations" };
  }
  return { outcome: "completed", evaluations };
}

function ofType<T extends RunnerEvent["type"]>(
  events: RunnerEvent[],
  type: T,
): Extract<RunnerEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunnerEvent, { type: T }> => event.type === type);
}
