import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/runCli.js";

describe("output contract (spawned status stub)", () => {
  it("writes nothing to stdout, an error to stderr, and exits non-zero", () => {
    const { stdout, stderr, status } = runCli("status");
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });

  it("keeps the same contract under --json", () => {
    const { stdout, stderr, status } = runCli("--json", "status");
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });

  it("emits no ANSI escape sequences when spawned (non-TTY)", () => {
    const { stdout, stderr } = runCli("status");
    expect(stdout).not.toContain("\x1b[");
    expect(stderr).not.toContain("\x1b[");
  });
});
