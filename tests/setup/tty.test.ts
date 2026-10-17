import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { waitForEnter } from "../../src/setup/tty.js";
import { fakeInput } from "./helpers.js";

/** Written out rather than embedded, so no control character reaches source. */
const CR = String.fromCharCode(13);

/** Long enough for the drain's `setImmediate` and a write after it to settle. */
function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("letting the user end a wait with a keypress", () => {
  it("calls back when a line is entered", async () => {
    const input = fakeInput();
    let pressed = 0;
    const stop = waitForEnter({
      input,
      onEnter: () => {
        pressed += 1;
      },
    });

    // After the drain has run, which is the window the next test is about.
    await settle();
    input.write(CR);
    await settle();
    stop();

    expect(pressed).toBe(1);
  });

  it("does not count a keystroke typed before the wait began", async () => {
    // The Enter pressed at the confirmation prompt several minutes ago is still
    // in the buffer, and attaching a reader hands it over on the next tick. A
    // wait that skipped itself before it was ever offered reads as the feature
    // being broken — see `discardTypeAhead`.
    const input = fakeInput();
    input.write(CR);
    input.write(CR);

    let pressed = 0;
    const stop = waitForEnter({
      input,
      onEnter: () => {
        pressed += 1;
      },
    });
    await settle();
    stop();

    expect(pressed).toBe(0);
  });

  it("still hears the keypress that comes after the backlog was dropped", async () => {
    // The other half: draining must not cost the keystroke the user made at the
    // wait they could actually see.
    const input = fakeInput();
    input.write(CR);

    let pressed = 0;
    const stop = waitForEnter({
      input,
      onEnter: () => {
        pressed += 1;
      },
    });
    await settle();
    input.write(CR);
    await settle();
    stop();

    expect(pressed).toBe(1);
  });

  it("fires once however much is typed", async () => {
    const input = fakeInput();
    let pressed = 0;
    const stop = waitForEnter({
      input,
      onEnter: () => {
        pressed += 1;
      },
    });

    await settle();
    input.write(`yes${CR}`);
    input.write(CR);
    await settle();
    stop();

    expect(pressed).toBe(1);
  });

  it("hears nothing more, and leaves the stream paused, after it is stopped", async () => {
    // The stage stops it in a `finally`, and this is why: a listener left on a
    // resumed stdin eats the keystrokes belonging to the two acknowledgements
    // that close the run.
    const input = fakeInput();
    let pressed = 0;
    const stop = waitForEnter({
      input,
      onEnter: () => {
        pressed += 1;
      },
    });

    await settle();
    stop();
    input.write(CR);
    await settle();

    expect(pressed).toBe(0);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("does nothing at all when there is no terminal to press a key at", async () => {
    // A pipe, a CI log, a `--json` consumer. There is nobody to press anything,
    // and resuming the stream would consume input belonging to whatever is on
    // the other end of it.
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    let pressed = 0;
    const stop = waitForEnter({
      input,
      onEnter: () => {
        pressed += 1;
      },
    });

    await settle();
    input.write(CR);
    await settle();
    stop();

    expect(pressed).toBe(0);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("does not fire for a key pressed after an immediate stop", async () => {
    // Stopped inside the window the drain is still open in: the listener must
    // never attach at all, rather than attaching behind the stop.
    const input = fakeInput();
    let pressed = 0;
    waitForEnter({
      input,
      onEnter: () => {
        pressed += 1;
      },
    })();

    await settle();
    input.write(CR);
    await settle();

    expect(pressed).toBe(0);
  });
});
