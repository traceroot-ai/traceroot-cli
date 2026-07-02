import { describe, expect, it } from "vitest";
import { createStyler } from "../src/render/style.js";
import { StringSink } from "./helpers/stringSink.js";

describe("createStyler", () => {
  it("wraps text in ANSI codes on a TTY with NO_COLOR unset", () => {
    const styler = createStyler(new StringSink(true), {});
    expect(styler.bold("Project")).toBe("\x1b[1mProject\x1b[0m");
    expect(styler.dim("id-123")).toBe("\x1b[2mid-123\x1b[0m");
    expect(styler.warn("WARNING:")).toBe("\x1b[33mWARNING:\x1b[0m");
  });

  it("returns text unchanged when the sink is not a TTY", () => {
    const styler = createStyler(new StringSink(false), {});
    expect(styler.bold("Project")).toBe("Project");
    expect(styler.dim("id-123")).toBe("id-123");
    expect(styler.warn("WARNING:")).toBe("WARNING:");
  });

  it("returns text unchanged when NO_COLOR is set, even on a TTY", () => {
    const styler = createStyler(new StringSink(true), { NO_COLOR: "1" });
    expect(styler.bold("Project")).toBe("Project");
    expect(styler.dim("id-123")).toBe("id-123");
    expect(styler.warn("WARNING:")).toBe("WARNING:");
  });

  it("wraps a URL in an OSC 8 hyperlink on a TTY, defaulting the label to the URL", () => {
    const styler = createStyler(new StringSink(true), {});
    const url = "https://app.example.com/trace/t-1";
    expect(styler.link(url)).toBe(`\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`);
    expect(styler.link(url, "open")).toBe(`\x1b]8;;${url}\x1b\\open\x1b]8;;\x1b\\`);
  });

  it("emits the bare URL (no escapes) when the sink is not a TTY", () => {
    const styler = createStyler(new StringSink(false), {});
    const url = "https://app.example.com/trace/t-1";
    expect(styler.link(url)).toBe(url);
    expect(styler.link(url, "open")).toBe("open");
  });

  it("emits the bare URL (no escapes) when NO_COLOR is set, even on a TTY", () => {
    const styler = createStyler(new StringSink(true), { NO_COLOR: "1" });
    const url = "https://app.example.com/trace/t-1";
    expect(styler.link(url)).toBe(url);
  });
});
