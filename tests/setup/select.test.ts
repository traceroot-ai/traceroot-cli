import { describe, expect, it, vi } from "vitest";
import { fakeInput, fakeOutput } from "./helpers.js";

/**
 * What the wrapper actually asks clack for.
 *
 * Driven through `selectFrom`, the seam `interactiveSelect` exists to expose, so
 * the prompt is handed a pair of fake streams rather than the process's real
 * stdin. Standing in for clack's `select` is still what makes the options it
 * builds observable.
 */
const CANCELLED_SENTINEL = vi.hoisted(() => Symbol("test:interrupted"));

const clack = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  // Set for one call to make clack answer the way Ctrl+C does.
  cancelNext: false,
}));

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    // `isCancel` is widened rather than replaced: clack's own sentinel is a
    // bare `Symbol()`, not `Symbol.for()`, so a separately imported copy of
    // `@clack/core` carries a different instance and the real `isCancel` would
    // not recognise it. Injecting the condition at this seam keeps what is
    // under test as the thing worth testing — which error code the wrapper
    // raises when a prompt is interrupted — while clack's own detection stays
    // clack's to test.
    isCancel: (value: unknown) => value === CANCELLED_SENTINEL || actual.isCancel(value),
    select: async (opts: Record<string, unknown>) => {
      clack.calls.push(opts);
      if (clack.cancelNext) return CANCELLED_SENTINEL;
      const options = opts.options as Array<{ value: string }>;
      return opts.initialValue ?? options[0]?.value;
    },
  };
});

describe("the interactive selector", () => {
  it("reports Ctrl+C as an interrupt rather than a decline", async () => {
    // The distinction is the exit status, and it is the whole point of having
    // two codes: declining is a decision and exits 0, so
    // `traceroot setup && <next step>` proceeds. An interrupt must not, or the
    // keypress meant to stop the chain is the one thing that does not stop it.
    // `isCancel` is clack's Ctrl+C and Escape only, so this branch is never an
    // explicit no — a decline comes back as a value and the caller checks it.
    const { selectFrom } = await import("../../src/setup/select.js");
    const { SETUP_EXIT_CODES } = await import("../../src/setup/errors.js");

    clack.cancelNext = true;
    try {
      const run = selectFrom(
        {
          stage: "precheck",
          message: "pick one",
          options: [{ value: "a", label: "A" }],
        },
        { input: fakeInput(), output: fakeOutput() },
      );
      await expect(run).rejects.toMatchObject({ code: "INTERRUPTED" });
    } finally {
      clack.cancelNext = false;
    }

    // Pinned together: the pair is only meaningful as a pair.
    expect(SETUP_EXIT_CODES.INTERRUPTED).toBe(130);
    expect(SETUP_EXIT_CODES.CANCELLED).toBe(0);
  });

  it("turns off clack's navigation caption", async () => {
    // "↑/↓ to navigate · Enter: confirm" under every question in the run, for
    // keys that have worked this way in every terminal list for decades. The
    // line it costs competes with the ones that say what the choice does.
    const { selectFrom } = await import("../../src/setup/select.js");

    const chosen = await selectFrom(
      {
        stage: "select_agent",
        message: "How should TraceRoot be added to this service?",
        options: [
          { value: "task-file", label: "Write the task — I'll run my own agent", hint: "no edits" },
          { value: "manual", label: "Show me manual instructions", hint: "no edits" },
        ],
      },
      { input: fakeInput(), output: fakeOutput() },
    );

    expect(chosen).toBe("task-file");
    expect(clack.calls.at(-1)?.showInstructions).toBe(false);
  });
});
