import { describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../../src/commands/constants.js";
import { applicationEnvKeys } from "../../src/setup/envWrite.js";
import { acknowledgeProduction, productionNotice } from "../../src/setup/production.js";
import type { ApplicationKeyLocation } from "../../src/setup/types.js";
import { plain } from "./colour.js";
import { makeWriters } from "./helpers.js";

/** The ordinary run: one of the project's own env files holds the key. */
const IN_ENV_FILE: ApplicationKeyLocation = { kind: "file", path: "./.env" };

const text = (language: Parameters<typeof productionNotice>[0]["language"]) =>
  productionNotice({ language, keyLocation: IN_ENV_FILE }).map(plain).join("\n");

describe("what the notice says", () => {
  it("names the variable and the file, and never the key at all", () => {
    // The block used to name which key setup wrote, as a prefix and last four.
    // It was the only place the run said so, and it still bought a clause in
    // the middle of the one sentence this block exists to deliver — for a value
    // the user cannot do anything with. The file it is written in is named
    // right here; that is where to go and look.
    const notice = text("python");
    expect(notice).toContain("TRACEROOT_API_KEY");
    expect(notice).toContain("./.env");
    expect(notice).not.toContain("Setup wrote");
  });

  it("tells a Python user their local run is not configured either", () => {
    // The SDK reads os.environ and carries no dotenv dependency, so a plain
    // `python main.py` with no `load_dotenv()` call still sends nothing. Saying
    // "you are set up locally" would be wrong on their very next run, not just
    // on their next deploy. Compressed to one line, but not dropped.
    const notice = text("python");
    expect(notice).toContain("os.environ");
    expect(notice).toContain("python-dotenv");
  });

  it("does not promise a Python user that a framework will load the file", () => {
    expect(text("python")).not.toContain("Next.js");
  });

  it("does not claim a framework fails to load the project's own env file", () => {
    // The line it replaces said "nothing loads it at runtime, not node and not
    // Next.js". That was true of a filename nobody's convention covered. Said
    // about the project's own `.env` it is false for most of the readers it
    // reaches — Next.js, Vite and docker-compose all load it — and a footnote a
    // reader can see is wrong is a footnote they stop reading. What is left is
    // the part that stays true for all of them: the SDK reads process.env.
    for (const language of ["typescript", "javascript"] as const) {
      const notice = text(language);
      expect(notice).toContain("the SDK reads process.env");
      expect(notice).toContain("a plain node entry point needs dotenv");
      expect(notice).not.toContain("not Next.js");
      // The flag guidance is gone with the filename that needed it: `--env-file`
      // exits non-zero on a missing file, and the file is gitignored by design.
      expect(notice).not.toContain("--env-file");
      expect(notice).not.toContain("os.environ");
    }
  });

  it("stays honest when the run never settled a language", () => {
    const notice = text(null);
    expect(notice).not.toContain("Next.js");
    expect(notice).not.toContain("python-dotenv");
    expect(notice).toContain("export TRACEROOT_API_KEY");
  });

  it("names the file the credential actually landed in, name and all", () => {
    // Both halves vary: the file follows the service, and the name is whichever
    // of the project's own env files the run chose. Saying `./.env` when the key
    // went to `apps/api/.env.local` sends the user to a file they do not have.
    const notice = productionNotice({
      language: "python",
      keyLocation: { kind: "file", path: "apps/api/.env.local" },
    })
      .map(plain)
      .join("\n");
    expect(notice).toContain("apps/api/.env.local");
    expect(notice).not.toContain("./.env ");
  });

  it("opens on the verb, with no heading in front of it", () => {
    // "Production Setup:" led this line until the colon was read for what it
    // was — a heading wearing a sentence's clothes, doing a job the block's own
    // marker already does, and pushing the verb far enough right that the line
    // wrapped mid-instruction on an ordinary window.
    for (const language of ["python", "typescript", null] as const) {
      const notice = productionNotice({ language, keyLocation: IN_ENV_FILE }).map(plain);
      expect(notice[0]).toContain("Add the TRACEROOT_API_KEY token");
      expect(notice[0]).toContain("./.env");
      expect(notice[0]).toContain("to your production environment.");
      expect(notice[0]).not.toContain("Production Setup:");
    }
  });
});

describe("the runs where no file holds the key", () => {
  // Two of them, and they were one. The notice took an optional filename that
  // fell back to `./.env`, so a run that wrote no file still signed off by
  // telling the user to open one — in the tracked case, one that holds nothing
  // at all. Both reach this block with a trace, which is what makes them worth
  // a sentence each rather than a default.
  const lines = (keyLocation: ApplicationKeyLocation) =>
    productionNotice({ language: "python", keyLocation }).map(plain);

  it("names no file when the key came from the user's own environment", () => {
    const notice = lines({ kind: "environment" });

    // The instruction survives whole: production still needs the variable, and
    // that is the point of the block.
    expect(notice[0]).toBe("Add the TRACEROOT_API_KEY token to your production environment.");
    // And it does not send them to a file that was never written.
    expect(notice.join("\n")).not.toContain(".env");
    // What it says instead: where the value they are copying actually is.
    expect(notice[1]).toContain("read TRACEROOT_API_KEY from your own environment");
    expect(notice[1]).toContain("the value to copy is the one already set on this machine");
    // The dotenv caveat goes with the file. The key is already in the
    // environment the application starts in — there is nothing to load.
    expect(notice.join("\n")).not.toContain("load_dotenv");
  });

  it("says outright that nothing holds the key when a tracked file was refused", () => {
    const notice = lines({ kind: "refused", path: "apps/api/.env" });

    expect(notice[0]).toBe("Add the TRACEROOT_API_KEY token to your production environment.");
    // The file is named, because it is the reason — and it is named as the file
    // this run would not write, never as somewhere to go and look.
    expect(notice[1]).toBe(
      "Nothing on this machine holds TRACEROOT_API_KEY: apps/api/.env is tracked by git, so this run did not write the key into it. Give your deployment a key of its own.",
    );
    expect(notice[1]).not.toContain("from your local");
  });

  it("still names the host variable off the default host", () => {
    // The variable list is derived from the host and the instruction is derived
    // from the location, and these are the cases where the second one no longer
    // carries a filename. A run on a self-hosted instance that wrote no file
    // needs both variables named as much as any other.
    for (const keyLocation of [
      { kind: "environment" },
      { kind: "refused", path: ".env" },
    ] as const) {
      const notice = productionNotice({
        language: "python",
        host: "https://staging.traceroot.ai",
        keyLocation,
      }).map(plain);
      expect(notice[0]).toBe(
        "Add the TRACEROOT_API_KEY and TRACEROOT_HOST_URL variables to your production environment.",
      );
      expect(notice.join("\n")).toContain(
        "Exporting only TRACEROOT_API_KEY leaves the SDK on its default host",
      );
    }
  });
});

describe("which variables it tells you to carry", () => {
  const STAGING = "https://staging.traceroot.ai";
  const notice = (host?: string) =>
    productionNotice({ language: "python", host, keyLocation: IN_ENV_FILE }).map(plain).join("\n");

  it("names every variable the file holds, not just the key", () => {
    // The bug this closes. `configure_repository` writes `TRACEROOT_HOST_URL`
    // alongside the key for any host but the default; the notice named the key
    // and nothing else. A staging or self-hosted user who did exactly what it
    // said carried the credential and left the host behind, and the SDK
    // defaults a missing host to the hosted product in silence — so the traces
    // went to an instance the key is not for, nothing crashed, nothing warned,
    // and the symptom was that tracing appeared not to work.
    const text = notice(STAGING);
    expect(text).toContain(
      "Add the TRACEROOT_API_KEY and TRACEROOT_HOST_URL variables from your local",
    );
    // The caveat about this machine carries the identical gap, and bites first.
    // Space-separated, because this half of the sentence is a command: `export
    // A and B` exports a variable named `and` and leaves both of TraceRoot's
    // unset, which is the very misrouting the notice is warning about. The
    // prose above it keeps "and" because a reader is not pasting that.
    expect(text).toContain("export TRACEROOT_API_KEY TRACEROOT_HOST_URL in your shell");
    expect(text).not.toContain("export TRACEROOT_API_KEY and");
  });

  it("says outright that carrying only the key misroutes the traces", () => {
    // The clause that would have saved the user who found this. It is the one
    // failure in the run with no symptom at all, so it is worth a sentence.
    expect(notice(STAGING)).toContain(
      "Exporting only TRACEROOT_API_KEY leaves the SDK on its default host",
    );
  });

  it("is unchanged for the hosted product, which is almost every run", () => {
    // One variable, the singular noun, and no clause about a default host the
    // run is already on.
    for (const host of [undefined, DEFAULT_HOST]) {
      const text = notice(host);
      expect(text).toContain("Add the TRACEROOT_API_KEY token from your local");
      expect(text).not.toContain("TRACEROOT_HOST_URL");
      expect(text).not.toContain("default host");
    }
  });

  it("keeps the variable list right when the file is one the project named", () => {
    // The interaction, which neither half's own tests reach: the variable list
    // is derived from the host, and the file is now whichever of the project's
    // own env files the run chose. These were written as two separate changes
    // that both edit this one sentence, so a future edit to either can silently
    // drop the other — most likely by going back to naming the key alone.
    const text = productionNotice({
      language: "python",
      host: STAGING,
      keyLocation: { kind: "file", path: "apps/api/.env.local" },
    })
      .map(plain)
      .join("\n");

    expect(text).toContain(
      "Add the TRACEROOT_API_KEY and TRACEROOT_HOST_URL variables from your local apps/api/.env.local file",
    );
    // Still shell-valid, and still naming both, in the half that is a command.
    expect(text).toContain("export TRACEROOT_API_KEY TRACEROOT_HOST_URL in your shell");
    expect(text).toContain("Exporting only TRACEROOT_API_KEY leaves the SDK on its default host");
    // And the file is named whole rather than rebuilt from a directory and a
    // constant filename, which is what would reintroduce `.env` here.
    expect(text).not.toContain("apps/api/.env ");
  });

  it("names exactly the set the credential file is written from", () => {
    // The structural half, and the reason this stays correct rather than
    // happening to be correct. The notice and `configure_repository` both ask
    // `applicationEnvKeys`, so a third variable added there is named here
    // without a change to this file — and comparing against a literal list
    // would be the thing that stopped being true.
    for (const host of [undefined, DEFAULT_HOST, STAGING, "http://localhost:8000"]) {
      const mentioned = new Set(notice(host).match(/TRACEROOT_[A-Z_]+/g) ?? []);
      expect([...mentioned].sort()).toEqual([...applicationEnvKeys(host)].sort());
    }
  });
});

describe("acknowledging it", () => {
  it("waits for a human, and ignores whatever they type", () => {
    // An acknowledgement, not a question: there is no wrong answer and nothing
    // branches on it. It exists so the closing line cannot scroll the notice
    // away unread.
    const { writers, err } = makeWriters();
    const asked: string[] = [];

    return acknowledgeProduction({
      writers,
      language: "python",
      keyLocation: IN_ENV_FILE,
      prompt: async (question) => {
        asked.push(question);
        return "anything at all";
      },
    }).then(() => {
      expect(asked).toHaveLength(1);
      expect(plain(asked[0])).toContain("│  I have added TRACEROOT_API_KEY to my production env.");
      expect(plain(asked[0])).not.toContain("●");
      expect(plain(asked[0])).toContain("(Press Enter to continue)");
      // A settled block, not a pending one: `◇` is what the transcript shows
      // once the acknowledgement under it has been given.
      expect(plain(err.data)).toContain("◇  Add the TRACEROOT_API_KEY token");
    });
  });

  it("still prints the notice when there is nobody to ask", async () => {
    // Worth reading in a log too — but an unattended run must never be left
    // waiting on a keypress.
    const { writers, err } = makeWriters();
    await acknowledgeProduction({
      writers,
      language: "typescript",
      keyLocation: IN_ENV_FILE,
      prompt: null,
    });
    expect(plain(err.data)).toContain("Add the TRACEROOT_API_KEY token");
  });

  it("says back every variable the instruction asked for", async () => {
    // The acknowledgement is the user reporting what they did. Off the default
    // host the instruction names two variables, so a line that claims only the
    // key is someone confirming a thing they have half done.
    const { writers, err } = makeWriters();
    const asked: string[] = [];
    await acknowledgeProduction({
      writers,
      language: "python",
      host: "https://staging.traceroot.ai",
      keyLocation: IN_ENV_FILE,
      prompt: async (question) => {
        asked.push(question);
        return "";
      },
    });
    expect(plain(asked[0])).toContain(
      "I have added TRACEROOT_API_KEY and TRACEROOT_HOST_URL to my production env.",
    );
    // And the notice above it asked for both, which is what makes the line
    // above an acknowledgement rather than a smaller claim. Asserted on a
    // fragment because the block is wrapped to the terminal's width.
    expect(plain(err.data)).toContain("Add the TRACEROOT_API_KEY and TRACEROOT_HOST_URL variables");
  });
});
