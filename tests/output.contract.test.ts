import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const binPath = fileURLToPath(new URL("../bin/traceroot.mjs", import.meta.url));

// Isolate from any real ~/.traceroot/config.json and ambient credentials so
// `status` deterministically resolves no credentials and exercises the failure
// contract (non-zero exit, empty stdout, error on stderr) on every machine.
const isolatedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  TRACEROOT_CONFIG_PATH: join(tmpdir(), "traceroot-cli-no-such-config", "config.json"),
  TRACEROOT_API_KEY: "",
  TRACEROOT_HOST_URL: "",
};

function runIsolated(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: isolatedEnv,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("output contract (spawned failing command)", () => {
  it("writes nothing to stdout, an error to stderr, and exits non-zero", () => {
    const { stdout, stderr, status } = runIsolated("status");
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });

  it("keeps the same contract under --json", () => {
    const { stdout, stderr, status } = runIsolated("--json", "status");
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });

  it("emits no ANSI escape sequences when spawned (non-TTY)", () => {
    const { stdout, stderr } = runIsolated("status");
    expect(stdout).not.toContain("\x1b[");
    expect(stderr).not.toContain("\x1b[");
  });
});
