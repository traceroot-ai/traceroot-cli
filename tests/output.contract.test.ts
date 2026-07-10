import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

// A fresh empty working directory so the CLI's auto-discovered `.env` (a
// lowest-precedence credential source) can never pick up a developer's stray
// repo `.env` and flip a missing-credentials failure into a network one.
const isolatedCwd = mkdtempSync(join(tmpdir(), "traceroot-cli-contract-"));

function runIsolated(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: isolatedEnv,
    cwd: isolatedCwd,
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

describe("exit-code classes (spawned)", () => {
  it("exits 2 (usage) on a validation error", () => {
    // Bad --limit is a pure usage error, so it never needs credentials.
    const { stdout, stderr, status } = runIsolated("traces", "list", "--limit", "banana");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: /);
  });

  it("exits 3 (auth) when credentials are missing", () => {
    const { stdout, stderr, status } = runIsolated("status");
    expect(status).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });

  it("human-mode stderr starts with `error: `", () => {
    const { stderr } = runIsolated("status");
    expect(stderr.startsWith("error: ")).toBe(true);
  });

  it("under --json emits a single parseable error envelope to stderr, stdout empty", () => {
    const { stdout, stderr, status } = runIsolated("--json", "status");
    expect(status).toBe(3);
    expect(stdout).toBe("");
    // Exactly one line.
    expect(stderr.trimEnd().includes("\n")).toBe(false);
    const parsed = JSON.parse(stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("auth");
    expect(typeof parsed.error.message).toBe("string");
    expect(parsed.error.message).not.toBe("");
  });

  it("under --json a usage error carries the `usage` code", () => {
    const { stdout, stderr, status } = runIsolated("--json", "traces", "list", "--limit", "banana");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    const parsed = JSON.parse(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe("usage");
  });
});

describe("commander-native failures follow the exit-code contract (spawned)", () => {
  it("exits 2 with one `error: ` line on an unknown option", () => {
    const { stdout, stderr, status } = runIsolated("traces", "list", "--bogusflag");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: unknown option '--bogusflag'/);
    // Reported exactly once (no commander double-print).
    expect(stderr.match(/unknown option/g)).toHaveLength(1);
  });

  it("exits 2 on an unknown command", () => {
    const { stdout, stderr, status } = runIsolated("boguscmd");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: unknown command 'boguscmd'/);
  });

  it("exits 2 when an option's argument is missing", () => {
    const { stdout, stderr, status } = runIsolated("traces", "list", "--limit");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: .*--limit.*argument missing/);
  });

  it("under --json an unknown option yields a single `usage` envelope on stderr", () => {
    const { stdout, stderr, status } = runIsolated("--json", "traces", "list", "--bogusflag");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.trimEnd().includes("\n")).toBe(false);
    const parsed = JSON.parse(stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("usage");
    expect(parsed.error.message).toContain("--bogusflag");
  });

  it("keeps --help exiting 0 with help on stdout", () => {
    const { stdout, stderr, status } = runIsolated("--help");
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: traceroot");
    expect(stderr).toBe("");
  });

  it("keeps subcommand --help exiting 0 with help on stdout", () => {
    const { stdout, status } = runIsolated("traces", "list", "--help");
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: traceroot traces list");
  });

  it("keeps --version exiting 0 with the version on stdout", () => {
    const { stdout, stderr, status } = runIsolated("--version");
    expect(status).toBe(0);
    expect(stdout.trim()).not.toBe("");
    expect(stderr).toBe("");
  });
});
