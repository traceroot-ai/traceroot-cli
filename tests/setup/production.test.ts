import { describe, expect, it } from "vitest";
import { acknowledgeProduction, productionNotice } from "../../src/setup/production.js";
import { plain } from "./colour.js";
import { makeWriters } from "./helpers.js";

const text = (language: Parameters<typeof productionNotice>[0]["language"]) =>
  productionNotice({ language }).map(plain).join("\n");

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
      credentialEnvFile: "apps/api/.env.local",
    })
      .map(plain)
      .join("\n");
    expect(notice).toContain("apps/api/.env.local");
    expect(notice).not.toContain("./.env ");
  });

  it("falls back to ./.env when the caller names no file", () => {
    const notice = productionNotice({ language: "python" }).map(plain).join("\n");
    expect(notice).toContain("./.env");
  });

  it("opens on the verb, with no heading in front of it", () => {
    // "Production Setup:" led this line until the colon was read for what it
    // was — a heading wearing a sentence's clothes, doing a job the block's own
    // marker already does, and pushing the verb far enough right that the line
    // wrapped mid-instruction on an ordinary window.
    for (const language of ["python", "typescript", null] as const) {
      const notice = productionNotice({ language }).map(plain);
      expect(notice[0]).toContain("Add the TRACEROOT_API_KEY token");
      expect(notice[0]).toContain("./.env");
      expect(notice[0]).toContain("to your production environment.");
      expect(notice[0]).not.toContain("Production Setup:");
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
      prompt: null,
    });
    expect(plain(err.data)).toContain("Add the TRACEROOT_API_KEY token");
  });
});
