import { describe, expect, it } from "vitest";
import { acknowledgeProduction, productionNotice } from "../../src/setup/production.js";
import { makeWriters } from "./helpers.js";

const text = (language: Parameters<typeof productionNotice>[0]["language"]) =>
  productionNotice({ language }).join("\n");

describe("what the notice says", () => {
  it("names the variable and the file, and never the key at all", () => {
    // The block used to name which key setup wrote, as a prefix and last four.
    // It was the only place the run said so, and it still bought a clause in
    // the middle of the one sentence this block exists to deliver — for a value
    // the user cannot do anything with. The file it is written in is named
    // right here; that is where to go and look.
    const notice = text("python");
    expect(notice).toContain("TRACEROOT_API_KEY");
    expect(notice).toContain(".env.traceroot");
    expect(notice).not.toContain("Setup wrote");
  });

  it("tells a Python user their local run is not configured either", () => {
    // The SDK reads os.environ and carries no dotenv dependency, and Python
    // does not read .env.traceroot. Saying "you are set up locally" would be wrong
    // on their very next run, not just on their next deploy. Compressed to one
    // line, but not dropped: this is the caveat that bites before any deploy.
    const notice = text("python");
    expect(notice).toContain("os.environ");
    expect(notice).toContain("python-dotenv");
  });

  it("does not promise a Python user that a framework will load the file", () => {
    expect(text("python")).not.toContain("Next.js");
  });

  it("does not let a JavaScript user think a framework will load the file", () => {
    // This is the sentence the rename invalidated. While the file was called
    // `.env.local` it was Next.js's own convention and Next.js loaded it; the
    // notice said so, correctly. `.env.traceroot` is nobody's convention, which
    // is exactly the point of the name and also the cost of it — so the notice
    // now has to say the opposite, and say it about Next.js by name, because
    // that is the belief a reader arrives with.
    for (const language of ["typescript", "javascript"] as const) {
      const notice = text(language);
      expect(notice).toContain("nothing loads .env.traceroot at runtime");
      expect(notice).toContain("not Next.js");
      expect(notice).toContain("--env-file=.env.traceroot");
      expect(notice).not.toContain("os.environ");
    }
  });

  it("stays honest when the run never settled a language", () => {
    const notice = text(null);
    expect(notice).not.toContain("Next.js");
    expect(notice).not.toContain("python-dotenv");
    expect(notice).toContain("export TRACEROOT_API_KEY");
  });

  it("opens on the verb, with no heading in front of it", () => {
    // "Production Setup:" led this line until the colon was read for what it
    // was — a heading wearing a sentence's clothes, doing a job the block's own
    // marker already does, and pushing the verb far enough right that the line
    // wrapped mid-instruction on an ordinary window.
    for (const language of ["python", "typescript", null] as const) {
      const notice = productionNotice({ language });
      expect(notice[0]).toContain("Add the TRACEROOT_API_KEY token");
      expect(notice[0]).toContain("./.env.traceroot");
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
      expect(asked[0]).toContain("│  I have added TRACEROOT_API_KEY to my production env.");
      expect(asked[0]).not.toContain("●");
      expect(asked[0]).toContain("(Press Enter to continue)");
      // A settled block, not a pending one: `◇` is what the transcript shows
      // once the acknowledgement under it has been given.
      expect(err.data).toContain("◇  Add the TRACEROOT_API_KEY token");
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
    expect(err.data).toContain("Add the TRACEROOT_API_KEY token");
  });
});
