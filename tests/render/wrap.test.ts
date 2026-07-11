import { describe, expect, it } from "vitest";
import { wrapMarkdown } from "../../src/render/wrap.js";

const bold = (text: string): string => `**${text}**`; // fake styler distinct from markdown `**`

describe("wrapMarkdown", () => {
  it("wraps a long paragraph so no line exceeds the given width", () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const wrapped = wrapMarkdown(text, 20);
    for (const line of wrapped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
    // no words dropped
    for (let i = 0; i < 30; i++) {
      expect(wrapped).toContain(`word${i}`);
    }
  });

  it("joins single newlines within a paragraph before rewrapping", () => {
    const text = "one two three\nfour five six";
    const wrapped = wrapMarkdown(text, 80);
    expect(wrapped).toBe("one two three four five six");
  });

  it("preserves blank lines as paragraph separators", () => {
    const text = "first paragraph\n\nsecond paragraph";
    const wrapped = wrapMarkdown(text, 80);
    expect(wrapped).toBe("first paragraph\n\nsecond paragraph");
  });

  it("strips a leading heading marker and never prints it literally", () => {
    const wrapped = wrapMarkdown("## Root Cause", 80, (s) => `[B]${s}[/B]`);
    expect(wrapped).not.toContain("##");
    // Styled per word (visually equivalent bolding), not merged into one span.
    expect(wrapped).toBe("[B]Root[/B] [B]Cause[/B]");
  });

  it("leaves a heading as plain text when no styler is given", () => {
    const wrapped = wrapMarkdown("# Title", 80);
    expect(wrapped).toBe("Title");
  });

  it("strips ** markers and styles the enclosed text as bold", () => {
    const wrapped = wrapMarkdown("this is **important** text", 80, (s) => `[B]${s}[/B]`);
    expect(wrapped).not.toContain("**");
    expect(wrapped).toBe("this is [B]important[/B] text");
  });

  it("leaves bold text plain (markers stripped) when no styler is given", () => {
    const wrapped = wrapMarkdown("this is **important** text", 80);
    expect(wrapped).toBe("this is important text");
  });

  it("keeps punctuation glued after a bold span (no invented space)", () => {
    expect(wrapMarkdown("**Note**: text", 80, (s) => `[B]${s}[/B]`)).toBe("[B]Note[/B]: text");
    expect(wrapMarkdown("**Note**: text", 80)).toBe("Note: text");
  });

  it("keeps punctuation glued around a parenthesized bold span", () => {
    expect(wrapMarkdown("(**timeout**),", 80, (s) => `[B]${s}[/B]`)).toBe("([B]timeout[/B]),");
    expect(wrapMarkdown("(**timeout**),", 80)).toBe("(timeout),");
  });

  it("keeps text glued directly before and after a bold span", () => {
    expect(wrapMarkdown("pre**bold**post", 80, (s) => `[B]${s}[/B]`)).toBe("pre[B]bold[/B]post");
    expect(wrapMarkdown("pre**bold**post", 80)).toBe("preboldpost");
  });

  it("still separates the words of a multi-word bold phrase normally", () => {
    expect(wrapMarkdown("a **bold phrase** here", 80, (s) => `[B]${s}[/B]`)).toBe(
      "a [B]bold[/B] [B]phrase[/B] here",
    );
    expect(wrapMarkdown("a **bold phrase** here", 80)).toBe("a bold phrase here");
  });

  it("counts a glued word's full visible length when deciding where to wrap", () => {
    // "(timeout)," is one 10-column word; at width 12 it can't share a line
    // with "aaa" (3 + 1 + 10 = 14 > 12), so it must wrap as a whole unit.
    const wrapped = wrapMarkdown("aaa (**timeout**), bb", 12);
    expect(wrapped.split("\n")).toEqual(["aaa", "(timeout),", "bb"]);
  });

  it("strips inline code backticks without styling", () => {
    const wrapped = wrapMarkdown("call `doThing()` now", 80, (s) => `[B]${s}[/B]`);
    expect(wrapped).not.toContain("`");
    expect(wrapped).toBe("call doThing() now");
  });

  it("wraps list items with a hanging indent instead of merging bullets", () => {
    const wrapped = wrapMarkdown("- root cause one\n- root cause two", 80);
    expect(wrapped.split("\n")).toEqual(["- root cause one", "- root cause two"]);
  });

  it("indents a wrapped list item's continuation line under its text", () => {
    const wrapped = wrapMarkdown(
      "- this is a fairly long list item that should wrap across more than one line",
      30,
    );
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("- ")).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.startsWith("- ")).toBe(false);
    }
  });

  it("keeps a single word longer than width on its own line (no infinite loop)", () => {
    const longWord = "x".repeat(50);
    const wrapped = wrapMarkdown(longWord, 10);
    expect(wrapped).toBe(longWord);
  });

  it("defaults to the identity styler, never emitting empty output for input text", () => {
    expect(wrapMarkdown("plain text", 80)).toBe("plain text");
  });
});
