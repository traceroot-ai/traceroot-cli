import type { Writers } from "../output.js";
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
 */
export function tracesNotice(input: TracesNoticeInput): string[] {
  return [
    // The instruction, and the only bold line in the block. Everything else
    // here is where to look afterwards; this is the thing to go and do, and it
    // is the step the wizard cannot take on the user's behalf.
    wizardEmphasis("Run your application and exercise the code you just instrumented."),
    "",
    "Traces will appear here:",
    wizardLink(input.traceUrl),
    "",
    // Grey, and a grey link with it: this is the branch nobody wants to be on.
    // It has to be here — a dead end at the last step of onboarding is where a
    // first-run tool loses people — but at full contrast it competes with the
    // permalink above, which is the line that matters when things did work.
    wizardAside("If traces do not show up, see the troubleshooting guide:"),
    wizardMutedLink(DOCS_URL),
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
  const lines = tracesNotice(input);
  // A blank rail before the acknowledgement, and no glyph on it. The rail
  // supplies the separation on its own; without a marker in the gutter the line
  // still reads as part of this block rather than as a section of its own.
  wizardNote(input.writers, input.prompt === null ? lines : [...lines, ""], { settled: true });
  if (input.prompt === null) {
    return;
  }
  // The answer is deliberately ignored: an acknowledgement, not a question.
  // Its only job is to stop the next block from scrolling this one away unread.
  await input.prompt(`${wizardAcknowledgement(TRACES_ACK)} `);
  settleAcknowledgement(input.writers, TRACES_ACK);
}
