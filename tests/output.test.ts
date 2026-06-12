import { describe, expect, it } from "vitest";
import {
  CliError,
  type Writers,
  colorEnabled,
  isCliError,
  logInfo,
  logProgress,
  logWarn,
  reportError,
  writeJson,
} from "../src/output.js";
import { StringSink } from "./helpers/stringSink.js";

function writers(
  outTTY?: boolean,
  errTTY?: boolean,
): {
  w: Writers;
  out: StringSink;
  err: StringSink;
} {
  const out = new StringSink(outTTY);
  const err = new StringSink(errTTY);
  return { w: { out, err }, out, err };
}

describe("writeJson", () => {
  it("writes exactly one compact JSON document with a trailing newline to out", () => {
    const { w, out, err } = writers();
    writeJson({ a: 1, b: "x" }, w);
    expect(out.data).toBe('{"a":1,"b":"x"}\n');
    expect(err.data).toBe("");
  });

  it("round-trips via JSON.parse", () => {
    const { w, out } = writers();
    const value = { nested: { list: [1, 2, 3] }, flag: true };
    writeJson(value, w);
    expect(JSON.parse(out.data)).toEqual(value);
  });
});

describe("log helpers", () => {
  it("logInfo writes to err only", () => {
    const { w, out, err } = writers();
    logInfo("hello", w);
    expect(err.data).toBe("hello\n");
    expect(out.data).toBe("");
  });

  it("logProgress writes to err only", () => {
    const { w, out, err } = writers();
    logProgress("working", w);
    expect(err.data).toContain("working");
    expect(out.data).toBe("");
  });

  it("logWarn writes to err only with a warning prefix", () => {
    const { w, out, err } = writers();
    logWarn("careful", w);
    expect(err.data).toContain("warning:");
    expect(err.data).toContain("careful");
    expect(out.data).toBe("");
  });
});

describe("reportError", () => {
  it("returns the CliError exit code and writes the message to err with no stack", () => {
    const { w, out, err } = writers();
    const code = reportError(new CliError("boom", 2), w);
    expect(code).toBe(2);
    expect(err.data).toContain("boom");
    expect(err.data).not.toContain("at ");
    expect(out.data).toBe("");
  });

  it("returns 1 for a plain Error", () => {
    const { w } = writers();
    expect(reportError(new Error("plain"), w)).toBe(1);
  });
});

describe("isCliError", () => {
  it("identifies CliError instances", () => {
    expect(isCliError(new CliError("x"))).toBe(true);
    expect(isCliError(new Error("x"))).toBe(false);
  });
});

describe("colorEnabled", () => {
  it("is false when NO_COLOR is empty string even on a TTY sink", () => {
    expect(colorEnabled(new StringSink(true), { NO_COLOR: "" })).toBe(false);
  });

  it("is false when NO_COLOR is set even on a TTY sink", () => {
    expect(colorEnabled(new StringSink(true), { NO_COLOR: "1" })).toBe(false);
  });

  it("is false on a non-TTY sink without NO_COLOR", () => {
    expect(colorEnabled(new StringSink(false), {})).toBe(false);
  });

  it("is true only on a TTY sink with NO_COLOR unset", () => {
    expect(colorEnabled(new StringSink(true), {})).toBe(true);
  });
});

describe("color application", () => {
  it("emits no ANSI escape when color is disabled", () => {
    const { w, err } = writers(false, false);
    logProgress("dim text", w);
    logWarn("warn text", w);
    reportError(new Error("err text"), w);
    expect(err.data).not.toContain("\x1b[");
  });
});
