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

describe("subcommand help: native Options vs Global Options", () => {
  for (const cmd of [["skills", "list"], ["skills", "install"], ["instrument"], ["doctor"]]) {
    it(`groups --json/--api-key/--host/--env-file under Global Options for \`${cmd.join(" ")}\``, () => {
      const { stdout } = runCli(...cmd, "--help");
      const [options, global] = stdout.split("Global Options:");
      // There is a dedicated Global Options section…
      expect(global).toBeDefined();
      // …carrying the inherited program-wide flags.
      expect(global).toContain("--json");
      expect(global).toContain("--api-key");
      expect(global).toContain("--host");
      expect(global).toContain("--env-file");
      // …and the native Options section does NOT list --json.
      expect(options).toContain("Options:");
      expect(options).not.toContain("--json");
    });
  }

  it("keeps native flags (e.g. --agent) in the command's own Options section", () => {
    const { stdout } = runCli("skills", "install", "--help");
    const beforeGlobal = stdout.split("Global Options:")[0] ?? "";
    expect(beforeGlobal).toContain("--agent <agent>");
  });
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

describe("traceroot instrument (bare, non-interactive)", () => {
  it("errors for the missing agent (no prompt, no write) when not a TTY", () => {
    const { stdout, stderr, status } = runCli("instrument");
    expect(status).not.toBe(0);
    // Non-interactive: no prompt, clean stdout, actionable agent error on stderr.
    expect(stdout).toBe("");
    expect(stderr).toContain("Missing required option --agent");
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
