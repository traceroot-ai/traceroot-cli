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
const clack = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    select: async (opts: Record<string, unknown>) => {
      clack.calls.push(opts);
      const options = opts.options as Array<{ value: string }>;
      return opts.initialValue ?? options[0]?.value;
    },
  };
});

describe("the interactive selector", () => {
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
