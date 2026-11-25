import { describe, expect, it } from "vitest";
import {
  displayWidth,
  terminalColumns,
  wrapItems,
  wrapLine,
  wrapWords,
} from "../../src/render/wrap.js";

describe("displayWidth", () => {
  it("counts a column per ASCII character and none for escape sequences", () => {
    expect(displayWidth("exact_match")).toBe(11);
    expect(displayWidth("\u001b[1mbold\u001b[0m")).toBe(4);
    expect(displayWidth("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\")).toBe(4);
  });

  it("counts two columns for a wide character or an emoji, and none for a combining mark", () => {
    expect(displayWidth("正确性")).toBe(6);
    expect(displayWidth("ok 👍🏽")).toBe(5);
    expect(displayWidth("café")).toBe(4);
  });
});

describe("terminalColumns", () => {
  it("is the width of a terminal, and undefined for a pipe or a terminal that reports none", () => {
    const write = () => true;
    expect(terminalColumns({ write, isTTY: true, columns: 60 } as never)).toBe(60);
    expect(terminalColumns({ write, isTTY: false, columns: 60 } as never)).toBeUndefined();
    expect(terminalColumns({ write, isTTY: true, columns: 0 } as never)).toBeUndefined();
  });
});

describe("wrapWords", () => {
  it("fills lines greedily and never breaks a word, even one wider than the line", () => {
    expect(wrapWords("run it with traceroot evals run --baseline run_01ABCDEFGHIJ", 16)).toEqual([
      "run it with",
      "traceroot evals",
      "run --baseline",
      "run_01ABCDEFGHIJ",
    ]);
    expect(wrapWords("see https://docs.traceroot.ai/tracing/git-context", 10)).toEqual([
      "see",
      "https://docs.traceroot.ai/tracing/git-context",
    ]);
  });
});

describe("wrapLine", () => {
  it("keeps the line's indent and hangs its continuation lines two columns further in", () => {
    expect(wrapLine("  tone: no value is a number or true/false, so it has no mean.", 30)).toEqual([
      "  tone: no value is a number",
      "    or true/false, so it has",
      "    no mean.",
    ]);
  });

  it("returns the line whole when it fits, or when there is no width", () => {
    expect(wrapLine("short", 30)).toEqual(["short"]);
    expect(wrapLine("x ".repeat(100).trim(), undefined)).toEqual(["x ".repeat(100).trim()]);
  });

  it("never breaks at a space inside a span it is told to keep whole, such as a path", () => {
    const path = "/Users/me/My Projects/.venv/bin/python";
    expect(wrapLine(`Running x_eval.py on Python 3.12.4 (${path})`, 30, [path])).toEqual([
      "Running x_eval.py on Python",
      "  3.12.4",
      `  (${path})`,
    ]);
  });
});

describe("wrapItems", () => {
  it("breaks between items, not inside them, and drops the separator at a break", () => {
    expect(wrapItems(["uppercase", "run_01M7S5GKT91KS2B33EGQ", "completed"], 30)).toEqual([
      "uppercase",
      "  run_01M7S5GKT91KS2B33EGQ",
      "  completed",
    ]);
    expect(wrapItems(["6 cases", "0 errored", "mean 2 ms per case"], 30, { indent: "  " })).toEqual(
      ["  6 cases · 0 errored", "    mean 2 ms per case"],
    );
  });

  it("wraps the words of an item wider than a line on its own", () => {
    expect(wrapItems(["a", "one item that is far too long"], 12)).toEqual([
      "a",
      "  one item",
      "  that is",
      "  far too",
      "  long",
    ]);
  });
});
