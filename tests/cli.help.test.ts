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
