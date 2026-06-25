import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { claudeAdapter } from "../../src/agents/claude.js";
import { codexAdapter } from "../../src/agents/codex.js";
import { genericAdapter } from "../../src/agents/generic.js";
import { AGENT_IDS, displaySkillPath, requireAgent } from "../../src/agents/index.js";
import { CliError } from "../../src/output.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-agent-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("claude adapter", () => {
  it("computes the .claude/skills/<name> install path", () => {
    expect(claudeAdapter.getSkillInstallPath(dir, "traceroot-quickstart")).toBe(
      join(dir, ".claude", "skills", "traceroot-quickstart"),
    );
  });

  it("detects absence and presence of the .claude directory", () => {
    expect(claudeAdapter.detect(dir).present).toBe(false);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const detection = claudeAdapter.detect(dir);
    expect(detection.present).toBe(true);
    expect(detection.skillsDir).toBe(join(dir, ".claude", "skills"));
  });
});

describe("generic adapter", () => {
  it("computes the .agents/skills/<name> install path", () => {
    expect(genericAdapter.getSkillInstallPath(dir, "traceroot-quickstart")).toBe(
      join(dir, ".agents", "skills", "traceroot-quickstart"),
    );
  });
});

describe("codex adapter", () => {
  it("installs to $CODEX_HOME/skills/<name> and ignores cwd", () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(dir, "codex-home");
    try {
      expect(codexAdapter.getSkillInstallPath("/some/other/cwd", "traceroot-quickstart")).toBe(
        join(dir, "codex-home", "skills", "traceroot-quickstart"),
      );
      expect(codexAdapter.detect(dir).skillsDir).toBe(join(dir, "codex-home", "skills"));
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prev;
      }
    }
  });

  it("falls back to ~/.codex/skills when CODEX_HOME is unset", () => {
    const prev = process.env.CODEX_HOME;
    // biome-ignore lint/performance/noDelete: unset the var for this case; assigning undefined would stringify it
    delete process.env.CODEX_HOME;
    try {
      expect(codexAdapter.getSkillInstallPath(dir, "traceroot-quickstart")).toBe(
        join(homedir(), ".codex", "skills", "traceroot-quickstart"),
      );
    } finally {
      if (prev !== undefined) {
        process.env.CODEX_HOME = prev;
      }
    }
  });
});

describe("requireAgent", () => {
  it("resolves known agents", () => {
    expect(requireAgent("claude").id).toBe("claude");
    expect(requireAgent("codex").id).toBe("codex");
    expect(requireAgent("generic").id).toBe("generic");
    expect(AGENT_IDS).toEqual(["claude", "codex", "generic"]);
  });

  it("throws an actionable CliError for an unknown agent", () => {
    try {
      requireAgent("windsurf");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("Unknown agent");
    }
  });
});

describe("displaySkillPath", () => {
  it("returns a project-relative path when the target is inside cwd", () => {
    expect(displaySkillPath(dir, join(dir, ".claude", "skills", "x"))).toBe(
      join(".claude", "skills", "x"),
    );
  });

  it("abbreviates the home directory to ~ for global (out-of-project) paths", () => {
    const target = join(homedir(), ".codex", "skills", "x");
    expect(displaySkillPath(dir, target)).toBe("~/.codex/skills/x");
  });
});
