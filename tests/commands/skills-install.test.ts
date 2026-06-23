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
  it("installs the skill files under .claude/skills and prints a success block", () => {
    const { writers, out } = makeWriters();
    runSkillsInstall({
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

  it("refuses to overwrite an existing skill without --force (actionable message)", () => {
    const { writers } = makeWriters();
    const args = {
      ...base,
      skillName: "traceroot-quickstart",
      cwd,
      json: false,
      writers,
    } as const;
    runSkillsInstall(args);

    try {
      runSkillsInstall(args);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("already exists");
      expect((err as CliError).message).toContain("--force");
    }
  });

  it("overwrites with --force", () => {
    const { writers } = makeWriters();
    const args = { ...base, skillName: "traceroot-quickstart", cwd, json: false, writers };
    runSkillsInstall(args);
    expect(() => runSkillsInstall({ ...args, force: true })).not.toThrow();
  });

  it("writes nothing in --dry-run mode", () => {
    const { writers, out } = makeWriters();
    runSkillsInstall({
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

  it("throws an actionable CliError for an unknown skill", () => {
    const { writers } = makeWriters();
    expect(() =>
      runSkillsInstall({ ...base, skillName: "does-not-exist", cwd, json: false, writers }),
    ).toThrow(/Unknown skill/);
  });

  it("throws for an unknown agent", () => {
    const { writers } = makeWriters();
    expect(() =>
      runSkillsInstall({
        ...base,
        agentId: "cursor",
        skillName: "traceroot-quickstart",
        cwd,
        json: false,
        writers,
      }),
    ).toThrow(/Unknown agent/);
  });
});

describe("runSkillsInstall (--json)", () => {
  it("emits the documented data shape on a fresh install", () => {
    const { writers, out, err } = makeWriters();
    runSkillsInstall({
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

  it("marks installed:false and dryRun:true for a JSON dry-run", () => {
    const { writers, out } = makeWriters();
    runSkillsInstall({
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
  it("installs into $CODEX_HOME/skills/<name> (not a project dir)", () => {
    const prev = process.env.CODEX_HOME;
    const codexHome = join(cwd, "codex-home");
    process.env.CODEX_HOME = codexHome;
    try {
      const { writers } = makeWriters();
      runSkillsInstall({
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
