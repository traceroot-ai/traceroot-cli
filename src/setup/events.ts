import { S_BAR, S_STEP_ERROR, S_STEP_SUBMIT } from "@clack/prompts";
import color from "picocolors";
import { type Writers, writeJson } from "../output.js";
import type { SetupErrorCode } from "./errors.js";
import type { SetupStage, SetupStageStatus } from "./types.js";

/**
 * `--json` mode emits one compact line per stage transition plus a final
 * `result` line, rather than a single opaque blob at the end. A long-running
 * onboarding flow that only reports at the end is unusable for automation: the
 * caller cannot tell whether it is waiting on a browser, an agent, or a trace.
 *
 * Every payload is non-secret by construction — the emitters only ever receive
 * ids, hints and counts.
 */
export type SetupEvent =
  | { event: "stage"; stage: SetupStage; status: "start" }
  | {
      event: "stage";
      stage: SetupStage;
      status: SetupStageStatus;
      durationMs: number;
      data?: Record<string, unknown>;
    }
  | {
      event: "result";
      ok: boolean;
      data: Record<string, unknown>;
      error?: { stage: SetupStage; code: SetupErrorCode; message: string };
    };

/** Sink for stage events. */
export type SetupEmitter = (event: SetupEvent) => void;

/** JSON mode: one compact line per event on stdout. */
export function jsonEmitter(writers: Writers): SetupEmitter {
  return (event) => writeJson(event, writers);
}

/**
 * The twelve stages, named for a person rather than for the state machine.
 *
 * A stage that heads a section is announced as it begins, above the prose and
 * the prompts that belong to it. Not every stage does — see {@link UNANNOUNCED}
 * — but every one still needs a name, because a run that stops names the step
 * it stopped on and `--json` carries the label for a stage nobody watched.
 * Deliberately not printed as a plan up front: see {@link stageLineEmitter}.
 */
export const STAGE_LABELS: Record<SetupStage, string> = {
  precheck: "Check the repository",
  authenticate: "Sign in to TraceRoot",
  select_context: "Choose the project",
  acquire_project_key: "Get an API key",
  configure_repository: "Write the credentials",
  detect_stack: "Work out what to instrument",
  // Named for the decision rather than for the state machine's field. This
  // stage settles how the SDK gets added *and* which agent that implies, in
  // one question; "Choose a coding agent" described only the half of it that
  // most runs never see.
  select_agent: "Choose how to instrument",
  install_agent_context: "Install the TraceRoot skill",
  instrument: "Instrument the application",
  verify_application: "Run your checks",
  verify_trace: "Wait for the first trace",
  complete: "Finish",
};

/**
 * Stages that print their own heading, so the generic one is suppressed.
 *
 * `authenticate` has four ways in — a credential already configured, a saved
 * CLI token, the browser handoff, a pasted key — and each of them opens with a
 * sentence that says which one is happening and what the user has to do about
 * it. "Sign in to TraceRoot" above any of those is the restatement this
 * renderer exists to remove, and above the browser block it was worse than
 * redundant: two headings, one directly under the other, for a single section.
 *
 * Only the *start* line is suppressed. A stage satisfied before it ran still
 * reports itself, because nothing else would have mentioned it at all.
 */
const SELF_ANNOUNCING: ReadonlySet<SetupStage> = new Set(["authenticate"]);

/**
 * Stages that are not sections at all, and print no line of their own.
 *
 * A heading is a promise that something worth attending to is about to happen
 * under it. These five never kept it:
 *
 * `install_agent_context` copies a directory. It is bookkeeping — nothing is
 * decided, nothing can be answered — and it was drawn with the same weight as
 * signing in.
 *
 * `instrument` is the second half of a question already asked. "Choose how to
 * instrument" heads the method prompt; the confirmation gate and the agent's
 * own block belong under that same heading, and "Instrument the application"
 * between them split one decision across two sections.
 *
 * `verify_application`, `verify_trace` and `complete` are the run's tail, and by
 * then the user's attention is on the closing blocks. They are unattended work
 * announcing itself to somebody who has already been told what to do next; the
 * trace permalink, the one thing from any of them a user actually needs, is
 * reported by the closing blocks rather than here.
 *
 * A failure still prints. Silence is for work going to plan — a run that broke
 * has to say where, and that is the one line worth a section of its own.
 */
const UNANNOUNCED: ReadonlySet<SetupStage> = new Set([
  // Reading the worktree is not a step anyone asked for. It speaks up on its
  // own when it finds uncommitted changes, and has nothing to say otherwise.
  "precheck",
  // Everything below announces a step whose own prompt already announces it,
  // or whose work is bookkeeping the user never asked to watch. A heading that
  // says "Choose a project" directly above a question asking which project is
  // the same sentence twice, and the run reads as twice as long as it is.
  "select_context",
  "acquire_project_key",
  "configure_repository",
  "detect_stack",
  "select_agent",
  "install_agent_context",
  "instrument",
  "verify_application",
  "verify_trace",
  "complete",
]);

/**
 * Human mode: one line per stage, printed at the moment the stage begins.
 *
 * Strictly linear and append-only. Nothing redraws, nothing is restated, and a
 * step's line arrives *before* the work it names rather than after it — so the
 * prose a stage prints, and any question it asks, sit underneath the heading
 * they belong to.
 *
 * Not a persistent checklist that redraws in place. Such a list works when
 * everything after the login is unattended; this run is prompt-heavy —
 * uncommitted changes, language, method, agent launch — and a prompt needs the
 * terminal to itself, so the list could only ever appear once the questions
 * were over. By then it would be announcing steps the user had already watched
 * happen, in a narrative the prompts had already given.
 *
 * A stage that was already satisfied never starts, so it is the one case that
 * reports on settling: silence there would leave a step of the run invisible.
 */
export function stageLineEmitter(writers: Writers): SetupEmitter {
  const rail = color.dim(S_BAR);
  const started = new Set<SetupStage>();

  return (event) => {
    if (event.event !== "stage") {
      return;
    }
    const label = STAGE_LABELS[event.stage];

    if (event.status === "start") {
      started.add(event.stage);
      if (!SELF_ANNOUNCING.has(event.stage) && !UNANNOUNCED.has(event.stage)) {
        writers.err.write(`${rail}\n${color.cyan(S_STEP_SUBMIT)}  ${label}\n`);
      }
      return;
    }

    // Nothing to report about a step that is not a section, whether it ran or
    // was already done. "Install the TraceRoot skill — already done" is the
    // heading this set exists to remove, wearing a different hat.
    if (UNANNOUNCED.has(event.stage) && event.status !== "failed") {
      return;
    }

    if (!started.has(event.stage)) {
      // Satisfied before it ran — nothing followed it, so this line is the
      // whole of what there is to say about the step.
      writers.err.write(
        `${rail}\n${color.dim(S_STEP_SUBMIT)}  ${color.dim(`${label} — already done`)}\n`,
      );
      return;
    }

    // The stage announced itself and then spoke for itself. Repeating the label
    // now would be the restatement this renderer exists to remove — except on a
    // failure, where marking the point the run broke is worth one line.
    if (event.status === "failed") {
      writers.err.write(`${color.red(S_STEP_ERROR)}  ${label}\n`);
    }
  };
}
