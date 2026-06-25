import { describe, expect, it } from "vitest";
import { confirm, dim, yellow } from "../src/prompt.js";
import { StringSink } from "./helpers/stringSink.js";

describe("dim", () => {
  it("wraps text in the dim ANSI code when the sink supports color (TTY)", () => {
    expect(dim("(default: claude)", new StringSink(true))).toBe("\x1b[2m(default: claude)\x1b[0m");
  });

  it("returns text unchanged when color is disabled (non-TTY)", () => {
    expect(dim("(default: claude)", new StringSink(false))).toBe("(default: claude)");
  });
});

describe("yellow", () => {
  it("wraps text in the yellow ANSI code when the sink supports color (TTY)", () => {
    expect(yellow("WARNING:", new StringSink(true))).toBe("\x1b[33mWARNING:\x1b[0m");
  });

  it("returns text unchanged when color is disabled (non-TTY)", () => {
    expect(yellow("WARNING:", new StringSink(false))).toBe("WARNING:");
  });
});

describe("confirm", () => {
  it("returns true only for y/yes (case-insensitive)", async () => {
    expect(await confirm("?", async () => "y")).toBe(true);
    expect(await confirm("?", async () => "YES")).toBe(true);
    expect(await confirm("?", async () => " Yes ")).toBe(true);
  });

  it("returns false for empty, n, and no (safe default)", async () => {
    expect(await confirm("?", async () => "")).toBe(false);
    expect(await confirm("?", async () => "n")).toBe(false);
    expect(await confirm("?", async () => "no")).toBe(false);
    expect(await confirm("?", async () => "anything")).toBe(false);
  });
});
