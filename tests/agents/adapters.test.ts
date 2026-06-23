import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/agents/claude.js";
import { genericAdapter } from "../../src/agents/generic.js";
import { AGENT_IDS, requireAgent } from "../../src/agents/index.js";
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

describe("requireAgent", () => {
  it("resolves known agents", () => {
    expect(requireAgent("claude").id).toBe("claude");
    expect(requireAgent("generic").id).toBe("generic");
    expect(AGENT_IDS).toEqual(["claude", "generic"]);
  });

  it("throws an actionable CliError for an unknown agent", () => {
    try {
      requireAgent("cursor");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("Unknown agent");
    }
  });
});
