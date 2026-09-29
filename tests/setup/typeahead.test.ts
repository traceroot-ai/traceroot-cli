import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { selectFrom } from "../../src/setup/select.js";

/**
 * The double-Enter that started a coding agent nobody had said yes to.
 *
 * Unlike every other test of the wizard's prompts, this one does NOT inject a
 * fake `select` — the bug lives underneath that seam, in what the terminal does
 * with a keystroke typed while no question is on screen. So it drives the real
 * clack prompt against a fake TTY and types at it, because a stub would answer
 * whatever it was asked and prove nothing at all.
 */

/** Written out rather than embedded, so no control character reaches source. */
const CR = String.fromCharCode(13);

/** A stream clack will treat as a terminal it can read keystrokes from. */
function fakeInput(): PassThrough & { isTTY: boolean; setRawMode: () => unknown } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => unknown;
  };
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  return stream;
}

/** Somewhere for the prompt to draw that no test ever reads. */
function fakeOutput(): PassThrough {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
  stream.isTTY = true;
  stream.columns = 80;
  stream.on("data", () => {
    // drained so the stream never fills
  });
  return stream;
}

const method = {
  stage: "select_agent",
  message: "How should TraceRoot be added to this service?",
  options: [
    { value: "agent:claude", label: "Run Claude Code for me" },
    { value: "task-file", label: "Write the task" },
  ],
} as const;

const gate = {
  stage: "instrument",
  message: "Setup will now run Claude Code with permission to edit files. Proceed?",
  options: [
    { value: "confirm", label: "Confirm" },
    { value: "abort", label: "Abort" },
  ],
  initialValue: "confirm",
} as const;

/**
 * Asks the two questions the wizard asks in a row, with a gap between them
 * standing in for the work the machine really does there (installing the skill,
 * resolving the SDK version). Returns what got answered, so a gate that was
 * never reached is visible as an absence rather than as a hang.
 */
async function askBoth(type: (write: (data: string) => void) => void): Promise<string[]> {
  const input = fakeInput();
  const output = fakeOutput();
  const terminal = { input, output };
  const answered: string[] = [];

  const flow = (async () => {
    answered.push(await selectFrom({ ...method, options: [...method.options] }, terminal));
    await new Promise((resolve) => setTimeout(resolve, 120));
    answered.push(await selectFrom({ ...gate, options: [...gate.options] }, terminal));
  })();

  type((data) => input.write(data));

  // Long enough that a gate which was going to be answered has been.
  await Promise.race([flow, new Promise((resolve) => setTimeout(resolve, 600))]);
  return answered;
}

describe("a keystroke typed before the question was asked", () => {
  it("does not answer the gate in front of the coding agent", async () => {
    // The reported bug, exactly: choose "run an agent", press Enter once more
    // out of momentum, and the second Enter was handed to the confirmation
    // whose default is Confirm — so an LLM began editing the repository with
    // the one prompt that exists to be deliberated over never having been read.
    const answered = await askBoth((write) => {
      setTimeout(() => write(CR), 40);
      setTimeout(() => write(CR), 45);
    });

    expect(answered).toEqual(["agent:claude"]);
  });

  it("still lets the answer through once the question is up", async () => {
    // The other half of the fix, and the one that would catch an over-eager
    // drain: discarding type-ahead must not cost a keystroke the user made at a
    // prompt they could actually see.
    const answered = await askBoth((write) => {
      setTimeout(() => write(CR), 40);
      setTimeout(() => write(CR), 300);
    });

    expect(answered).toEqual(["agent:claude", "confirm"]);
  });

  it("recovers when the user double-tapped and then answered for real", async () => {
    // A discarded keystroke must leave nothing behind that swallows the next
    // one too.
    const answered = await askBoth((write) => {
      setTimeout(() => write(CR), 40);
      setTimeout(() => write(CR), 45);
      setTimeout(() => write(CR), 300);
    });

    expect(answered).toEqual(["agent:claude", "confirm"]);
  });
});
