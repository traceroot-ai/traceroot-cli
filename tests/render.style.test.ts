import { describe, expect, it } from "vitest";
import { createStyler } from "../src/render/style.js";
import { StringSink } from "./helpers/stringSink.js";

describe("createStyler", () => {
  it("wraps text in ANSI codes on a TTY with NO_COLOR unset", () => {
    const styler = createStyler(new StringSink(true), {});
    expect(styler.bold("Project")).toBe("\x1b[1mProject\x1b[0m");
    expect(styler.dim("id-123")).toBe("\x1b[2mid-123\x1b[0m");
  });

  it("returns text unchanged when the sink is not a TTY", () => {
    const styler = createStyler(new StringSink(false), {});
    expect(styler.bold("Project")).toBe("Project");
    expect(styler.dim("id-123")).toBe("id-123");
  });

  it("returns text unchanged when NO_COLOR is set, even on a TTY", () => {
    const styler = createStyler(new StringSink(true), { NO_COLOR: "1" });
    expect(styler.bold("Project")).toBe("Project");
    expect(styler.dim("id-123")).toBe("id-123");
  });
});
