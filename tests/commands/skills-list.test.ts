import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSkillsList } from "../../src/commands/skills/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

let cwd: string;
let codexHome: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tr-sklist-"));
  // Pin CODEX_HOME to an (empty) temp dir so codex install status is hermetic
  // and never reads the developer's real ~/.codex.
  codexHome = join(cwd, "codex-home");
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (prevCodexHome === undefined) {
    // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = prevCodexHome;
  }
  rmSync(cwd, { recursive: true, force: true });
});

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

function writeSkill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# skill", "utf8");
}
const installClaude = (name: string) => writeSkill(join(cwd, ".claude", "skills", name));
const installGeneric = (name: string) => writeSkill(join(cwd, ".agents", "skills", name));
const installCodex = (name: string) => writeSkill(join(codexHome, "skills", name));

describe("runSkillsList (human)", () => {
  it("shows an Install hint (no --agent) and no Installed block when a skill is installed nowhere", () => {
    const { writers, out } = makeWriters();
    runSkillsList({ cwd, json: false, writers });
    expect(out.data).toContain("- traceroot-instrument-repo");
    expect(out.data).toContain("- traceroot-quickstart");
    expect(out.data).toContain("Install: traceroot skills install traceroot-instrument-repo");
    expect(out.data).toContain("Install: traceroot skills install traceroot-quickstart");
    expect(out.data).not.toContain("--agent");
    expect(out.data).not.toContain("Installed:");
  });

  it("marks a skill ✓ and lists only the agents where it is installed", () => {
    installClaude("traceroot-instrument-repo");
    const { writers, out } = makeWriters();
    runSkillsList({ cwd, json: false, writers });
    expect(out.data).toContain("✓ traceroot-instrument-repo");
    expect(out.data).toContain("Installed:");
    expect(out.data).toContain("Claude Code");
    expect(out.data).toContain(".claude/skills/traceroot-instrument-repo");
    // Not installed for Codex/generic → those rows are omitted.
    expect(out.data).not.toContain("Codex");
    expect(out.data).not.toContain("Agent (generic)");
    // The other skill is still a not-installed entry with an Install hint.
    expect(out.data).toContain("- traceroot-quickstart");
  });

  it("lists installed agents in claude → codex → generic order", () => {
    installClaude("traceroot-instrument-repo");
    installCodex("traceroot-instrument-repo");
    installGeneric("traceroot-instrument-repo");
    const { writers, out } = makeWriters();
    runSkillsList({ cwd, json: false, writers });
    const claudeAt = out.data.indexOf("Claude Code");
    const codexAt = out.data.indexOf("Codex");
    const genericAt = out.data.indexOf("Agent (generic)");
    expect(claudeAt).toBeGreaterThanOrEqual(0);
    expect(claudeAt).toBeLessThan(codexAt);
    expect(codexAt).toBeLessThan(genericAt);
  });

  it("dims installed paths when color is enabled", () => {
    installClaude("traceroot-instrument-repo");
    const out = new StringSink(true);
    const err = new StringSink(true);
    runSkillsList({ cwd, json: false, writers: { out, err } });
    expect(out.data).toContain("\x1b[2m.claude/skills/traceroot-instrument-repo\x1b[0m");
  });
});

describe("runSkillsList (--json)", () => {
  it("includes an agents array (all 3, stable order) with a top-level installed flag", () => {
    installClaude("traceroot-instrument-repo");
    const { writers, out, err } = makeWriters();
    runSkillsList({ cwd, json: true, writers });

    const parsed = JSON.parse(out.data) as {
      data: Array<{
        name: string;
        description: string;
        bestFor: string[];
        installed: boolean;
        agents: Array<{ agent: string; displayName: string; installed: boolean; path: string }>;
      }>;
    };
    expect(parsed.data).toHaveLength(2);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(err.data).toBe("");

    const instrument = parsed.data.find((s) => s.name === "traceroot-instrument-repo");
    expect(instrument?.installed).toBe(true); // installed for ≥1 agent
    expect(instrument?.agents.map((a) => a.agent)).toEqual(["claude", "codex", "generic"]);
    const claude = instrument?.agents.find((a) => a.agent === "claude");
    expect(claude).toMatchObject({
      displayName: "Claude Code",
      installed: true,
      path: ".claude/skills/traceroot-instrument-repo",
    });
    expect(instrument?.agents.find((a) => a.agent === "codex")?.installed).toBe(false);
    expect(instrument?.agents.find((a) => a.agent === "generic")?.installed).toBe(false);

    // A skill installed nowhere: top installed false, but the full agents array is present.
    const quickstart = parsed.data.find((s) => s.name === "traceroot-quickstart");
    expect(quickstart?.installed).toBe(false);
    expect(quickstart?.agents).toHaveLength(3);
    expect(quickstart?.agents.every((a) => !a.installed)).toBe(true);
  });

  it("sets top-level installed true when only codex has the skill", () => {
    installCodex("traceroot-quickstart");
    const { writers, out } = makeWriters();
    runSkillsList({ cwd, json: true, writers });
    const parsed = JSON.parse(out.data) as {
      data: Array<{
        name: string;
        installed: boolean;
        agents: Array<{ agent: string; installed: boolean }>;
      }>;
    };
    const quickstart = parsed.data.find((s) => s.name === "traceroot-quickstart");
    expect(quickstart?.installed).toBe(true);
    expect(quickstart?.agents.find((a) => a.agent === "codex")?.installed).toBe(true);
    expect(quickstart?.agents.find((a) => a.agent === "claude")?.installed).toBe(false);
  });
});
