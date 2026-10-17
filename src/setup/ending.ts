import type { Sink, Writers } from "../output.js";
import type { Prompt } from "../prompt.js";
import {
  DOCS_URL,
  wizardAcknowledgement,
  wizardAside,
  wizardEmphasis,
  wizardLink,
  wizardMutedLink,
  wizardNote,
} from "./wizard.js";
import { settleAcknowledgement } from "./wizard.js";

/**
 * The first of the two blocks that close a successful run.
 *
 * A wizard's last screen is the one a user acts on, so it is not spent on a
 * single sentence printed *outside* the frame — "TraceRoot is connected, your
 * application's checks were not run, and your first trace is available here: …"
 * — a claim, a caveat and a URL crammed into one line that visibly does not
 * belong to the box the CLI has just drawn.
 *
 * Instead: two settled blocks, each one thing to read and one thing to
 * acknowledge, and then the frame closes. This block is the local half — the
 * application is
 * instrumented, here is where its traces land, here is what to do if they do
 * not — and {@link acknowledgeProduction} is the half about everywhere else.
 *
 * The trace URL is the backend's own permalink for the trace this run actually
 * saw, never a constructed one: a self-hosted deployment's UI does not live
 * where the API does, and guessing produces a link that 404s at the exact
 * moment the user first clicks anything.
 */

export interface TracesNoticeInput {
  /** The backend's permalink for the first trace this run received. */
  traceUrl: string;
}

/**
 * The block, as lines. Pure, so the wording is assertable without a terminal.
 *
 * One sentence per line, and no line broken by hand. Wrapping the block at
 * around seventy-five columns puts "to confirm that" and "is here:" alone at
 * the ends of lines and makes three sentences read as six fragments. A
 * terminal already knows its own width; the only thing hand-wrapping
 * adds is a guess about it that is wrong on every window but one.
 *
 * `sink` is where the block is headed, because the bold line, the permalink
 * and the grey caveat are painted here rather than by whatever prints them:
 * the colour has to answer to the stream the lines land on, not to
 * `process.stderr` on the way past. Defaults to it for a caller that is only
 * reading the wording.
 */
export function tracesNotice(input: TracesNoticeInput, sink: Sink = process.stderr): string[] {
  return [
    // The instruction, and the only bold line in the block. Everything else
    // here is where to look afterwards; this is the thing to go and do, and it
    // is the step the wizard cannot take on the user's behalf.
    wizardEmphasis("Run your application and exercise the code you just instrumented.", sink),
    "",
    "Traces will appear here:",
    wizardLink(input.traceUrl, undefined, sink),
    "",
    // Grey, and a grey link with it: this is the branch nobody wants to be on.
    // It has to be here — a dead end at the last step of onboarding is where a
    // first-run tool loses people — but at full contrast it competes with the
    // permalink above, which is the line that matters when things did work.
    wizardAside("If traces do not show up, see the troubleshooting guide:", sink),
    wizardMutedLink(DOCS_URL, sink),
  ];
}

/** Named once, because it is written twice: live, then greyed over itself. */
const TRACES_ACK = "I've confirmed my application is sending traces.";

export interface AcknowledgeTracesInput extends TracesNoticeInput {
  writers: Writers;
  /**
   * Asks for the acknowledgement. Null when there is nobody to ask — the block
   * is still printed, because it reads as well in a log as on a terminal, but
   * an unattended run must never be left waiting on a keypress.
   */
  prompt: Prompt | null;
}

/** Prints the block and, where there is a human, waits for them to take it in. */
export async function acknowledgeTraces(input: AcknowledgeTracesInput): Promise<void> {
  const lines = tracesNotice(input, input.writers.err);
  // A blank rail before the acknowledgement, and no glyph on it. The rail
  // supplies the separation on its own; without a marker in the gutter the line
  // still reads as part of this block rather than as a section of its own.
  wizardNote(input.writers, input.prompt === null ? lines : [...lines, ""], { settled: true });
  if (input.prompt === null) {
    return;
  }
  // The answer is deliberately ignored: an acknowledgement, not a question.
  // Its only job is to stop the next block from scrolling this one away unread.
  await input.prompt(`${wizardAcknowledgement(TRACES_ACK, input.writers.err)} `);
  settleAcknowledgement(input.writers, TRACES_ACK);
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
    wizardAside("  traceroot traces list --limit 5", sink),
    "",
    wizardAside("To have setup wait for it again:", sink),
    wizardAside("  traceroot setup --resume", sink),
  ];
}
