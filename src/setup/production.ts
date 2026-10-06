import type { Writers } from "../output.js";
import type { Prompt } from "../prompt.js";
import { HOST_ENV, KEY_ENV, applicationEnvKeys } from "./envWrite.js";
import type { StackLanguage } from "./types.js";
import {
  wizardAcknowledgement,
  wizardAside,
  wizardEmphasis,
  wizardEnvVar,
  wizardNote,
} from "./wizard.js";
import { settleAcknowledgement } from "./wizard.js";

/**
 * The last thing a run says, and the only part of it about somewhere other than
 * this machine.
 *
 * A first trace from a developer's laptop is the headline promise, and it is
 * also the point at which onboarding tools habitually stop — leaving the user
 * with a working local setup, a `.env.traceroot` they did not write, and no idea
 * that neither travels. So the run ends on exactly this note.
 *
 * One instruction and one footnote. It was five lines of runtime trivia with
 * the instruction last, which is the wrong way round for the final thing a
 * wizard says: the user is being asked to do exactly one thing, and it should
 * not be at the bottom of a paragraph about dotenv.
 *
 * The footnote survives the compression because it is true and it bites
 * locally, not only on deploy. Neither the Python nor the TypeScript SDK
 * carries a dotenv dependency; `traceroot-py/traceroot/env.py` reads
 * `os.environ` and nothing else. So `.env.traceroot` is only ever loaded by
 * something outside the SDK — a framework, a flag, a library — and for a plain
 * `python main.py` that something does not exist. Telling a Python user their
 * local setup is finished would be wrong on their next run.
 */

const ENV_FILE = ".env.traceroot";

export interface ProductionNoticeInput {
  /** The instrumented service's language; null when the run never settled one. */
  language: StackLanguage | null;
  /**
   * Where the credential actually landed, relative to the repository root, or `.`
   * for the root itself. The file follows the service, so a run that named one
   * must name the directory here or the notice points at a path the user does not
   * have.
   */
  envFileDir?: string;
  /**
   * The host this run authenticated against, which is what decides how many
   * variables the user has to carry.
   *
   * The notice used to name `TRACEROOT_API_KEY` and nothing else, while
   * `configure_repository` wrote a second line for any host but the default.
   * Taking the host and asking {@link applicationEnvKeys} is what keeps the two
   * in step — and is why a third variable would need no change here at all.
   * Undefined when the run never settled a host, where the key alone is the
   * only honest answer.
   */
  host?: string;
}

/**
 * Names in a sentence: `A`, `A and B`, `A, B and C`.
 *
 * No Oxford comma, matching the rest of the wizard's copy.
 */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The notice, as lines. Pure, so the wording is assertable without a terminal —
 * and the wording is the entire substance of this step.
 */
export function productionNotice(input: ProductionNoticeInput): string[] {
  // Two weights, because the two names are doing different jobs. The variable
  // is a literal string to reproduce in another system, which is the accent
  // colour's role everywhere else in the run. The file is a path on this
  // machine the user has to go and open, so it takes bold: it is the noun the
  // sentence turns on, and colouring it the same as the variable made the line
  // read as one long token rather than an instruction with a subject.
  const keys = applicationEnvKeys(input.host);
  const named = nameList(keys.map((name) => wizardEnvVar(name)));
  // `token` for one and `variables` for several, because with the host in the
  // list they are not all tokens. The singular sentence is unchanged, which is
  // the sentence almost every run prints.
  const noun = keys.length === 1 ? "token" : "variables";
  const dir = input.envFileDir === undefined || input.envFileDir === "." ? "." : input.envFileDir;
  const file = wizardEmphasis(dir === "." ? `./${ENV_FILE}` : `${dir}/${ENV_FILE}`);

  return [
    // One sentence, unwrapped, and nothing parenthetical inside it. This was
    // five lines under a heading of its own — "Before this works anywhere but
    // here", then two paragraphs of runtime trivia, then the actual
    // instruction last. The instruction is the block; the trivia is a footnote
    // to it, and now reads as one.
    // "Production Setup:" is gone from the front. It was a heading wearing a
    // sentence's clothes — a colon mid-line doing the job the block's own
    // marker already does — and it pushed the verb far enough right that the
    // line wrapped in the middle of the instruction on an ordinary window.
    // What is left starts with the thing to do.
    `Add the ${named} ${noun} from your local ${file} file to your production environment.`,
    // The caveat, compressed to a line, because it is true and it bites
    // locally rather than only on deploy: neither SDK carries a dotenv
    // dependency, so nothing reads this file at runtime unless the user
    // arranges it. `.env.traceroot` is nobody's convention — that is the point
    // of the name and also the cost of it.
    wizardAside(localCaveat(input.language, keys)),
    // And the clause that would have saved the user who found this.
    //
    // A sentence of its own rather than another dependent clause on the line
    // above, which is already as long as a line in this block gets. It is the
    // only failure in the run that is completely silent: a key exported without
    // its host authenticates nowhere, and the SDK says so to nobody.
    ...(keys.includes(HOST_ENV)
      ? [
          wizardAside(
            `Exporting only ${KEY_ENV} leaves the SDK on its default host, which is not the one this key is for.`,
          ),
        ]
      : []),
  ];
}

/**
 * Why the file the setup just wrote does not, on its own, do anything.
 *
 * Per language because the remedy genuinely differs, and the Python one is the
 * one that surprises people: `traceroot/env.py` reads `os.environ` and nothing
 * else, so a plain `python main.py` starts with no key and sends no traces even
 * on the machine where setup succeeded.
 */
function localCaveat(language: StackLanguage | null, keys: readonly string[]): string {
  // Every variable the file holds, not just the key. "Export the key" is the
  // instruction that misroutes a non-default host, and it misroutes it here on
  // the user's own machine exactly as it does on deploy.
  //
  // Space-separated rather than through `nameList`: this list is pasted into a
  // shell, and `export A and B` exports a variable named `and` while leaving
  // both of TraceRoot's unset — the precise failure the sentence exists to
  // prevent. `export A B` is what a shell accepts. `nameList` stays for the
  // prose elsewhere in this file, where "A and B" is what a reader wants.
  const exports = keys.join(" ");
  if (language === "python") {
    return `Locally too: the SDK reads os.environ and nothing loads ${ENV_FILE} at runtime — export ${exports} in your shell, or load the file with python-dotenv.`;
  }
  if (language === null) {
    // No language settled, so no runtime to name. Says the true general thing
    // rather than guessing at a remedy that might not apply.
    return `Locally too: the SDK reads the environment and nothing loads ${ENV_FILE} at runtime — export ${exports} in your shell, or load the file with whatever your runtime provides.`;
  }
  // Every JavaScript runtime, and Next.js by name, because "my framework loads
  // .env files" is the belief a reader arrives with. It was true while this
  // file was called `.env.local`; it is not true of a name nobody's convention
  // covers.
  return `Locally too: nothing loads ${ENV_FILE} at runtime, not node and not Next.js — run with --env-file=${ENV_FILE}, load it with dotenv, or export ${exports} in your shell.`;
}

export interface AcknowledgeProductionInput extends ProductionNoticeInput {
  writers: Writers;
  /**
   * Asks for the acknowledgement. Null when there is nobody to ask — the notice
   * is still printed, because it is as worth reading in a log as on a terminal,
   * but an unattended run must never be left waiting on a keypress.
   */
  prompt: Prompt | null;
}

/** Prints the notice and, where there is a human, waits for them to take it in. */
export async function acknowledgeProduction(input: AcknowledgeProductionInput): Promise<void> {
  const lines = productionNotice(input);
  // A blank rail before the acknowledgement, and no glyph on it. The rail
  // supplies the separation on its own; without a marker in the gutter the line
  // still reads as part of this block rather than as a section of its own.
  wizardNote(input.writers, input.prompt === null ? lines : [...lines, ""], { settled: true });
  if (input.prompt === null) {
    return;
  }
  // The answer is deliberately ignored. This is an acknowledgement, not a
  // question: there is no wrong reply and nothing branches on it. Its only job
  // is to stop the closing line from scrolling the notice away unread.
  //
  // Bold rather than blue on the variable here. Blue is for a name to go and
  // use; this line is the user reporting they already used it, and weight says
  // "this is the thing you just did" where a second blue would only repeat the
  // sentence above.
  //
  // It names every variable too. This is the line the user says back, and a
  // line that claims less than the instruction asked for is how someone
  // confirms they have done a thing they have half done.
  const said = `I have added ${nameList(applicationEnvKeys(input.host).map((name) => wizardEmphasis(name)))} to my production env.`;
  await input.prompt(`${wizardAcknowledgement(said)} `);
  // The variable stays bold in the settled copy too. Dimming a line that
  // already carries a bold span would end the dim where the bold ends, so the
  // weight is re-applied inside rather than composed around.
  settleAcknowledgement(input.writers, said);
}
