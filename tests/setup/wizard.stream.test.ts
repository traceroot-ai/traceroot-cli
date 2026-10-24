import { afterEach, describe, expect, it, vi } from "vitest";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const AQUA = `${ESC}[96m`;
const GREY = `${ESC}[38;5;245m`;

/**
 * Both process streams, stated per test rather than read off the host.
 *
 * Which stream colour is decided from is the whole subject of this file, so
 * neither of them may be whatever the runner happened to be started with. A
 * suite that asserted stdout was *not* a terminal passed under a CI runner and
 * failed on a developer's terminal, and in neither case was the thing it
 * failed or passed on a property of the renderer.
 */
const stdout = process.stdout as unknown as { isTTY?: boolean };
const stderr = process.stderr as unknown as { isTTY?: boolean };
const wasStdout = stdout.isTTY;
const wasStderr = stderr.isTTY;

// Put back whatever they were: `process` outlives a test file, and a stderr
// left claiming to be a terminal would change what the next file's renderers
// emit.
afterEach(() => {
  stdout.isTTY = wasStdout;
  stderr.isTTY = wasStderr;
  vi.unstubAllEnvs();
});

type Wizard = typeof import("../../src/setup/wizard.js");

/**
 * The wizard, with both process streams stated, the environment's own colour
 * opt-outs cleared, and the module evaluated again.
 *
 * The re-evaluation is deliberate even though nothing in the module latches a
 * palette any more: it pins the answer a latched one *would* have reached. A
 * renderer that consults `process.stderr` rather than the sink it writes to
 * therefore fails the cases below whichever way the host's own stderr points.
 */
async function wizardWritingTo(streams: { stderr: boolean; stdout: boolean }): Promise<Wizard> {
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("NO_COLOR", undefined);
  stderr.isTTY = streams.stderr;
  stdout.isTTY = streams.stdout;
  vi.resetModules();
  return await import("../../src/setup/wizard.js");
}

/** Writers for a renderer, over a sink that says whether it is a terminal. */
function writersOn(terminal: boolean): { writers: Writers; err: StringSink } {
  const err = new StringSink(terminal);
  return { writers: { out: new StringSink(), err }, err };
}

describe("the stream a span's colour is decided from", () => {
  it("paints when stderr is a terminal, whatever stdout is", async () => {
    // picocolors' default instance decides from *stdout*, and once: a frame
    // drawn on the terminal went plain the moment stdout was redirected
    // somewhere else, which is the case a stated non-terminal stdout pins.
    const { wizardEmphasis } = await wizardWritingTo({ stderr: true, stdout: false });

    expect(wizardEmphasis("instrument")).toContain(BOLD);
  });

  it("writes nothing but text when stderr is not a terminal", async () => {
    // The other direction, and the one a forced colour in the environment used
    // to win: the default instance painted a frame that was on its way into a
    // file, so `traceroot setup 2> setup.log` filled the log with escape codes.
    const { wizardAside, wizardEmphasis, wizardValue } = await wizardWritingTo({
      stderr: false,
      stdout: true,
    });

    for (const text of [wizardEmphasis("x"), wizardValue("demo"), wizardAside("note")]) {
      expect(text).not.toContain(ESC);
    }
  });
});

describe("the sink a renderer was handed", () => {
  it("paints a frame drawn on a terminal sink while stderr is a file", async () => {
    // Every renderer here writes through the `writers.err` it was given, which
    // is `process.stderr` in production and a capture, a log file or a second
    // terminal anywhere else. A palette keyed to the process stream got this
    // case exactly backwards, with nothing in the output to say why.
    const { wizardIntro, wizardNote } = await wizardWritingTo({ stderr: false, stdout: false });
    const { writers, err } = writersOn(true);

    wizardIntro(writers);
    wizardNote(writers, ["Choose how to instrument"]);

    expect(err.data).toContain(BOLD);
    expect(err.data).toContain(DIM);
  });

  it("writes no escapes to a plain sink while stderr is a terminal", async () => {
    const { wizardIntro, wizardNote } = await wizardWritingTo({ stderr: true, stdout: true });
    const { writers, err } = writersOn(false);

    wizardIntro(writers);
    wizardNote(writers, ["Choose how to instrument"]);

    expect(err.data).not.toContain(ESC);
  });

  it("takes the closing block's own links and asides from the sink too", async () => {
    // The roles a renderer composes for itself are the half of this that a
    // palette threaded only as far as the rail would still get wrong.
    const { wizardOutro } = await wizardWritingTo({ stderr: false, stdout: false });
    const { writers, err } = writersOn(true);

    wizardOutro(writers, "Setup complete.");

    expect(err.data).toContain(AQUA);
    expect(err.data).toContain(GREY);
  });
});
