import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/runCli.js";

describe("traceroot --help", () => {
  it("prints usage and command names, exits 0", () => {
    const { stdout, stderr, status } = runCli("--help");
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: traceroot");
    expect(stdout).toContain("login");
    expect(stdout).toContain("status");
    expect(stdout).toContain("traces");
    expect(stderr).toBe("");
  });
});

describe("traceroot (no command)", () => {
  it("prints help to stderr and exits non-zero", () => {
    const { stdout, stderr, status } = runCli();
    expect(status).not.toBe(0);
    // Help is human text, so it goes to stderr; stdout stays clean.
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage: traceroot");
    expect(stderr).toContain("login");
    expect(stderr).toContain("traces");
  });
});
