import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/runCli.js";

describe("traceroot <unknown command>", () => {
  it("exits non-zero and writes the error to stderr", () => {
    const { stdout, stderr, status } = runCli("definitely-not-a-command");
    expect(status).not.toBe(0);
    expect(stderr).not.toBe("");
    expect(stderr.toLowerCase()).toContain("unknown command");
    expect(stdout).toBe("");
  });
});
