import { describe, expect, it } from "vitest";
import { createActivityParser } from "../../src/setup/activity.js";

/** One line of Claude Code's `--output-format stream-json` feed. */
function toolUse(name: string, input: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  })}\n`;
}

describe("what the feed shows", () => {
  it("renders a command, a read and a write, one line each", () => {
    const parse = createActivityParser();
    const lines = [
      ...parse(toolUse("Bash", { command: "ls -la /repo" })),
      ...parse(toolUse("Read", { file_path: "barebone.py" })),
      ...parse(toolUse("Write", { file_path: "test.py" })),
    ];

    expect(lines).toEqual([
      { verb: "run", detail: "ls -la /repo" },
      { verb: "read", detail: "barebone.py" },
      { verb: "write", detail: "test.py" },
    ]);
  });

  it("treats every editing tool as a write", () => {
    const parse = createActivityParser();
    for (const name of ["Edit", "MultiEdit", "NotebookEdit"]) {
      const [line] = parse(toolUse(name, { file_path: "main.py" }));
      expect(line?.verb).toBe("write");
    }
  });

  it("says nothing about tools with nothing worth showing", () => {
    // A feed that narrates every internal step is as unreadable as no feed.
    const parse = createActivityParser();
    expect(parse(toolUse("TodoWrite", { todos: [] }))).toEqual([]);
    expect(parse(toolUse("Bash", {}))).toEqual([]);
  });

  it("flattens and truncates a long command so one call cannot fill the screen", () => {
    const parse = createActivityParser();
    const [line] = parse(toolUse("Bash", { command: `echo ${"x".repeat(300)}\n  continued` }));

    expect(line?.detail.length).toBeLessThanOrEqual(96);
    expect(line?.detail).toContain("...");
    expect(line?.detail).not.toContain("\n");
  });
});

describe("surviving a stream we do not control", () => {
  it("reassembles a tool call split across chunks", () => {
    // Process output arrives in arbitrary chunks, not neat lines.
    const parse = createActivityParser();
    const whole = toolUse("Read", { file_path: "split.py" });
    const cut = Math.floor(whole.length / 2);

    expect(parse(whole.slice(0, cut))).toEqual([]);
    expect(parse(whole.slice(cut))).toEqual([{ verb: "read", detail: "split.py" }]);
  });

  it("ignores anything that is not the shape it expects", () => {
    // This is somebody else's debugging affordance, not a contract we own. A
    // changed shape must cost a feed line, never the run.
    const parse = createActivityParser();
    expect(parse("not json at all\n")).toEqual([]);
    expect(parse("{ broken json\n")).toEqual([]);
    expect(parse(`${JSON.stringify({ type: "system" })}\n`)).toEqual([]);
    expect(parse(`${JSON.stringify({ message: { content: "text" } })}\n`)).toEqual([]);
    expect(parse(`${JSON.stringify({ message: { content: [{ type: "text" }] } })}\n`)).toEqual([]);
  });

  it("keeps working after a bad line", () => {
    const parse = createActivityParser();
    parse("garbage\n");
    expect(parse(toolUse("Write", { file_path: "after.py" }))).toEqual([
      { verb: "write", detail: "after.py" },
    ]);
  });
});
