import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSkillsInstall } from "../../src/commands/skills/install.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tr-skinstall-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const base = {
  agentId: "claude",
  force: false,
  dryRun: false,
};

describe("runSkillsInstall (human)", () => {
  it("installs the skill files under .claude/skills and prints a success block", async () => {
    const { writers, out } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-instrument-repo",
      cwd,
      json: false,
      writers,
    });

    expect(
      existsSync(join(cwd, ".claude", "skills", "traceroot-instrument-repo", "SKILL.md")),
    ).toBe(true);
    expect(out.data).toContain("Installed TraceRoot skill");
    expect(out.data).toContain(".claude/skills/traceroot-instrument-repo");
  });

  it("refuses to overwrite an existing skill without --force (actionable message)", async () => {
    const { writers } = makeWriters();
    const args = { ...base, skillName: "traceroot-quickstart", cwd, json: false, writers } as const;
    await runSkillsInstall(args);
    await expect(runSkillsInstall(args)).rejects.toThrow(/already exists[\s\S]*--force/);
  });

  it("overwrites with --force", async () => {
    const { writers } = makeWriters();
    const args = { ...base, skillName: "traceroot-quickstart", cwd, json: false, writers };
    await runSkillsInstall(args);
    await expect(runSkillsInstall({ ...args, force: true })).resolves.toBeUndefined();
  });

  it("writes nothing in --dry-run mode", async () => {
    const { writers, out } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-quickstart",
      cwd,
      dryRun: true,
      json: false,
      writers,
    });
    expect(existsSync(join(cwd, ".claude", "skills", "traceroot-quickstart"))).toBe(false);
    expect(out.data).toContain("Dry run");
  });

  it("throws an actionable CliError for an unknown skill", async () => {
    const { writers } = makeWriters();
    await expect(
      runSkillsInstall({ ...base, skillName: "does-not-exist", cwd, json: false, writers }),
    ).rejects.toThrow(/Unknown skill/);
  });

  it("throws for an unknown agent", async () => {
    const { writers } = makeWriters();
    await expect(
      runSkillsInstall({
        ...base,
        agentId: "cursor",
        skillName: "traceroot-quickstart",
        cwd,
        json: false,
        writers,
      }),
    ).rejects.toThrow(/Unknown agent/);
  });
});

describe("runSkillsInstall (validation order)", () => {
  it("reports a missing skill (with valid names) before the missing agent", async () => {
    const { writers } = makeWriters();
    try {
      await runSkillsInstall({
        ...base,
        skillName: undefined,
        agentId: undefined,
        cwd,
        json: false,
        isInteractive: false,
        writers,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const msg = (err as CliError).message;
      expect(msg).toContain("Missing required argument <skill>");
      expect(msg).toContain("traceroot-instrument-repo, traceroot-quickstart");
      expect(msg).not.toContain("--agent");
    }
  });

  it("reports an unknown skill before the missing agent", async () => {
    const { writers } = makeWriters();
    await expect(
      runSkillsInstall({
        ...base,
        skillName: "test",
        agentId: undefined,
        cwd,
        json: false,
        isInteractive: false,
        writers,
      }),
    ).rejects.toThrow(/Unknown skill 'test'/);
  });
});

describe("runSkillsInstall (missing --agent)", () => {
  it("fails with an actionable error when non-interactive and writes nothing", async () => {
    const { writers, out } = makeWriters();
    try {
      await runSkillsInstall({
        ...base,
        agentId: undefined,
        skillName: "traceroot-quickstart",
        cwd,
        json: false,
        isInteractive: false,
        writers,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const msg = (err as CliError).message;
      expect(msg).toContain("--agent");
      expect(msg).toContain("claude, codex, generic");
      expect(msg).toContain("traceroot skills install traceroot-quickstart --agent claude");
    }
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(out.data).toBe("");
  });

  it("does not prompt or emit partial JSON in --json mode", async () => {
    const { writers, out } = makeWriters();
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt in JSON mode");
    };
    await expect(
      runSkillsInstall({
        ...base,
        agentId: undefined,
        skillName: "traceroot-quickstart",
        cwd,
        json: true,
        isInteractive: true,
        prompt,
        writers,
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(out.data).toBe("");
  });

  it("prompts interactively and installs using the selected agent (claude)", async () => {
    const { writers } = makeWriters();
    await runSkillsInstall({
      ...base,
      agentId: undefined,
      skillName: "traceroot-quickstart",
      cwd,
      json: false,
      isInteractive: true,
      prompt: async () => "claude",
      writers,
    });
    expect(existsSync(join(cwd, ".claude", "skills", "traceroot-quickstart", "SKILL.md"))).toBe(
      true,
    );
  });

  it("prompts interactively and installs using the selected agent (generic)", async () => {
    const { writers } = makeWriters();
    await runSkillsInstall({
      ...base,
      agentId: undefined,
      skillName: "traceroot-quickstart",
      cwd,
      json: false,
      isInteractive: true,
      prompt: async () => "generic",
      writers,
    });
    expect(existsSync(join(cwd, ".agents", "skills", "traceroot-quickstart", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });
});

describe("runSkillsInstall (--json)", () => {
  it("emits the documented data shape on a fresh install", async () => {
    const { writers, out, err } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-instrument-repo",
      cwd,
      json: true,
      writers,
    });

    const parsed = JSON.parse(out.data) as { data: Record<string, unknown> };
    expect(parsed.data).toEqual({
      skill: "traceroot-instrument-repo",
      agent: "claude",
      path: ".claude/skills/traceroot-instrument-repo",
      installed: true,
      overwritten: false,
    });
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(err.data).toBe("");
  });

  it("marks installed:false and dryRun:true for a JSON dry-run", async () => {
    const { writers, out } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-quickstart",
      cwd,
      dryRun: true,
      json: true,
      writers,
    });
    const parsed = JSON.parse(out.data) as { data: Record<string, unknown> };
    expect(parsed.data.installed).toBe(false);
    expect(parsed.data.dryRun).toBe(true);
    expect(existsSync(join(cwd, ".claude", "skills", "traceroot-quickstart"))).toBe(false);
  });
});

describe("runSkillsInstall (codex)", () => {
  it("installs into $CODEX_HOME/skills/<name> (not a project dir)", async () => {
    const prev = process.env.CODEX_HOME;
    const codexHome = join(cwd, "codex-home");
    process.env.CODEX_HOME = codexHome;
    try {
      const { writers } = makeWriters();
      await runSkillsInstall({
        ...base,
        agentId: "codex",
        skillName: "traceroot-quickstart",
        cwd,
        json: false,
        writers,
      });
      expect(existsSync(join(codexHome, "skills", "traceroot-quickstart", "SKILL.md"))).toBe(true);
      // Nothing is written under the project's .claude / .agents directories.
      expect(existsSync(join(cwd, ".claude"))).toBe(false);
      expect(existsSync(join(cwd, ".agents"))).toBe(false);
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prev;
      }
    }
  });
});
