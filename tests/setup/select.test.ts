import { describe, expect, it, vi } from "vitest";

/**
 * What the wrapper actually asks clack for.
 *
 * `interactiveSelect` talks to a real terminal, so the only way to see the
 * options it builds is to stand in for the prompt itself.
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
    const { interactiveSelect } = await import("../../src/setup/select.js");

    const chosen = await interactiveSelect({
      stage: "select_agent",
      message: "How should TraceRoot be added to this service?",
      options: [
        { value: "task-file", label: "Write the task — I'll run my own agent", hint: "no edits" },
        { value: "manual", label: "Show me manual instructions", hint: "no edits" },
      ],
    });

    expect(chosen).toBe("task-file");
    expect(clack.calls.at(-1)?.showInstructions).toBe(false);
  });
});
