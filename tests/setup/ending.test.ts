import { describe, expect, it } from "vitest";
import { acknowledgeTraces, skippedTraceNotice, tracesNotice } from "../../src/setup/ending.js";
import { plain } from "./colour.js";
import { makeWriters } from "./helpers.js";

const TRACE_URL = "https://app.example.test/trace/t_1";

describe("what the block says", () => {
  it("hands over the trace that arrived, under a label that says what it is", () => {
    const lines = tracesNotice({ traceUrl: TRACE_URL }).map(plain);
    expect(lines).toEqual(["Your first trace:", TRACE_URL]);
  });

  it("does not tell a run that already has a trace to go and produce one", () => {
    // The trace this block links to is the proof the application sends traces,
    // so an instruction to run it, a label promising traces "will appear", and
    // a guide for when they do not are all about a state the run is past.
    const text = tracesNotice({ traceUrl: TRACE_URL }).map(plain).join("\n");
    expect(text).not.toContain("Run your application");
    expect(text).not.toContain("will appear");
    expect(text).not.toContain("troubleshoot");
  });

  it("does not call the trace the user's own when the project had other senders", () => {
    // The stage has already warned that this trace may come from somewhere
    // else. A label claiming it as the user's first would contradict that.
    const lines = tracesNotice({ traceUrl: TRACE_URL, attributed: false }).map(plain);
    expect(lines).toEqual(["First trace since setup started:", TRACE_URL]);
    // Unknown is not a doubt, and reads as the ordinary case.
    expect(tracesNotice({ traceUrl: TRACE_URL, attributed: true }).map(plain)[0]).toBe(
      "Your first trace:",
    );
  });

  it("echoes the permalink verbatim rather than building one from it", () => {
    // A self-hosted UI does not live where its API does. Anything reconstructed
    // here 404s at the exact moment the user first clicks something.
    const odd = "https://selfhosted.internal:8443/x/y/trace/abc?tenant=1";
    expect(tracesNotice({ traceUrl: odd }).map(plain)).toContain(odd);
  });

  it("puts the link on a line of its own, so it survives being copied", () => {
    const lines = tracesNotice({ traceUrl: TRACE_URL }).map(plain);
    expect(lines.filter((line) => line.includes(TRACE_URL))).toEqual([TRACE_URL]);
  });
});

describe("acknowledging it", () => {
  it("waits for a human, and ignores whatever they type", async () => {
    // An acknowledgement, not a question: nothing branches on the answer. It
    // exists so the production block cannot scroll this one away unread.
    const { writers, err } = makeWriters();
    const asked: string[] = [];

    await acknowledgeTraces({
      writers,
      traceUrl: TRACE_URL,
      prompt: async (question) => {
        asked.push(question);
        return "anything at all";
      },
    });

    // A green dot rather than the rail, the sentence at full contrast, and the
    // instruction grey on the right — the only row of the block waiting on
    // anybody, and it should look like it.
    expect(asked).toHaveLength(1);
    const question = plain(asked[0] ?? "");
    expect(question).toContain("│  I've confirmed my application is sending traces.");
    expect(question).not.toContain("●");
    expect(question).toContain("(Press Enter to continue)");
    // A settled block: `◇` is what the transcript shows once the
    // acknowledgement under it has been given.
    expect(plain(err.data)).toContain("◇  Your first trace:");
    expect(plain(err.data)).toContain(`│  ${TRACE_URL}`);
  });

  it("still prints the block when there is nobody to ask", async () => {
    // Worth reading in a log too — but an unattended run must never be left
    // waiting on a keypress.
    const { writers, err } = makeWriters();
    await acknowledgeTraces({ writers, traceUrl: TRACE_URL, prompt: null });
    expect(plain(err.data)).toContain(TRACE_URL);
  });
});

describe("the block for a wait the user ended", () => {
  const UI = "https://app.example.test";

  it("says the run is done and names both places the trace will show up", () => {
    const lines = skippedTraceNotice({ uiBaseUrl: UI }).map(plain);
    const text = lines.join("\n");
    // "Done", because it is: the only unobserved fact is a trace arriving, and
    // the user said they would watch for it somewhere else.
    expect(text).toContain("Setup is done");
    expect(text).toContain("has not been seen yet");
    expect(text).toContain("It will appear here:");
    expect(text).toContain(UI);
    // The terminal as well as the browser, for somebody who has demonstrably
    // chosen not to sit and watch.
    expect(text).toContain("traceroot traces list --limit 5");
    expect(text).toContain("traceroot setup --resume");
  });

  it("asks nobody to finish anything, because nothing is outstanding", () => {
    const text = skippedTraceNotice({ uiBaseUrl: UI }).map(plain).join("\n");
    expect(text).not.toContain("Finish the instrumentation task");
    expect(text).not.toContain("did not reach");
    // And it does not invent a permalink for a trace nobody has seen: a
    // constructed trace URL 404s at the moment it is first clicked.
    expect(text).not.toContain("/trace/");
  });

  it("falls back to the terminal when the run never learned the UI", () => {
    // Nothing to link to, so there is no heading for a link either — a
    // "It will appear here:" with nothing under it reads as a broken render.
    const lines = skippedTraceNotice({ uiBaseUrl: null }).map(plain);
    const text = lines.join("\n");
    expect(text).not.toContain("It will appear here:");
    expect(text).toContain("traceroot traces list --limit 5");
    expect(lines.filter((line) => line === "").length).toBeLessThan(lines.length);
  });

  it("writes each sentence as one line and lets the terminal wrap it", () => {
    const lines = skippedTraceNotice({ uiBaseUrl: UI }).map(plain);
    // The sentences themselves, as whole entries. A length cap alone would pass
    // a sentence this block had hard-wrapped across two of them, which is the
    // thing the terminal is supposed to be left to do.
    expect(lines).toContain("Setup is done — your first trace just has not been seen yet.");
    expect(lines).toContain("Or from the terminal, once your application has run:");
    expect(lines).toContain("To have setup wait for it again:");
    for (const line of lines) {
      expect(line.length).toBeLessThan(80);
    }
  });
});
