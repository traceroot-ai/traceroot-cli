import { describe, expect, it } from "vitest";
import { createActivityParser, finalReply } from "../../src/setup/activity.js";
import { parseCompletion } from "../../src/setup/task.js";

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

describe("text the agent chose, rendered into the frame", () => {
  it("strips escape and bell bytes, which whitespace collapsing left through", () => {
    // These lines go into a framed, spinner-driven region, so an escape sequence
    // here rewrites the wizard's own output — and `\s` does not match ESC, BEL or
    // DEL, so collapsing whitespace let all three through untouched.
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const parse = createActivityParser();
    const lines = parse(toolUse("Bash", { command: `ls${ESC}[2J${BEL} -la` }));

    const rendered = lines.map((line) => line.detail).join(" ");
    expect(rendered).not.toContain(ESC);
    expect(rendered).not.toContain(BEL);
    expect(rendered).toContain("ls");
  });
});

describe("the reply the stream closes with", () => {
  /** A completion block, as the agent writes it at the end of its reply. */
  const reply = [
    "Instrumented the service and ran it once.",
    "",
    "```json traceroot-setup-result",
    "{",
    '  "files_changed": ["main.py", "pyproject.toml"],',
    '  "sdk_version": "0.6.0",',
    '  "service": ".",',
    '  "trace_id": null,',
    '  "tests_passed": true,',
    '  "notes": "Run it with: python main.py"',
    "}",
    "```",
    "",
    "Then `python main.py` runs it.",
  ].join("\n");

  /** What `claude -p --output-format stream-json --verbose` printed for a run, event by event. */
  const stream = [
    {
      type: "system",
      subtype: "init",
      cwd: "/repo",
      session_id: "s_1",
      tools: ["Bash", "Edit", "Read", "Write"],
      permissionMode: "acceptEdits",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "main.py" } },
        ],
      },
      session_id: "s_1",
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "print('hi')\n" }],
      },
      session_id: "s_1",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
      session_id: "s_1",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      result: reply,
      session_id: "s_1",
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  it("reads the report out of the closing event, where the raw stream hides it", () => {
    // Every event is one line, so the reply's newlines arrive as `\n` escapes
    // and the fence around the block is never followed by a real newline.
    expect(stream).not.toContain("traceroot-setup-result\n");
    expect(parseCompletion(stream)).toBeNull();

    expect(finalReply(`${stream}\n`)).toBe(reply);
    expect(parseCompletion(finalReply(stream) ?? "")).toEqual({
      filesChanged: ["main.py", "pyproject.toml"],
      sdkVersion: "0.6.0",
      traceId: null,
      notes: "Run it with: python main.py",
    });
  });

  it("has no reply to give for a stream that was cut off", () => {
    // Killed, timed out or truncated: the closing event never arrived, or
    // arrived as half a line. Either reads as an agent that wrote no block.
    const lines = stream.split("\n");
    const closing = lines.at(-1) ?? "";
    expect(finalReply(lines.slice(0, -1).join("\n"))).toBeNull();
    expect(
      finalReply([...lines.slice(0, -1), closing.slice(0, closing.length / 2)].join("\n")),
    ).toBeNull();
    expect(finalReply("")).toBeNull();
  });

  it("has no reply to give for a closing event of another shape", () => {
    // An error subtype closes the stream without a reply, and an older or newer
    // release may name the field differently. Neither is a reply.
    expect(
      finalReply(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })),
    ).toBeNull();
    expect(finalReply(JSON.stringify({ type: "result", result: { text: reply } }))).toBeNull();
  });

  it("reads past output that is not the stream", () => {
    // `runProcess` returns stdout and stderr as one string, so a warning the
    // agent printed can sit between the events.
    const mixed = ["warning: something on stderr", "{ broken json", stream, "[1, 2]"].join("\n");
    expect(finalReply(mixed)).toBe(reply);
  });

  it("takes the last closing event", () => {
    const second = JSON.stringify({ type: "result", subtype: "success", result: "second" });
    expect(finalReply(`${stream}\n${second}`)).toBe("second");
  });
});
