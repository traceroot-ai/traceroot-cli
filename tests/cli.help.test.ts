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

  it("describes --json as applying to supported commands (not root/help itself)", () => {
    const { stdout } = runCli("--help");
    // commander wraps the long description across lines; collapse whitespace first.
    expect(stdout.replace(/\s+/g, " ")).toContain(
      "emit machine-readable JSON output for supported commands",
    );
  });
});

describe("--json help on new commands", () => {
  for (const cmd of [["skills", "list"], ["skills", "install"], ["instrument"], ["doctor"]]) {
    it(`shows --json in the Options section of \`${cmd.join(" ")}\` (no separate Global block)`, () => {
      const { stdout } = runCli(...cmd, "--help");
      expect(stdout).toContain("--json");
      expect(stdout.replace(/\s+/g, " ")).toContain(
        "emit machine-readable JSON output for supported commands",
      );
      expect(stdout).not.toContain("Global option");
    });
  }
});

describe("--agent help placeholder and defaults", () => {
  it("skills install uses --agent <agent> with no claude default", () => {
    const { stdout } = runCli("skills", "install", "--help");
    expect(stdout).toContain("--agent <agent>");
    expect(stdout).not.toContain("--agent <id>");
    expect(stdout).not.toContain('(default: "claude")');
  });

  it("instrument uses --agent <agent> and does not imply a claude default", () => {
    const { stdout } = runCli("instrument", "--help");
    expect(stdout).toContain("--agent <agent>");
    expect(stdout).not.toContain("--agent <id>");
    expect(stdout).not.toContain('(default: "claude")');
  });

  it("skills list uses --agent <agent> and keeps its read-only claude default", () => {
    const { stdout } = runCli("skills", "list", "--help");
    expect(stdout).toContain("--agent <agent>");
    expect(stdout).toContain('(default: "claude")');
  });
});

describe("traceroot instrument (bare, no action)", () => {
  it("shows instrument help, writes nothing, and does not default an agent", () => {
    const { stdout, stderr, status } = runCli("instrument");
    expect(status).not.toBe(0);
    // Help is human text → stderr; stdout stays clean (no prompt, no JSON).
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage: traceroot instrument");
    expect(stderr).not.toContain("Wrote instrument prompt");
  });
});

describe("traceroot --json (root)", () => {
  it("prints normal help rather than JSON, since root has no JSON data operation", () => {
    const { stdout, stderr } = runCli("--json");
    // Acceptable: root --json yields help (on stderr per the output contract).
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage: traceroot");
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
