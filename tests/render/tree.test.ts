import { describe, expect, it } from "vitest";
import { type SpanLike, renderTree, truncate } from "../../src/render/tree.js";

function span(partial: Partial<SpanLike> & { span_id: string }): SpanLike {
  return {
    parent_span_id: null,
    name: partial.span_id,
    span_start_time: "2024-01-01T00:00:00Z",
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

describe("truncate", () => {
  it("returns text unchanged when at or below the max", () => {
    expect(truncate("hello", 200)).toBe("hello");
    const exact = "a".repeat(200);
    expect(truncate(exact, 200)).toBe(exact);
  });

  it("truncates to max chars and appends a hint when over the max", () => {
    const long = "a".repeat(250);
    const out = truncate(long, 200);
    expect(out).toContain("a".repeat(200));
    expect(out).not.toContain("a".repeat(201));
    expect(out).toContain("truncated");
  });

  it("defaults the max to 200", () => {
    const long = "b".repeat(201);
    const out = truncate(long);
    expect(out).toContain("truncated");
    expect(out.startsWith("b".repeat(200))).toBe(true);
  });
});
