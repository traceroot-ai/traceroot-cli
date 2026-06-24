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

describe("global --json discoverability in help", () => {
  it("traces list --help shows the global --json flag", () => {
    const { stdout, status } = runCli("traces", "list", "--help");
    expect(status).toBe(0);
    expect(stdout).toContain("--json");
    expect(stdout).toContain("Global Options");
  });

  it("traces --help shows the global --json flag", () => {
    const { stdout, status } = runCli("traces", "--help");
    expect(status).toBe(0);
    expect(stdout).toContain("--json");
  });

  it("top-level --help shows --json", () => {
    const { stdout } = runCli("--help");
    expect(stdout).toContain("--json");
  });
});

describe("--help placement (Global Options for subcommands)", () => {
  it("lists -h, --help under Global Options, not the command's own Options (traces list)", () => {
    const { stdout } = runCli("traces", "list", "--help");
    const idx = stdout.indexOf("Global Options");
    expect(idx).toBeGreaterThan(-1);
    // The command's own Options (before "Global Options") must NOT list --help.
    expect(stdout.slice(0, idx)).not.toContain("--help");
    // It appears in the Global Options section instead.
    expect(stdout.slice(idx)).toContain("--help");
  });

  it("lists -h, --help under Global Options for an intermediate command (traces)", () => {
    const { stdout } = runCli("traces", "--help");
    const idx = stdout.indexOf("Global Options");
    expect(idx).toBeGreaterThan(-1);
    expect(stdout.slice(idx)).toContain("--help");
  });

  it("keeps -h, --help on the root help and gives it no Global Options section", () => {
    const { stdout } = runCli("--help");
    expect(stdout).toContain("--help");
    expect(stdout).not.toContain("Global Options");
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

describe("traceroot --json (no command)", () => {
  it("exits non-zero with a clear error message", () => {
    const result = runCli("--json");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--json requires a command");
    expect(result.stderr).toContain("traceroot status --json");
    expect(result.stderr).toContain("traceroot traces list --json");
  });

  it("emits no JSON to stdout", () => {
    const result = runCli("--json");
    expect(result.stdout).toBe("");
  });
});
