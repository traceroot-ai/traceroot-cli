import { describe, expect, it } from "vitest";
import { statusSymbol } from "../../src/render/status.js";
import { StringSink } from "../helpers/stringSink.js";

const tty = new StringSink(true);
const notTty = new StringSink(false);
const noColorEnv: NodeJS.ProcessEnv = {};
const noColorDisabled: NodeJS.ProcessEnv = { NO_COLOR: "1" };

describe("statusSymbol", () => {
  it("returns plain glyphs when color is disabled (non-TTY sink)", () => {
    expect(statusSymbol("pass", notTty, noColorEnv)).toBe("✓");
    expect(statusSymbol("warn", notTty, noColorEnv)).toBe("-");
    expect(statusSymbol("fail", notTty, noColorEnv)).toBe("✗");
  });

  it("colors glyphs on a TTY: green pass, dim warn, red fail", () => {
    expect(statusSymbol("pass", tty, noColorEnv)).toBe("\x1b[32m✓\x1b[0m");
    expect(statusSymbol("warn", tty, noColorEnv)).toBe("\x1b[2m-\x1b[0m");
    expect(statusSymbol("fail", tty, noColorEnv)).toBe("\x1b[91m✗\x1b[0m");
  });

  it("respects NO_COLOR even on a TTY", () => {
    expect(statusSymbol("pass", tty, noColorDisabled)).toBe("✓");
    expect(statusSymbol("fail", tty, noColorDisabled)).toBe("✗");
  });
});
