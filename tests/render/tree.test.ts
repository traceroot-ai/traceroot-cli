import { describe, expect, it } from "vitest";
import { type SpanLike, renderTree, truncate } from "../../src/render/tree.js";

function span(partial: Partial<SpanLike> & { span_id: string }): SpanLike {
  return {
    parent_span_id: null,
    name: partial.span_id,
    span_start_time: "2024-01-01T00:00:00Z",
    span_end_time: "2024-01-01T00:00:01Z",
    ...partial,
  };
}

describe("renderTree", () => {
  it("colors an error span red only when color is enabled", () => {
    const spans = [
      span({ span_id: "ok", name: "ok-span", status: "OK" }),
      span({ span_id: "bad", parent_span_id: "ok", name: "bad-span", status: "ERROR" }),
    ];
    // No color by default: no ANSI escapes at all.
    expect(renderTree(spans)).not.toContain("\x1b[");
    // With color: the error line is wrapped in red, the ok line is not.
    const colored = renderTree(spans, { color: true }).split("\n");
    const badLine = colored.find((l) => l.includes("bad-span")) as string;
    const okLine = colored.find((l) => l.includes("ok-span")) as string;
    expect(badLine).toContain("\x1b[91m");
    expect(okLine).not.toContain("\x1b[91m");
  });

  it("nests a child under its parent via parent_span_id", () => {
    const out = renderTree([
      span({ span_id: "root", name: "root" }),
      span({ span_id: "child", parent_span_id: "root", name: "child" }),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toContain("root");
    // The child appears after the root and is indented (not at column 0).
    const childLine = lines.find((l) => l.includes("child"));
    expect(childLine).toBeDefined();
    expect((childLine as string).indexOf("child")).toBeGreaterThan(0);
  });

  it("renders multiple roots", () => {
    const out = renderTree([
      span({ span_id: "a", name: "rootA" }),
      span({ span_id: "b", name: "rootB" }),
    ]);
    expect(out).toContain("rootA");
    expect(out).toContain("rootB");
  });

  it("treats an orphan whose parent is not in the set as a root", () => {
    const out = renderTree([span({ span_id: "x", parent_span_id: "missing", name: "orphan" })]);
    const lines = out.split("\n");
    // Rendered as a root: name appears at the start of its line (after the tree
    // connector for a single root, which is at column 0).
    expect(out).toContain("orphan");
    expect(lines).toHaveLength(1);
  });

  it("orders siblings deterministically by start time", () => {
    const out = renderTree([
      span({ span_id: "late", name: "late", span_start_time: "2024-01-01T00:00:02Z" }),
      span({ span_id: "early", name: "early", span_start_time: "2024-01-01T00:00:01Z" }),
    ]);
    expect(out.indexOf("early")).toBeLessThan(out.indexOf("late"));
  });

  it("shows a status marker for an errored span", () => {
    const out = renderTree([span({ span_id: "r", name: "r", status: "ERROR" })]);
    // Some non-empty visible marker distinguishes an error span from the name.
    expect(out).toContain("r");
    expect(out.length).toBeGreaterThan("r".length);
  });

  it("handles an empty span list", () => {
    expect(renderTree([])).toBe("");
  });

  it("renders cyclic span data without hanging or dropping spans", () => {
    // Malformed external data: A and B reference each other as parents.
    const out = renderTree([
      span({ span_id: "A", parent_span_id: "B", name: "A" }),
      span({ span_id: "B", parent_span_id: "A", name: "B" }),
    ]);
    // Neither span is silently dropped; each appears exactly once.
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out.match(/\bA \[/g)?.length).toBe(1);
    expect(out.match(/\bB \[/g)?.length).toBe(1);
  });

  it("renders a self-referential span without infinite recursion", () => {
    const out = renderTree([span({ span_id: "self", parent_span_id: "self", name: "self" })]);
    expect(out).toContain("self");
  });

  it("keeps a real root while recovering a detached cycle", () => {
    const out = renderTree([
      span({ span_id: "root", name: "root" }),
      span({ span_id: "C", parent_span_id: "D", name: "C" }),
      span({ span_id: "D", parent_span_id: "C", name: "D" }),
    ]);
    expect(out).toContain("root");
    expect(out).toContain("C");
    expect(out).toContain("D");
  });
});

describe("renderTree durations", () => {
  it("shows the formatted duration for a span with an end time", () => {
    const out = renderTree([
      span({
        span_id: "r",
        name: "r",
        span_start_time: "2024-01-01T00:00:00Z",
        span_end_time: "2024-01-01T00:00:01.5Z",
      }),
    ]);
    expect(out).toContain("1.5s");
  });

  it("right-aligns the duration to the given width", () => {
    const out = renderTree(
      [
        span({
          span_id: "r",
          name: "r",
          span_start_time: "2024-01-01T00:00:00Z",
          span_end_time: "2024-01-01T00:00:01Z",
        }),
      ],
      { width: 40 },
    );
    const line = out.split("\n")[0] as string;
    expect(line.length).toBe(40);
    expect(line.endsWith("1.0s")).toBe(true);
  });

  it("defaults the width to 80 when not given", () => {
    const out = renderTree([
      span({
        span_id: "r",
        name: "r",
        span_start_time: "2024-01-01T00:00:00Z",
        span_end_time: "2024-01-01T00:00:01Z",
      }),
    ]);
    expect((out.split("\n")[0] as string).length).toBe(80);
  });

  it("shows elapsed-so-far against options.now for a span with no span_end_time", () => {
    const out = renderTree([
      span({
        span_id: "r",
        name: "r",
        span_start_time: "2024-01-01T00:00:00Z",
        span_end_time: null,
      }),
    ]);
    expect(out).not.toMatch(/\d+(\.\d+)?(ms|s)/);

    const withNow = renderTree(
      [
        span({
          span_id: "r",
          name: "r",
          span_start_time: "2024-01-01T00:00:00Z",
          span_end_time: null,
        }),
      ],
      { now: "2024-01-01T00:00:03Z" },
    );
    expect(withNow).toContain("3.0s");
  });

  it("never pads to less than one space between the name/marker and the duration", () => {
    const out = renderTree(
      [
        span({
          span_id: "r",
          name: "a-very-long-span-name-that-blows-past-the-target-width-entirely",
          span_start_time: "2024-01-01T00:00:00Z",
          span_end_time: "2024-01-01T00:00:01Z",
        }),
      ],
      { width: 20 },
    );
    const line = out.split("\n")[0] as string;
    expect(line).toContain(" 1.0s");
    expect(line).not.toContain("  1.0s");
  });
});

describe("renderTree error status_message", () => {
  it("prints the status_message on its own line beneath an errored span, in red when color is on", () => {
    const out = renderTree(
      [span({ span_id: "bad", status: "ERROR", status_message: "connection refused" })],
      { color: true },
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("connection refused");
    expect(lines[1]).toContain("\x1b[91m");
  });

  it("indents the message to align under the span name", () => {
    const out = renderTree([
      span({ span_id: "root", name: "root" }),
      span({
        span_id: "bad",
        parent_span_id: "root",
        name: "bad",
        status: "ERROR",
        status_message: "boom",
      }),
    ]);
    const lines = out.split("\n");
    const msgLine = lines.find((l) => l.includes("boom")) as string;
    expect(msgLine).toBeDefined();
    expect(msgLine.indexOf("boom")).toBeGreaterThan(0);
  });

  it("has no ANSI codes for the message when color is off", () => {
    const out = renderTree([
      span({ span_id: "bad", status: "ERROR", status_message: "connection refused" }),
    ]);
    expect(out).not.toContain("\x1b[");
  });

  it("omits the message line entirely when status_message is null", () => {
    const out = renderTree([span({ span_id: "bad", status: "ERROR", status_message: null })]);
    expect(out.split("\n")).toHaveLength(1);
  });

  it("omits the message line when status_message is absent", () => {
    const out = renderTree([span({ span_id: "bad", status: "ERROR" })]);
    expect(out.split("\n")).toHaveLength(1);
  });

  it("does not print a status_message for a non-error span", () => {
    const out = renderTree([span({ span_id: "ok", status: "OK", status_message: "some message" })]);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).not.toContain("some message");
  });

  it("truncates a long status_message to the given width", () => {
    const long = "x".repeat(200);
    const out = renderTree([span({ span_id: "bad", status: "ERROR", status_message: long })], {
      width: 40,
    });
    const lines = out.split("\n");
    expect(lines[1]?.length).toBeLessThanOrEqual(40);
    expect(lines[1]).toContain("truncated");
  });

  it("keeps the full message line (prefix + text + hint) within an exact narrow width", () => {
    const width = 30;
    const out = renderTree(
      [
        span({ span_id: "root", name: "root" }),
        span({
          span_id: "bad",
          parent_span_id: "root",
          name: "bad",
          status: "ERROR",
          status_message: "y".repeat(500),
        }),
      ],
      { width },
    );
    const msgLine = out.split("\n").find((l) => l.includes("truncated")) as string;
    expect(msgLine).toBeDefined();
    // The COMPLETE rendered line — indent prefix, kept text, and the
    // "… (truncated)" hint — fits within the requested terminal width.
    expect(msgLine.length).toBeLessThanOrEqual(width);
  });
});

describe("renderTree LLM detail", () => {
  it("shows model, compact token count, and cost on their own dim line", () => {
    const out = renderTree(
      [
        span({
          span_id: "llm",
          model_name: "claude-sonnet-4-5",
          total_tokens: 1234,
          cost: 0.004,
        }),
      ],
      { color: true },
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("claude-sonnet-4-5");
    expect(lines[1]).toContain("1.2k tok");
    expect(lines[1]).toContain("$0.0040");
    expect(lines[1]).toContain("\x1b[2m");
  });

  it("sums input_tokens and output_tokens when total_tokens is absent", () => {
    const out = renderTree([
      span({ span_id: "llm", model_name: "gpt-4o", input_tokens: 100, output_tokens: 50 }),
    ]);
    expect(out).toContain("150 tok");
  });

  it("prefers total_tokens over input+output when both are present", () => {
    const out = renderTree([
      span({
        span_id: "llm",
        model_name: "gpt-4o",
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 999,
      }),
    ]);
    expect(out).toContain("999 tok");
    expect(out).not.toContain("150 tok");
  });

  it("omits tokens and cost individually when missing, still showing the model", () => {
    const out = renderTree([span({ span_id: "llm", model_name: "gpt-4o" })]);
    const lines = out.split("\n");
    expect(lines[1]).toBe("gpt-4o");
  });

  it("omits the detail line entirely when model_name is absent", () => {
    const out = renderTree([span({ span_id: "s", total_tokens: 100, cost: 0.01 })]);
    expect(out.split("\n")).toHaveLength(1);
  });

  it("has no ANSI codes for the detail line when color is off", () => {
    const out = renderTree([
      span({ span_id: "llm", model_name: "claude-sonnet-4-5", total_tokens: 1200, cost: 0.004 }),
    ]);
    expect(out).not.toContain("\x1b[");
  });
});

describe("truncate", () => {
  it("returns text unchanged when at or below the max", () => {
    expect(truncate("hello", 200)).toBe("hello");
    const exact = "a".repeat(200);
    expect(truncate(exact, 200)).toBe(exact);
  });

  it("caps the TOTAL output (kept text plus hint) at max when over the max", () => {
    const long = "a".repeat(250);
    const out = truncate(long, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("truncated");
    expect(out.startsWith("a".repeat(200 - "… (truncated)".length))).toBe(true);
    expect(out).not.toContain("a".repeat(200 - "… (truncated)".length + 1));
  });

  it("defaults the max to 200", () => {
    const long = "b".repeat(201);
    const out = truncate(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("truncated");
    expect(out.startsWith("b".repeat(200 - "… (truncated)".length))).toBe(true);
  });

  it("keeps one source character even when max cannot fit the hint", () => {
    const out = truncate("c".repeat(50), 5);
    expect(out.startsWith("c")).toBe(true);
    expect(out).toContain("truncated");
  });
});
