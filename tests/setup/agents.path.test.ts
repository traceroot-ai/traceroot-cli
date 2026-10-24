import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOnPath } from "../../src/setup/agents.js";

/** Every PATH directory this file makes, so none is left in the system tmpdir. */
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("finding an agent on PATH", () => {
  it("ignores a file of the right name that cannot be executed", () => {
    // Reporting it as runnable auto-selects that agent, and the failure surfaces
    // much later as a spawn error in the middle of the run. `execvp` checks the
    // execute bit too.
    const dir = mkdtempSync(join(tmpdir(), "traceroot-path-"));
    roots.push(dir);
    const binary = join(dir, "claude");
    writeFileSync(binary, "#!/bin/sh\n", "utf8");
    chmodSync(binary, 0o644);

    expect(resolveOnPath("claude", { PATH: dir }, "linux")).toBeNull();
  });

  it("finds it once it is executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "traceroot-path-"));
    roots.push(dir);
    const binary = join(dir, "claude");
    writeFileSync(binary, "#!/bin/sh\n", "utf8");
    chmodSync(binary, 0o755);

    expect(resolveOnPath("claude", { PATH: dir }, "linux")).toBe(binary);
  });
});
