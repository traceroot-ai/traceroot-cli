import { describe, expect, it } from "vitest";
import { acknowledgeTraces, tracesNotice } from "../../src/setup/ending.js";
import { plain } from "./colour.js";
import { makeWriters } from "./helpers.js";

const TRACE_URL = "https://app.example.test/trace/t_1";

describe("what the block says", () => {
  it("says what to do, where the traces land, and where to go if they do not", () => {
    const text = tracesNotice({ traceUrl: TRACE_URL }).join("\n");
    expect(text).toContain("Run your application and exercise the code you just instrumented.");
    expect(text).toContain("Traces will appear here:");
    expect(text).toContain(TRACE_URL);
    expect(text).toContain("If traces do not show up, see the troubleshooting guide:");
    expect(text).toContain("https://docs.traceroot.ai");
  });

  it("writes each sentence as one line and lets the terminal wrap it", () => {
    // The block used to wrap itself at about seventy-five columns, which left
    // "to confirm that" and "is here:" stranded at the ends of lines and made
    // three sentences read as six fragments. A terminal knows its own width.
    for (const line of tracesNotice({ traceUrl: TRACE_URL }).map(plain)) {
      const sentences = line.match(/\. /g) ?? [];
      expect(sentences.length).toBe(0);
    }
    // And no sentence is split across two entries: every non-empty line either
    // ends a sentence, ends in a colon, or is the URL itself.
    const prose = tracesNotice({ traceUrl: TRACE_URL })
      .map(plain)
      .filter(
        (line) => line !== "" && !line.includes(TRACE_URL) && !line.includes("docs.traceroot.ai"),
      );
    for (const line of prose) {
      expect(line.trimEnd().endsWith(".") || line.trimEnd().endsWith(":")).toBe(true);
    }
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
    expect(plain(asked[0])).toContain("│  I've confirmed my application is sending traces.");
    expect(plain(asked[0])).not.toContain("●");
    expect(plain(asked[0])).toContain("(Press Enter to continue)");
    // A settled block: `◇` is what the transcript shows once the
    // acknowledgement under it has been given.
    expect(plain(err.data)).toContain(
      "◇  Run your application and exercise the code you just instrumented.",
    );
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
