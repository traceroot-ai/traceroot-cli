import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { sleep } from "../src/util/sleep.js";

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const began = Date.now();
    await sleep(25);
    expect(Date.now() - began).toBeGreaterThanOrEqual(20);
  });

  it("resolves as soon as the signal aborts, rather than waiting out the delay", async () => {
    const controller = new AbortController();
    const began = Date.now();
    const waiting = sleep(10_000, controller.signal);
    controller.abort();
    await waiting;
    // The copy in `deviceFlow` took no signal at all, so a cancelled sign-in
    // sat out its whole poll interval before noticing. 10s, not 25ms: a wait
    // that merely *finished* would put this assertion well past it.
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it("leaves no listener behind once the timer has fired", async () => {
    const controller = new AbortController();
    // A poll loop sleeps against one signal for the whole run. One abandoned
    // listener per iteration is how a long wait earns a max-listeners warning.
    for (let i = 0; i < 12; i += 1) {
      await sleep(1, controller.signal);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
