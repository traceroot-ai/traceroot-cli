import { describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../../src/commands/constants.js";
import { applicationEnvKeys } from "../../src/setup/envWrite.js";
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

  it("names the directory the credential actually landed in", () => {
    // The file follows the service, so a run that instrumented `apps/api` wrote
    // the key there. Saying `./` sends the user to a path they do not have.
    const notice = productionNotice({ language: "python", envFileDir: "apps/api" })
      .map(plain)
      .join("\n");
    expect(notice).toContain("apps/api/.env.traceroot");
    expect(notice).not.toContain("./.env.traceroot");
  });

  it("still says ./ for a service at the repository root", () => {
    const notice = productionNotice({ language: "python", envFileDir: "." }).map(plain).join("\n");
    expect(notice).toContain("./.env.traceroot");
  });

  it("opens on the verb, with no heading in front of it", () => {
    // "Production Setup:" led this line until the colon was read for what it
    // was — a heading wearing a sentence's clothes, doing a job the block's own
    // marker already does, and pushing the verb far enough right that the line
    // wrapped mid-instruction on an ordinary window.
    for (const language of ["python", "typescript", null] as const) {
      const notice = productionNotice({ language }).map(plain);
      expect(notice[0]).toContain("Add the TRACEROOT_API_KEY token");
      expect(notice[0]).toContain("./.env.traceroot");
      expect(notice[0]).toContain("to your production environment.");
      expect(notice[0]).not.toContain("Production Setup:");
    }
  });
});

describe("which variables it tells you to carry", () => {
  const STAGING = "https://staging.traceroot.ai";
  const notice = (host?: string) =>
    productionNotice({ language: "python", host }).map(plain).join("\n");

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
    expect(text).toContain("export TRACEROOT_API_KEY and TRACEROOT_HOST_URL in your shell");
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
