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
 * with a working local setup, a key in a gitignored file, and no idea that
 * neither travels. So the run ends on exactly this note.
 *
 * One instruction and one footnote. It was five lines of runtime trivia with
 * the instruction last, which is the wrong way round for the final thing a
 * wizard says: the user is being asked to do exactly one thing, and it should
 * not be at the bottom of a paragraph about dotenv.
 *
 * The footnote survives the compression because it is true and it bites
 * locally, not only on deploy. Neither the Python nor the TypeScript SDK
 * carries a dotenv dependency; `traceroot-py/traceroot/env.py` reads
 * `os.environ` and nothing else. The credential now sits in the project's own
 * env file, so whether it reaches the SDK is a question about the project's
 * loader rather than about this tool — which is an improvement, because a great
 * many projects already have one, and a statement the footnote has to make
 * carefully rather than flatly. It no longer claims nothing loads the file; it
 * says the SDK does not, and names what would.
 */

/**
 * Where the credential lands when the caller does not say.
 *
 * A default rather than a constant filename: the run chooses between the
 * project's own env files, so the notice is told which one it picked. `KEY_ENV`
 * and `HOST_ENV` come from `envWrite.ts`, which is the one place that decides
 * which variables the file holds.
 */
const DEFAULT_ENV_FILE = "./.env";

export interface ProductionNoticeInput {
  /** The instrumented service's language; null when the run never settled one. */
  language: StackLanguage | null;
  /**
   * The file the credential actually landed in, as the user should see it:
   * relative to the repository root, `./`-prefixed at the root.
   *
   * Both halves vary now. The file follows the service, so a run that
   * instrumented `apps/api` wrote it there; and the *name* is whichever of the
   * project's own env files the run chose, which is `.env.local` as readily as
   * `.env`. Naming the wrong one sends the user to a file they do not have.
   */
  credentialEnvFile?: string;
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
  // The file as the caller named it, whole. It used to be a directory joined to
  // a constant filename; the name is now whichever of the project's own env
  // files the run chose, so the caller passes the path and this does not guess.
  const path = input.credentialEnvFile ?? DEFAULT_ENV_FILE;
  const file = wizardEmphasis(path);

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
    // dependency, so the file reaches the process environment only if the
    // project loads it.
    wizardAside(localCaveat(input.language, path, keys)),
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
 * Why the file holding the key may still not reach the SDK.
 *
 * Per language because the mechanism genuinely differs, and because the honest
 * answer changed when the credential moved into the project's own env file. The
 * old line said nothing loads it, which was true of a name nobody's convention
 * covered. Said about `.env` it would be false for most of the readers it
 * reaches — Next.js, Vite, Django and docker-compose all load it — and a
 * footnote a reader can see is wrong is a footnote they stop reading.
 *
 * So it says the part that stays true for everyone: the SDK itself reads only
 * the process environment. Whether the file gets there is the project's
 * loader's job, and each language gets the remedy that actually applies.
 *
 * The fallback remedy names every variable the file holds, not just the key.
 * "Export the key" is the instruction that misroutes a non-default host, and it
 * misroutes it here on the user's own machine exactly as it does on deploy.
 */
function localCaveat(
  language: StackLanguage | null,
  file: string,
  keys: readonly string[],
): string {
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
    // The one that surprises people: `traceroot/env.py` reads `os.environ` and
    // nothing else, so a plain `python main.py` with no `load_dotenv()` call
    // starts with no key and sends nothing, on the very machine where setup
    // just succeeded.
    return `Locally too: the SDK reads os.environ, so ${file} only reaches it if your app loads it — call python-dotenv's load_dotenv(), or export ${exports} in your shell.`;
  }
  if (language === null) {
    // No language settled, so no runtime to name. Says the true general thing
    // rather than guessing at a remedy that might not apply.
    return `Locally too: the SDK reads the process environment, so ${file} only reaches it if your app loads it — export ${exports} in your shell if it does not.`;
  }
  // Next.js by name, because "my framework loads .env files" is the belief a
  // reader arrives with — and for this file it is usually right. The line's job
  // is now to mark the case where it is not, which is a plain entry point.
  return `Locally too: the SDK reads process.env, so ${file} only reaches it if your app loads it — a framework such as Next.js does, a plain node entry point needs dotenv or export ${exports} in your shell.`;
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
