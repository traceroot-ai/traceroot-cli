import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("suggests the bare `traceroot instrument` (no flags) after installing the instrumentation skill", async () => {
    const { writers, err } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-instrument-repo",
      cwd,
      json: false,
      writers,
    });
    expect(err.data).toContain("Next: traceroot instrument");
    expect(err.data).not.toContain("--agent");
    expect(err.data).not.toContain("--print");
  });

  it("dims the install path in the result block when color is enabled", async () => {
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-quickstart",
      cwd,
      json: false,
      writers: { out, err },
    });
    expect(out.data).toContain("\x1b[2m.claude/skills/traceroot-quickstart\x1b[0m");
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

/** A prompt fn keyed on the question text, returning scripted answers per field. */
function scripted(answers: { skill?: string; agent?: string; overwrite?: string }) {
  return async (q: string): Promise<string> => {
    // Keyed on the question's leading word so a dimmed "(default: …)" hint
    // (ANSI codes) does not affect matching.
    if (q.includes("Overwrite?")) return answers.overwrite ?? "";
    if (q.startsWith("Agent")) return answers.agent ?? "";
    if (q.startsWith("Skill")) return answers.skill ?? "";
    throw new Error(`unexpected prompt: ${q}`);
  };
}

describe("runSkillsInstall (interactive)", () => {
  it("bare command prompts for skill then agent; empty input picks the defaults", async () => {
    const { writers, err } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: undefined,
      agentId: undefined,
      cwd,
      json: false,
      isInteractive: true,
      prompt: scripted({ skill: "", agent: "" }),
      writers,
    });
    // Empty skill → instrument-repo, empty agent → claude (Claude Code path).
    expect(
      existsSync(join(cwd, ".claude", "skills", "traceroot-instrument-repo", "SKILL.md")),
    ).toBe(true);
    expect(err.data).toContain("Available skills:");
  });

  it("with a provided skill, prompts only for the agent", async () => {
    const { writers, err } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-quickstart",
      agentId: undefined,
      cwd,
      json: false,
      isInteractive: true,
      // A project-local agent keeps the test hermetic (codex would touch ~/.codex).
      prompt: scripted({ agent: "generic" }),
      writers,
    });
    // No skill list shown (skill already known); agent prompt drove the install.
    expect(err.data).not.toContain("Available skills:");
    expect(existsSync(join(cwd, ".agents", "skills", "traceroot-quickstart", "SKILL.md"))).toBe(
      true,
    );
  });

  it("with a provided agent, prompts only for the skill", async () => {
    const { writers } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: undefined,
      agentId: "generic",
      cwd,
      json: false,
      isInteractive: true,
      prompt: scripted({ skill: "traceroot-quickstart" }),
      writers,
    });
    expect(existsSync(join(cwd, ".agents", "skills", "traceroot-quickstart", "SKILL.md"))).toBe(
      true,
    );
  });

  it("with explicit skill and agent, prompts for nothing", async () => {
    const { writers } = makeWriters();
    const prompt = async (q: string): Promise<string> => {
      throw new Error(`should not prompt: ${q}`);
    };
    await runSkillsInstall({
      ...base,
      skillName: "traceroot-quickstart",
      agentId: "claude",
      cwd,
      json: false,
      isInteractive: true,
      prompt,
      writers,
    });
    expect(existsSync(join(cwd, ".claude", "skills", "traceroot-quickstart"))).toBe(true);
  });

  it("dry-run still prompts for missing values but writes nothing", async () => {
    const { writers } = makeWriters();
    await runSkillsInstall({
      ...base,
      skillName: undefined,
      agentId: undefined,
      cwd,
      dryRun: true,
      json: false,
      isInteractive: true,
      prompt: scripted({ skill: "", agent: "" }),
      writers,
    });
    expect(existsSync(join(cwd, ".claude", "skills"))).toBe(false);
  });
});

describe("runSkillsInstall (interactive overwrite)", () => {
  const seed = {
    ...base,
    skillName: "traceroot-quickstart",
    agentId: "claude",
    json: false,
    isInteractive: true,
  } as const;

  it("prefixes the overwrite prompt with a WARNING line", async () => {
    await runSkillsInstall({ ...seed, cwd, prompt: scripted({}), writers: makeWriters().writers });
    let asked = "";
    await runSkillsInstall({
      ...seed,
      cwd,
      prompt: async (q) => {
        if (q.includes("Overwrite?")) {
          asked = q;
          return "y";
        }
        return "";
      },
      writers: makeWriters().writers,
    });
    expect(asked).toContain("WARNING:");
    expect(asked).toContain("Skill already exists at");
  });

  it("prompts to overwrite an existing skill; 'y' overwrites", async () => {
    const first = makeWriters();
    await runSkillsInstall({ ...seed, cwd, prompt: scripted({}), writers: first.writers });
    const second = makeWriters();
    await runSkillsInstall({
      ...seed,
      cwd,
      prompt: scripted({ overwrite: "y" }),
      writers: second.writers,
    });
    expect(existsSync(join(cwd, ".claude", "skills", "traceroot-quickstart", "SKILL.md"))).toBe(
      true,
    );
  });

  it("aborts gracefully (no throw, plain message, no write) when overwrite is declined", async () => {
    await runSkillsInstall({ ...seed, cwd, prompt: scripted({}), writers: makeWriters().writers });
    const sentinel = join(cwd, ".claude", "skills", "traceroot-quickstart", "sentinel.txt");
    writeFileSync(sentinel, "keep", "utf8");
    const { writers, err } = makeWriters();
    // A user-initiated decline is not an error: it resolves (exit 0), no CliError.
    await expect(
      runSkillsInstall({ ...seed, cwd, prompt: scripted({ overwrite: "" }), writers }),
    ).resolves.toBeUndefined();
    expect(err.data).toContain("Aborted: skill not overwritten.");
    expect(err.data).not.toContain("error:");
    // Declined → existing content untouched.
    expect(existsSync(sentinel)).toBe(true);
  });

  it("--force skips the overwrite prompt", async () => {
    await runSkillsInstall({ ...seed, cwd, prompt: scripted({}), writers: makeWriters().writers });
    const prompt = async (q: string): Promise<string> => {
      throw new Error(`should not prompt with --force: ${q}`);
    };
    await expect(
      runSkillsInstall({ ...seed, cwd, force: true, prompt, writers: makeWriters().writers }),
    ).resolves.toBeUndefined();
  });
});
