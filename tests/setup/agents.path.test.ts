import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOnPath } from "../../src/setup/agents.js";

describe("finding an agent on PATH", () => {
  it("ignores a file of the right name that cannot be executed", () => {
    // Reporting it as runnable auto-selects that agent, and the failure surfaces
    // much later as a spawn error in the middle of the run. `execvp` checks the
    // execute bit too.
    const dir = mkdtempSync(join(tmpdir(), "traceroot-path-"));
    const binary = join(dir, "claude");
    writeFileSync(binary, "#!/bin/sh\n", "utf8");
    chmodSync(binary, 0o644);

    expect(resolveOnPath("claude", { PATH: dir }, "linux")).toBeNull();
  });

  it("finds it once it is executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "traceroot-path-"));
    const binary = join(dir, "claude");
    writeFileSync(binary, "#!/bin/sh\n", "utf8");
    chmodSync(binary, 0o755);

    expect(resolveOnPath("claude", { PATH: dir }, "linux")).toBe(binary);
  });
});
