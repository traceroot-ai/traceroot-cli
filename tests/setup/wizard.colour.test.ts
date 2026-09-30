import { describe, expect, it, vi } from "vitest";

/**
 * The wizard's helpers, with colour forced on.
 *
 * Everywhere else in this suite picocolors is off — no TTY, no `FORCE_COLOR` —
 * so every assertion about `wizardEmphasis` or `wizardLink` is an assertion
 * about plain text, and a helper that quietly stopped emphasising anything
 * would pass all of them. `FORCE_COLOR` cannot fix that from inside a test:
 * picocolors reads it once, when the module is first evaluated, and it lives in
 * `node_modules`, which vitest externalizes and never re-evaluates. Replacing
 * the module with an explicitly enabled instance is the way in.
 */
vi.mock("picocolors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("picocolors")>();
  return { ...actual, default: actual.createColors(true) };
});

const ESC = String.fromCharCode(27);
const BOLD_ON = `${ESC}[1m`;
const BOLD_OFF = `${ESC}[22m`;
const OFF = `${ESC}[39m`;
const AQUA = `${ESC}[96m`;
const GREY = `${ESC}[38;5;245m`;
const DIM = `${ESC}[2m`;

describe("hue, when the terminal can show it", () => {
  it("puts a settled value in green, and only the value", async () => {
    // The sentence around it is ours; these two are facts about the user's
    // account, and the colour is what lets someone confirm at a glance that the
    // run landed in the project they meant.
    const { wizardValue } = await import("../../src/setup/wizard.js");
    expect(wizardValue("demo")).toBe(`${ESC}[32mdemo${OFF}`);
  });

  it("paints a link and a variable name the same aqua", async () => {
    // One role, not two: both are things the eye has to find in a paragraph and
    // then act on exactly. Bright cyan (96) rather than plain blue (34), which
    // is the darkest colour in the set and was the least legible thing on a
    // dark terminal — a poor outcome for the lines most likely to be selected
    // with a mouse.
    const { wizardEnvVar, wizardLink } = await import("../../src/setup/wizard.js");
    expect(wizardLink("https://x.test/t/1", false)).toBe(`${AQUA}https://x.test/t/1${OFF}`);
    expect(wizardEnvVar("TRACEROOT_API_KEY")).toBe(`${AQUA}TRACEROOT_API_KEY${OFF}`);
  });

  it("separates a step marker from a link by intensity, not hue", async () => {
    // These now share a hue, deliberately. What still tells them apart is
    // intensity and column: a step glyph is plain cyan (36) in the rail, a link
    // is bright cyan (96) in the text. The pairing is pinned here because it is
    // the only thing keeping "this is a heading" and "this is a thing to click"
    // distinguishable — anything that made the glyph bright would collapse it.
    const { wizardStepLine, wizardLink } = await import("../../src/setup/wizard.js");
    expect(wizardStepLine("Choose how to instrument")).toContain(`${ESC}[36m`);
    expect(wizardStepLine("Choose how to instrument")).not.toContain(`${ESC}[96m`);
    expect(wizardLink("https://x.test", false)).toContain(`${ESC}[96m`);
    expect(wizardLink("https://x.test", false)).not.toContain(`${ESC}[36m`);
  });

  it("keeps a reference link quieter than the one to act on", async () => {
    // The troubleshooting guide is the branch nobody wants to be on. At the
    // same weight as the trace permalink it won by sitting lower on the screen.
    const { wizardMutedLink } = await import("../../src/setup/wizard.js");
    expect(wizardMutedLink("https://docs.traceroot.ai", false)).toBe(
      `${GREY}https://docs.traceroot.ai${OFF}`,
    );
  });
});

describe("weight, when the terminal can show it", () => {
  it("makes an emphasised phrase bold", async () => {
    const { wizardEmphasis } = await import("../../src/setup/wizard.js");
    expect(wizardEmphasis("Continue?")).toBe(`${BOLD_ON}Continue?${BOLD_OFF}`);
  });

  it("leaves the text inside it exactly as it was given", async () => {
    // The characters a user copies must be the characters we were handed.
    // Colour is an attribute of the cell; anything that reflowed or bracketed
    // the string would change what a selection yields.
    const { wizardEmphasis } = await import("../../src/setup/wizard.js");
    const emphasised = wizardEmphasis("Continue?");
    expect(emphasised.replaceAll(BOLD_ON, "").replaceAll(BOLD_OFF, "")).toBe("Continue?");
  });
});

describe("wrapping beside the rail", () => {
  it("keeps a long line out of the rail column", async () => {
    // A terminal wrapping on its own puts the overflow in column zero, where
    // the rail lives, and the frame stops being a frame.
    const { wrapForRail } = await import("../../src/setup/wizard.js");
    const pieces = wrapForRail("alpha bravo charlie delta echo foxtrot", 20);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(20);
    }
    expect(pieces.join(" ")).toBe("alpha bravo charlie delta echo foxtrot");
  });

  it("re-applies a whole-line colour to every piece it produces", async () => {
    // The caveat under the production block is one grey sentence. Wrapped
    // naively it comes back grey on the first line and default on the rest.
    const { wrapForRail } = await import("../../src/setup/wizard.js");
    const pieces = wrapForRail(`${GREY}alpha bravo charlie delta${OFF}`, 12);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.startsWith(GREY)).toBe(true);
      expect(piece.endsWith(OFF)).toBe(true);
    }
  });

  it("measures what the eye sees, not what the bytes say", async () => {
    // Escapes occupy no cells. Counting them would wrap a line that fits.
    const { wrapForRail, wizardEnvVar } = await import("../../src/setup/wizard.js");
    expect(wrapForRail(`Set ${wizardEnvVar("TRACEROOT_API_KEY")} now`, 30)).toHaveLength(1);
  });

  it("lets a single long word overflow rather than breaking it", async () => {
    // A URL is something the user has to copy exactly. A break in the middle
    // of one is worse than a line that runs long.
    const { wrapForRail } = await import("../../src/setup/wizard.js");
    const url = "https://ui.example.test/projects/abc/traces?traceId=deadbeef";
    expect(wrapForRail(url, 20)).toEqual([url]);
  });
});

describe("the live line, where colour exists", () => {
  it("dims the transcript above the spinner but leaves the counter alone", async () => {
    // The contrast is the point: the transcript is a log of what already
    // happened, the live line is the one thing still moving, and the counter is
    // what tells a waiting user the run is not wedged. Asserted here because a
    // non-terminal sink is not coloured at all, so in the rest of the suite a
    // "not dimmed" claim would hold for any renderer.
    const { startLineSpinner } = await import("../../src/setup/spinner.js");

    let data = "";
    const out = {
      isTTY: true,
      write(chunk: string) {
        data += chunk;
        return true;
      },
    };
    let clock = 0;
    const ticks: Array<() => void> = [];
    const spinner = startLineSpinner({
      sink: out as never,
      message: "waiting for sign-in",
      env: { TERM: "xterm" } as NodeJS.ProcessEnv,
      now: () => clock,
      animate: (tick: () => void) => {
        ticks.push(tick);
        return () => undefined;
      },
    });
    spinner.writeAbove("run: ls");
    clock += 12_000;
    for (const fire of [...ticks]) {
      fire();
    }

    expect(data).toContain(" [12s]");
    expect(data).not.toContain(`${DIM}[12s]`);
    expect(data).not.toContain(`${DIM} [12s]`);
    expect(data).toContain(`${DIM}run: ls`);
  });
});
