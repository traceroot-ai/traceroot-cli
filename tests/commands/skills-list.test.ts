import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSkillsList } from "../../src/commands/skills/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tr-sklist-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

/** Marks a skill installed for the claude agent under `cwd`. */
function installClaudeSkill(name: string): void {
  const dir = join(cwd, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# skill", "utf8");
}

describe("runSkillsList (human)", () => {
  it("lists both skills with an Install hint when none are installed", () => {
    const { writers, out } = makeWriters();
    runSkillsList({ agentId: "claude", cwd, json: false, writers });
    expect(out.data).toContain("traceroot-instrument-repo");
    expect(out.data).toContain("traceroot-quickstart");
    expect(out.data).toContain("Best for:");
    expect(out.data).toContain("Install: traceroot skills install traceroot-instrument-repo");
    // Not installed → neutral marker, not the installed check.
    expect(out.data).toContain("- traceroot-instrument-repo");
  });

  it("shows installed status and path for an installed skill", () => {
    installClaudeSkill("traceroot-instrument-repo");
    const { writers, out } = makeWriters();
    runSkillsList({ agentId: "claude", cwd, json: false, writers });
    expect(out.data).toContain("✓ traceroot-instrument-repo");
    expect(out.data).toContain(
      "Installed for Claude Code: .claude/skills/traceroot-instrument-repo",
    );
  });
});

describe("runSkillsList (--json)", () => {
  it("emits one document with the documented per-skill shape", () => {
    installClaudeSkill("traceroot-instrument-repo");
    const { writers, out, err } = makeWriters();
    runSkillsList({ agentId: "claude", cwd, json: true, writers });

    const parsed = JSON.parse(out.data) as {
      data: Array<{
        name: string;
        description: string;
        bestFor: string[];
        agent: string;
        installed: boolean;
        path: string;
      }>;
    };
    expect(parsed.data).toHaveLength(2);
    const instrument = parsed.data.find((s) => s.name === "traceroot-instrument-repo");
    expect(instrument).toMatchObject({
      agent: "claude",
      installed: true,
      path: ".claude/skills/traceroot-instrument-repo",
    });
    expect(instrument?.bestFor.length).toBeGreaterThan(0);
    const quickstart = parsed.data.find((s) => s.name === "traceroot-quickstart");
    expect(quickstart?.installed).toBe(false);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(err.data).toBe("");
  });
});

describe("runSkillsList (--agent)", () => {
  it("reports the .agents/skills path for the generic agent", () => {
    const { writers, out } = makeWriters();
    runSkillsList({ agentId: "generic", cwd, json: true, writers });
    const parsed = JSON.parse(out.data) as { data: Array<{ agent: string; path: string }> };
    expect(parsed.data[0]?.agent).toBe("generic");
    expect(parsed.data[0]?.path).toContain(".agents/skills/");
  });

  it("reports a CODEX_HOME-relative path for the codex agent", () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(cwd, "codex-home");
    try {
      const { writers, out } = makeWriters();
      runSkillsList({ agentId: "codex", cwd, json: true, writers });
      const parsed = JSON.parse(out.data) as { data: Array<{ agent: string; path: string }> };
      expect(parsed.data[0]?.agent).toBe("codex");
      expect(parsed.data[0]?.path).toContain(join("codex-home", "skills"));
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prev;
      }
    }
  });

  it("rejects an unknown agent", () => {
    const { writers } = makeWriters();
    expect(() => runSkillsList({ agentId: "windsurf", cwd, json: true, writers })).toThrow(
      /Unknown agent/,
    );
  });
});
