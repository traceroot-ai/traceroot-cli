import { describe, expect, it } from "vitest";
import type { Writers } from "../../src/output.js";
import {
  WIZARD_TITLE,
  hyperlinksSupported,
  wizardAcknowledgement,
  wizardAside,
  wizardEmphasis,
  wizardEnvVar,
  wizardIntro,
  wizardLine,
  wizardLink,
  wizardOutro,
  wizardProgress,
  wizardWarn,
} from "../../src/setup/wizard.js";
import { StringSink } from "../helpers/stringSink.js";

function target(json = false): { writers: Writers; json: boolean; err: StringSink } {
  const err = new StringSink();
  return { writers: { out: new StringSink(), err }, json, err };
}

/** Every glyph that legitimately opens a line inside the wizard's frame. */
const IN_FRAME = /^[│┌└◇◆▲■]/u;

describe("lines inside the frame", () => {
  it("puts a status line on the rail", () => {
    // The fault this fixes: "Signed in as a returning user — project …" was
    // printed bare, so a sentence about the wizard fell outside its own frame.
    const t = target();
    wizardLine(t, "Signed in as a returning user — project my-llm-project. No browser needed.");
    expect(t.err.data).toBe(
      "│  Signed in as a returning user — project my-llm-project. No browser needed.\n",
    );
  });

  it("rails every line of a multi-line message, blank lines included", () => {
    const t = target();
    wizardLine(
      t,
      "\nWrote the task to .traceroot/prompts/setup-instrument.md.\nRun it, then resume.",
    );
    expect(t.err.data.split("\n").slice(0, -1)).toEqual([
      "│",
      "│  Wrote the task to .traceroot/prompts/setup-instrument.md.",
      "│  Run it, then resume.",
    ]);
  });

  it("gives a warning its own glyph and still keeps it on the rail", () => {
    const t = target();
    wizardWarn(t, "`claude` was not found on PATH");
    expect(t.err.data).toBe("▲  warning: `claude` was not found on PATH\n");
  });

  it("dims progress without moving it off the rail", () => {
    const t = target();
    wizardProgress(t, "Wrote TRACEROOT_API_KEY to .env.traceroot (0600).");
    expect(t.err.data).toBe("│  Wrote TRACEROOT_API_KEY to .env.traceroot (0600).\n");
  });

  it("leaves nothing loose between the opening and closing lines", () => {
    const t = target();
    wizardIntro(t.writers);
    wizardLine(t, "Signed in — workspace acme.");
    wizardProgress(t, "Service: . (python)");
    wizardWarn(t, "no test or health command was detected");
    wizardOutro(t.writers, "TraceRoot setup complete.");

    const framed = t.err.data.slice(0, t.err.data.indexOf("└"));
    for (const line of framed.split("\n").filter((l) => l !== "")) {
      expect(line).toMatch(IN_FRAME);
    }
    expect(t.err.data).toContain(`┌  ${WIZARD_TITLE}`);
    expect(t.err.data).toContain("└  TraceRoot setup complete.");
  });
});

describe("colour", () => {
  it("never changes the characters, only how they are drawn", () => {
    // Everything under `NO_COLOR`, a pipe or `TERM=dumb` — which is what these
    // tests run as — must come out as the text itself. A helper that wrapped a
    // URL in brackets or reflowed a sentence would break copy-paste for every
    // user who has colour turned off, and silently invalidate every wording
    // assertion in this suite.
    expect(wizardLink("https://docs.traceroot.ai")).toBe("https://docs.traceroot.ai");
    expect(wizardEnvVar("TRACEROOT_API_KEY")).toBe("TRACEROOT_API_KEY");
    expect(wizardAside("supporting detail")).toBe("supporting detail");
    expect(wizardEmphasis("TRACEROOT_API_KEY")).toBe("TRACEROOT_API_KEY");
  });

  it("continues the rail through an acknowledgement", () => {
    // The rail, not a marker and not a blank. A marker is how every other
    // line says "a new thing starts here", and these do the opposite — they
    // close the block above them. But three spaces stopped the frame's
    // vertical line for two rows, which reads as the block ending early.
    expect(wizardAcknowledgement("I have added TRACEROOT_API_KEY to my production env.")).toBe(
      "│  I have added TRACEROOT_API_KEY to my production env.  (Press Enter to continue)",
    );
  });
});

describe("clickable links", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const URL = "https://api.example.test/cli/pair?c=740406";

  it("wraps the URL in OSC 8 without replacing it", () => {
    // The text inside the wrapper is the URL, not a label. A terminal that
    // renders the link gives something to click; every other one, and every
    // mouse selection, still yields the URL itself.
    expect(wizardLink(URL, true)).toBe(`${ESC}]8;;${URL}${BEL}${URL}${ESC}]8;;${BEL}`);
  });

  it("is the bare URL wherever the sequence would not be understood", () => {
    // An unsupported terminal does not ignore OSC 8 — it prints the bytes into
    // the scrollback, over the one line of the run a user has to copy.
    expect(wizardLink(URL, false)).toBe(URL);
  });

  describe("and where they are attempted", () => {
    const tty = { isTTY: true };
    const notTty = { isTTY: false };

    it("needs a cursor to write to", () => {
      expect(hyperlinksSupported({ TERM_PROGRAM: "iTerm.app" }, notTty)).toBe(false);
    });

    it("takes the terminal at its word, and only the ones that implement it", () => {
      expect(hyperlinksSupported({ TERM_PROGRAM: "iTerm.app" }, tty)).toBe(true);
      expect(hyperlinksSupported({ TERM: "xterm-kitty" }, tty)).toBe(true);
      expect(hyperlinksSupported({ VTE_VERSION: "6003" }, tty)).toBe(true);
      // Apple's Terminal.app says what it is and does not implement OSC 8.
      expect(hyperlinksSupported({ TERM_PROGRAM: "Apple_Terminal" }, tty)).toBe(false);
      expect(hyperlinksSupported({ VTE_VERSION: "4600" }, tty)).toBe(false);
      expect(hyperlinksSupported({}, tty)).toBe(false);
    });

    it("honours the ways a user says 'plain text, please'", () => {
      expect(hyperlinksSupported({ TERM_PROGRAM: "iTerm.app", NO_COLOR: "1" }, tty)).toBe(false);
      expect(hyperlinksSupported({ TERM_PROGRAM: "iTerm.app", TERM: "dumb" }, tty)).toBe(false);
      // A CI log is read as a file later, whatever the runner claims to be.
      expect(hyperlinksSupported({ TERM_PROGRAM: "iTerm.app", CI: "true" }, tty)).toBe(false);
    });

    it("lets a terminal we have not heard of opt in", () => {
      expect(hyperlinksSupported({ FORCE_HYPERLINK: "1" }, notTty)).toBe(true);
      expect(hyperlinksSupported({ FORCE_HYPERLINK: "0" }, tty)).toBe(false);
    });
  });
});

describe("what is said after the frame closes", () => {
  it("puts the support and docs links outside it, unrailed", () => {
    // The frame is the wizard, and the wizard has ended. Drawing these inside a
    // box that just closed makes them read as one more step of a flow that is
    // over — which is exactly what they are not.
    const t = target();
    wizardOutro(t.writers, "TraceRoot setup complete.", {
      closing: "You can now use TraceRoot in production.",
    });

    const after = t.err.data.split("└  TraceRoot setup complete.\n")[1] ?? "";
    expect(after.split("\n").filter((l) => l !== "")).toEqual([
      "You can now use TraceRoot in production.",
      "If you ran into anything during setup, please open an issue at https://github.com/traceroot-ai/traceroot-cli/issues/new",
      "- Contact support: https://discord.gg/TM2m3CtKuC",
      "- Further documentation: https://docs.traceroot.ai",
    ]);
  });

  it("leaves a blank line for the shell prompt to land on", () => {
    // A prompt flush against the last bullet reads as one more line of the
    // wizard's output, and the run's last word ends up looking like an argument
    // somebody typed.
    const t = target();
    wizardOutro(t.writers, "TraceRoot setup complete.");

    expect(t.err.data.endsWith("\n\n")).toBe(true);
    expect(t.err.data.endsWith("\n\n\n")).toBe(false);
  });

  it("withholds the closing sentence from a run that did not earn it", () => {
    // "You can now use TraceRoot in production" over a run that stopped at the
    // agent is a claim the user finds out is false later.
    const t = target();
    wizardOutro(t.writers, "Setup stopped at: instrument the application.");

    expect(t.err.data).not.toContain("You can now use TraceRoot");
    // Where to get help is worth more at the end of a failure than a success.
    expect(t.err.data).toContain("please open an issue at");
    expect(t.err.data).toContain("- Contact support:");
  });
});

describe("where no frame was ever drawn", () => {
  it("writes plain diagnostics under --json", () => {
    // stdout is an event stream and stderr is a log; a rail there decorates
    // nothing and would be noise in whatever consumes it.
    const t = target(true);
    wizardLine(t, "Signed in — workspace acme.");
    wizardProgress(t, "Service: . (python)");
    wizardWarn(t, "no test command was detected");

    expect(t.err.data).toBe(
      [
        "Signed in — workspace acme.",
        "Service: . (python)",
        "warning: no test command was detected",
        "",
      ].join("\n"),
    );
    expect(t.err.data).not.toContain("│");
  });
});
