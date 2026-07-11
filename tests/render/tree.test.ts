import { describe, expect, it } from "vitest";
import {
  type SpanLike,
  filterErrorsWithAncestors,
  isErrorStatus,
  renderTree,
  spansWithinDepth,
  treeOrder,
  truncate,
} from "../../src/render/tree.js";

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

describe("renderTree --depth cap", () => {
  const nested = [
    span({ span_id: "root", name: "root" }),
    span({ span_id: "mid", parent_span_id: "root", name: "mid" }),
    span({ span_id: "leaf", parent_span_id: "mid", name: "leaf" }),
    span({ span_id: "leaf2", parent_span_id: "mid", name: "leaf2" }),
  ];

  it("hides spans below the depth limit and marks the count", () => {
    // depth 2: root (1) and mid (2) show; leaf/leaf2 (3) are hidden behind one marker.
    const out = renderTree(nested, { maxDepth: 2 });
    expect(out).toContain("root");
    expect(out).toContain("mid");
    expect(out).not.toContain("leaf");
    expect(out).toContain("… 2 deeper spans hidden");
  });

  it("singularizes the marker for a single hidden span", () => {
    const out = renderTree(
      [
        span({ span_id: "root", name: "root" }),
        span({ span_id: "only", parent_span_id: "root", name: "only" }),
      ],
      { maxDepth: 1 },
    );
    expect(out).toContain("… 1 deeper span hidden");
    expect(out).not.toContain("deeper spans");
  });

  it("emits no depth marker when nothing is hidden", () => {
    const out = renderTree(nested, { maxDepth: 5 });
    expect(out).not.toContain("hidden");
    expect(out).toContain("leaf2");
  });
});

describe("renderTree --depth stacked with --max-spans", () => {
  it("keeps the depth marker of the span sitting exactly at the span cap", () => {
    // root (d1) → a (d2, has hidden child a1 at d3) and b (d2, later start).
    // With --depth 2 --max-spans 2, `a` is the LAST displayed span and its
    // depth marker must still render before the overall cap marker.
    const spans = [
      span({ span_id: "root", name: "root", span_start_time: "2024-01-01T00:00:00Z" }),
      span({
        span_id: "a",
        parent_span_id: "root",
        name: "a",
        span_start_time: "2024-01-01T00:00:01Z",
      }),
      span({
        span_id: "a1",
        parent_span_id: "a",
        name: "a1",
        span_start_time: "2024-01-01T00:00:02Z",
      }),
      span({
        span_id: "b",
        parent_span_id: "root",
        name: "b",
        span_start_time: "2024-01-01T00:00:03Z",
      }),
    ];
    const out = renderTree(spans, { maxDepth: 2, maxSpans: 2 });
    const lines = out.split("\n");
    // Both markers, with correct counts: a1 elided by depth, b elided by the cap.
    expect(out).toContain("… 1 deeper span hidden");
    expect(lines[lines.length - 1]).toBe("… 1 more span");
    // Exactly: root, a, a's depth marker, then the cap marker.
    expect(lines).toHaveLength(4);
    expect(out).not.toContain("b [ok]");
    expect(out).not.toContain("a1 [ok]");
  });
});

describe("renderTree --max-spans cap", () => {
  const spans = [
    span({ span_id: "a", name: "a" }),
    span({ span_id: "b", name: "b" }),
    span({ span_id: "c", name: "c" }),
    span({ span_id: "d", name: "d" }),
  ];

  it("stops after N spans and appends the true remainder", () => {
    const out = renderTree(spans, { maxSpans: 2 });
    const lines = out.split("\n");
    // 2 span lines + 1 elision line.
    expect(lines).toHaveLength(3);
    expect(out).toContain("… 2 more spans");
  });

  it("singularizes the elision line for one remaining span", () => {
    const out = renderTree(spans, { maxSpans: 3 });
    expect(out).toContain("… 1 more span");
    expect(out).not.toContain("more spans");
  });

  it("emits no elision line when the cap is not reached", () => {
    const out = renderTree(spans, { maxSpans: 10 });
    expect(out).not.toContain("more span");
  });
});

describe("spansWithinDepth", () => {
  const spans = [
    span({ span_id: "root", name: "root" }),
    span({ span_id: "mid", parent_span_id: "root", name: "mid" }),
    span({ span_id: "leaf", parent_span_id: "mid", name: "leaf" }),
  ];

  it("keeps only spans at or above the depth limit (roots = 1)", () => {
    expect(spansWithinDepth(spans, 1).map((s) => s.span_id)).toEqual(["root"]);
    expect(spansWithinDepth(spans, 2).map((s) => s.span_id)).toEqual(["root", "mid"]);
    expect(spansWithinDepth(spans, 3).map((s) => s.span_id)).toEqual(["root", "mid", "leaf"]);
  });

  it("recovers a parent cycle exactly like the renderer: first member root, rest deeper", () => {
    const cyclic = [
      span({ span_id: "x", parent_span_id: "y", name: "x" }),
      span({ span_id: "y", parent_span_id: "x", name: "y" }),
    ];
    // Mirrors renderTree's recovery walk: x (first in input order) becomes the
    // recovered root at depth 1 and y hangs under it at depth 2.
    expect(spansWithinDepth(cyclic, 1).map((s) => s.span_id)).toEqual(["x"]);
    expect(spansWithinDepth(cyclic, 2).map((s) => s.span_id)).toEqual(["x", "y"]);
  });
});

describe("renderTree and spansWithinDepth agree on malformed data", () => {
  // Adversarial graph: a real chain root → a plus a detached 2-cycle x ↔ y.
  const adversarial = [
    span({ span_id: "root", name: "root" }),
    span({ span_id: "a", parent_span_id: "root", name: "a" }),
    span({ span_id: "x", parent_span_id: "y", name: "x" }),
    span({ span_id: "y", parent_span_id: "x", name: "y" }),
  ];

  /** Span names visible in a rendered tree (excludes elision markers). */
  function renderedNames(out: string): string[] {
    return out
      .split("\n")
      .filter((l) => / \[(ok|error)\]$/.test(l))
      .map((l) => (/([\w-]+) \[/.exec(l) as RegExpExecArray)[1] as string);
  }

  for (const depth of [1, 2, 3]) {
    it(`keeps the SAME span set in the tree and the flat filter at depth ${depth}`, () => {
      const human = renderedNames(renderTree(adversarial, { maxDepth: depth })).sort();
      const flat = spansWithinDepth(adversarial, depth)
        .map((s) => s.span_id)
        .sort();
      expect(flat).toEqual(human);
    });
  }

  it("hides the far side of a recovered cycle at depth 1 in both views", () => {
    expect(spansWithinDepth(adversarial, 1).map((s) => s.span_id)).toEqual(["root", "x"]);
    const out = renderTree(adversarial, { maxDepth: 1 });
    expect(out).toContain("x [ok]");
    expect(out).not.toContain("y [ok]");
  });

  it("does not count the displayed recovered root in its own elision marker", () => {
    const out = renderTree(
      [
        span({ span_id: "x", parent_span_id: "y", name: "x" }),
        span({ span_id: "y", parent_span_id: "x", name: "y" }),
      ],
      { maxDepth: 1 },
    );
    // Only y is hidden; x itself is on screen and must not be counted.
    expect(out).toContain("… 1 deeper span hidden");
    expect(out).not.toContain("2 deeper");
  });
});

describe("treeOrder", () => {
  it("matches the renderer's span line order exactly, including recovered cycles", () => {
    // Array order deliberately differs from tree order: sibling B is listed
    // before A but A starts earlier, and a detached x ↔ y cycle trails behind.
    const spans = [
      span({
        span_id: "B",
        parent_span_id: "root",
        name: "B",
        span_start_time: "2024-01-01T00:00:02Z",
      }),
      span({ span_id: "root", name: "root", span_start_time: "2024-01-01T00:00:00Z" }),
      span({
        span_id: "A",
        parent_span_id: "root",
        name: "A",
        span_start_time: "2024-01-01T00:00:01Z",
      }),
      span({ span_id: "x", parent_span_id: "y", name: "x" }),
      span({ span_id: "y", parent_span_id: "x", name: "y" }),
    ];
    const renderedOrder = renderTree(spans)
      .split("\n")
      .map((l) => (/([\w-]+) \[/.exec(l) as RegExpExecArray)[1] as string);
    expect(treeOrder(spans).map((s) => s.span_id)).toEqual(renderedOrder);
    expect(renderedOrder).toEqual(["root", "A", "B", "x", "y"]);
  });
});

describe("filterErrorsWithAncestors", () => {
  it("keeps error spans plus their ancestor chain and drops unrelated branches", () => {
    const spans = [
      span({ span_id: "root", name: "root", status: "OK" }),
      span({ span_id: "a", parent_span_id: "root", name: "a", status: "OK" }),
      span({ span_id: "err", parent_span_id: "a", name: "err", status: "ERROR" }),
      span({ span_id: "unrelated", parent_span_id: "root", name: "unrelated", status: "OK" }),
    ];
    const kept = filterErrorsWithAncestors(spans).map((s) => s.span_id);
    expect(kept).toEqual(["root", "a", "err"]);
    expect(kept).not.toContain("unrelated");
  });

  it("returns an empty list when there are no error spans", () => {
    const spans = [span({ span_id: "root", name: "root", status: "OK" })];
    expect(filterErrorsWithAncestors(spans)).toEqual([]);
  });
});

describe("isErrorStatus", () => {
  it("recognizes the known error statuses and nothing else", () => {
    for (const s of ["ERROR", "error", "STATUS_CODE_ERROR"]) {
      expect(isErrorStatus(s)).toBe(true);
    }
    expect(isErrorStatus("OK")).toBe(false);
    expect(isErrorStatus(undefined)).toBe(false);
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
