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

  it("lists subcommands by name only — no 'instrument [options]' in the summary", () => {
    const { stdout } = runCli("--help");
    expect(stdout).toContain("instrument");
    expect(stdout).not.toContain("instrument [options]");
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
      // …and the command's own (pre-"Global Options") section never lists --json.
      // Flagless commands like `doctor`/`skills list` may have no "Options:"
      // section at all now that `-h, --help` lives under Global Options.
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

  it("skills list has no --agent option (it reports all agents)", () => {
    const { stdout } = runCli("skills", "list", "--help");
    expect(stdout).not.toContain("--agent");
  });

  it("rejects skills list --agent as an unknown option (not silently accepted)", () => {
    const { stdout, stderr, status } = runCli("skills", "list", "--agent", "claude");
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown option");
    expect(stderr).toContain("--agent");
  });
});

describe("traceroot instrument (bare, non-interactive)", () => {
  it("bare instrument fails cleanly in non-interactive mode instead of prompting", () => {
    const { stdout, stderr, status } = runCli("instrument");
    expect(status).not.toBe(0);
    // Non-interactive: no prompt, clean stdout, actionable agent error on stderr.
    expect(stdout).toBe("");
    expect(stderr).toContain("Missing required option --agent");
    expect(stderr).not.toContain("Wrote instrument prompt");
  });
});

describe("global --json position for new commands (spawned)", () => {
  it("accepts --json in the trailing position and emits one JSON document", () => {
    const { stdout, status } = runCli("skills", "list", "--json");
    expect(status).toBe(0);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(stdout) as { data: unknown[] };
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  it("accepts --json in the leading position too", () => {
    const { stdout, status } = runCli("--json", "skills", "list");
    expect(status).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
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
