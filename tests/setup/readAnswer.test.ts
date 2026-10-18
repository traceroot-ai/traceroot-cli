import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SETUP_EXIT_CODES, SetupError } from "../../src/setup/errors.js";
import { defaultSetupDeps, readAnswer } from "../../src/setup/machine.js";
import { authEmpty, fakeInput } from "./helpers.js";

/**
 * A terminal the test types into and reads back, driven through `readAnswer`
 * the way `selectFrom` is driven in `select.test.ts`: with a pair of streams
 * rather than the process's own.
 */
function terminal(): {
  input: ReturnType<typeof fakeInput>;
  output: PassThrough;
  screen: () => string;
} {
  const input = fakeInput();
  const output = new PassThrough();
  let screen = "";
  output.on("data", (chunk) => {
    screen += String(chunk);
  });
  return { input, output, screen: () => screen };
}

/**
 * Waits until the question is on screen. A keystroke sent before then would be
 * thrown away as type-ahead, which is the drain doing its job.
 */
async function asked(t: ReturnType<typeof terminal>, question: string): Promise<void> {
  while (!t.screen().includes(question)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Whether a promise has settled after the event loop has had a few turns. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return settled;
}

const isInterruptAt = (stage: string) => (err: unknown) => {
  expect(err).toBeInstanceOf(SetupError);
  expect((err as SetupError).code).toBe("INTERRUPTED");
  expect((err as SetupError).stage).toBe(stage);
  // The shell's own number for a process ended by SIGINT, so that
  // `traceroot setup && <next step>` stops at the keypress.
  expect((err as SetupError).exitCode).toBe(SETUP_EXIT_CODES.INTERRUPTED);
  expect(SETUP_EXIT_CODES.INTERRUPTED).toBe(130);
  return true;
};

describe("a typed answer", () => {
  for (const masked of [false, true]) {
    it(`raises INTERRUPTED for its stage on Ctrl+C${masked ? ", masked" : ""}`, async () => {
      // Readline closed on the keypress and the question never settled, so the
      // event loop drained and the run ended with exit 0.
      const t = terminal();
      const answer = readAnswer(t, "New project name [repo]: ", {
        stage: "select_context",
        masked,
      });
      await asked(t, "New project name");

      t.input.write("\x03");

      await expect(answer).rejects.toSatisfy(isInterruptAt("select_context"));
    });
  }

  it("still returns what was typed", async () => {
    const t = terminal();
    const answer = readAnswer(t, "New project name [repo]: ", { stage: "authenticate" });
    await asked(t, "New project name");

    t.input.write("my-project\r");

    await expect(answer).resolves.toBe("my-project");
  });

  it("still keeps a masked answer off the screen", async () => {
    const t = terminal();
    const answer = readAnswer(t, "TraceRoot API key: ", { stage: "authenticate", masked: true });
    await asked(t, "TraceRoot API key: ");

    t.input.write("tr-secret-value\r");

    await expect(answer).resolves.toBe("tr-secret-value");
    expect(t.screen()).not.toContain("tr-secret-value");
    expect(t.screen()).toContain("*");
  });

  it("leaves a question asked outside the pipeline as `readLine` has it", async () => {
    // A question that names no stage: Ctrl+C still closes it without an answer.
    const t = terminal();
    const answer = readAnswer(t, "Press Enter: ");
    await asked(t, "Press Enter: ");

    t.input.write("\x03");

    expect(await settledSoon(answer)).toBe(false);
  });

  it("is what the production prompts read through, with the stage the machine hands them", async () => {
    const t = terminal();
    const stdin = vi
      .spyOn(process, "stdin", "get")
      .mockReturnValue(t.input as unknown as typeof process.stdin);
    const stdout = vi
      .spyOn(process, "stdout", "get")
      .mockReturnValue(t.output as unknown as typeof process.stdout);
    try {
      const deps = defaultSetupDeps(authEmpty());

      const key = deps.promptHidden("TraceRoot API key: ", "authenticate");
      await asked(t, "TraceRoot API key: ");
      t.input.write("\x03");
      await expect(key).rejects.toSatisfy(isInterruptAt("authenticate"));

      const name = deps.prompt("New project name [repo]: ", "select_context");
      await asked(t, "New project name");
      t.input.write("\x03");
      await expect(name).rejects.toSatisfy(isInterruptAt("select_context"));
    } finally {
      stdin.mockRestore();
      stdout.mockRestore();
    }
  });
});
