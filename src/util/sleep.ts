/**
 * Resolves after `ms`, or as soon as `signal` aborts — whichever is first.
 *
 * The one timer in the CLI. Every poll loop wants the same two things: a delay,
 * and a cancellation that cuts the delay short rather than leaving an abandoned
 * run to finish its last wait. This had been written out three times — in the
 * device flow, in the trace poll, and in setup's production wiring — and the
 * copies had already drifted: one of them had no `signal` at all, so a
 * cancelled sign-in sat out a full poll interval before noticing.
 *
 * Resolves rather than rejects on abort. The callers all re-check their own
 * stopping condition at the top of the loop, and they want the reason they
 * stopped to come from that check — a rejection here would make every `await`
 * a try/catch for a case that is not an error.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // The listener is dropped once the timer has fired, so a loop that sleeps
    // many times against one long-lived signal does not accumulate one dead
    // listener per iteration (and trip Node's max-listeners warning).
    const onAbort = (): void => {
      clearTimeout(handle);
      resolve();
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
