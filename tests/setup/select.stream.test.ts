import { afterEach, describe, expect, it, vi } from "vitest";
import { interactiveSelect } from "../../src/setup/select.js";
import { fakeInput } from "./helpers.js";

/**
 * Which stream the wizard's questions are drawn on.
 *
 * Drives `interactiveSelect` itself, against the real clack prompt, with the
 * process's own streams captured. The defect was the stream the selector was
 * wired to, which no test that hands `selectFrom` its own pair of streams can
 * see.
 */

/** Written out rather than embedded, so no control character reaches source. */
const CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);

const question = {
  stage: "select_agent",
  message: "How should TraceRoot be added to this service?",
  options: [
    { value: "task-file", label: "Write the task — I'll run my own agent" },
    { value: "manual", label: "Show me manual instructions" },
  ],
} as const;

/** Both process streams recorded instead of written, and a terminal to type at. */
function processTerminal() {
  const written = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    written.stderr += String(chunk);
    return true;
  });
  const input = fakeInput();
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  return { written, type: (data: string) => setTimeout(() => input.write(data), 40) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the stream the wizard asks its questions on", () => {
  it("is stderr, with the frame, so a redirected stdout cannot take the question", async () => {
    // `traceroot setup > setup.log` used to send the question and its options
    // into the log while the frame stayed on screen: the rail stopped, and the
    // first keypress answered a question the user never saw.
    const { written, type } = processTerminal();

    const answer = interactiveSelect({ ...question, options: [...question.options] });
    type(CR);

    await expect(answer).resolves.toBe("task-file");
    expect(written.stderr).toContain(question.message);
    expect(written.stdout).toBe("");
  });

  it("closes an interrupted question on stderr too", async () => {
    // clack's `cancel` defaults to stdout, which put the frame's closing line
    // into the stream the `--json` events own, apart from the frame it closes.
    const { written, type } = processTerminal();

    const answer = interactiveSelect({ ...question, options: [...question.options] });
    type(CTRL_C);

    await expect(answer).rejects.toMatchObject({ code: "INTERRUPTED" });
    expect(written.stderr).toContain("Setup interrupted.");
    expect(written.stdout).toBe("");
  });
});
