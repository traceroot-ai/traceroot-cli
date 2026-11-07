import type { Sink } from "../output.js";
import { cliCommand, setupCommand } from "./invocation.js";
import { wizardAside, wizardEmphasis, wizardLink } from "./wizard.js";

/**
 * The first of the two blocks that close a run that received a trace.
 *
 * A wizard's last screen is the one a user acts on, so it is not spent on a
 * single sentence printed *outside* the frame — "TraceRoot is connected, your
 * application's checks were not run, and your first trace is available here: …"
 * — a claim, a caveat and a URL crammed into one line that visibly does not
 * belong to the box the CLI has just drawn.
 *
 * Instead: two settled blocks, and then the frame closes. This block is the
 * local half — the trace this run received — and `productionNotice` is the
 * half about everywhere else.
 *
 * Neither waits for a keypress. The trace is the confirmation an
 * acknowledgement would ask for, and a closing "I have added the key to
 * production" recorded the same claim whatever the user typed.
 *
 * Only a run that saw a trace prints it, so it says nothing about producing
 * one. Telling the user to run their application, that traces "will appear",
 * or where to look if they do not, would be about a state the run is past: the
 * trace linked here is the evidence that the application sends traces. The
 * runs that end without one close on blocks of their own — see
 * {@link skippedTraceNotice} and the hand-over sentence in
 * `commands/setup/run.ts` — and those say what is still to do.
 *
 * The trace URL is the backend's own permalink for the trace this run actually
 * saw, never a constructed one: a self-hosted deployment's UI does not live
 * where the API does, and guessing produces a link that 404s at the exact
 * moment the user first clicks anything.
 */

export interface TracesNoticeInput {
  /** The backend's permalink for the first trace this run received. */
  traceUrl: string;
  /**
   * False when the project already had traces before setup started, so this
   * one may come from another sender; see `TraceVerification.attributed`.
   * Absent or true reads as the ordinary case.
   */
  attributed?: boolean;
}

/**
 * The block, as lines. Pure, so the wording is assertable without a terminal.
 *
 * A label and the link, each on a line of its own so the link survives being
 * copied. The label is "Your first trace" unless the run could not tell the
 * trace was this service's: the stage has already warned about that, and a
 * label claiming the trace as the user's would contradict the warning.
 *
 * `sink` is where the block is headed, because the bold label and the
 * permalink are painted here rather than by whatever prints them: the colour
 * has to answer to the stream the lines land on, not to `process.stderr` on
 * the way past. Defaults to it for a caller that is only reading the wording.
 */
export function tracesNotice(input: TracesNoticeInput, sink: Sink = process.stderr): string[] {
  const label =
    input.attributed === false ? "First trace since setup started:" : "Your first trace:";
  return [wizardEmphasis(label, sink), wizardLink(input.traceUrl, undefined, sink)];
}

export interface SkippedTraceNoticeInput {
  /**
   * The TraceRoot UI this session belongs to, when the run got far enough to
   * learn it. Null falls back to the terminal, which needs no URL at all.
   */
  uiBaseUrl: string | null;
}

/**
 * The block that closes a run whose trace wait the user ended themselves.
 *
 * Not {@link tracesNotice} with a caveat bolted on. That block's whole subject
 * is a trace this run saw, and its permalink is the thing it exists to hand
 * over — there is no permalink here, and inventing a "where it would have
 * been" link produces a URL that 404s at the exact moment a user first clicks
 * anything.
 *
 * What this block has to get right is that nothing is outstanding. The run that
 * reaches here instrumented the service and verified it; the only unobserved
 * fact is a trace arriving, and the user already said they would watch for it
 * somewhere else. So the first line says what is true rather than what is
 * missing, and the rest is the two places it will show up. No instruction to
 * "finish" anything, because there is nothing left to finish.
 */
export function skippedTraceNotice(
  input: SkippedTraceNoticeInput,
  sink: Sink = process.stderr,
): string[] {
  const where =
    input.uiBaseUrl === null
      ? []
      : ["", "It will appear here:", wizardLink(input.uiBaseUrl, undefined, sink)];
  return [
    wizardEmphasis("Setup is done — your first trace just has not been seen yet.", sink),
    ...where,
    "",
    // The terminal as well as the browser, because this is a user who has
    // demonstrably chosen not to sit and watch: the command is something they
    // can run later, from where they already are.
    wizardAside("Or from the terminal, once your application has run:", sink),
    wizardAside(`  ${cliCommand("traces list --limit 5")}`, sink),
    "",
    wizardAside("To have setup wait for it again:", sink),
    wizardAside(`  ${setupCommand()} --resume`, sink),
  ];
}
