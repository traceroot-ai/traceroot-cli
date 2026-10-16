import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentDetection } from "./types.js";

const SKILLS_SUBDIR = "skills";

/**
 * Codex discovers skills from a single user-level directory, not a project-local
 * one: `$CODEX_HOME/skills`, falling back to `~/.codex/skills` when `CODEX_HOME`
 * is unset. Resolved per-call so an overridden `CODEX_HOME` (e.g. in tests) is
 * always honored.
 */
function codexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".codex");
}

/**
 * Adapter for OpenAI Codex. Unlike Claude Code, Codex skills are global: they
 * install to `$CODEX_HOME/skills/<name>/` (`~/.codex/skills/<name>/` by default),
 * so `cwd` is intentionally ignored.
 */
export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  getSkillInstallPath(_cwd: string, skillName: string): string {
    return join(codexHome(), SKILLS_SUBDIR, skillName);
  },
  detect(_cwd: string): AgentDetection {
    const home = codexHome();
    return { id: "codex", present: existsSync(home), skillsDir: join(home, SKILLS_SUBDIR) };
  },
  getUsageHint(skillName: string): string {
    return `Codex will discover the "${skillName}" skill from ${join(codexHome(), SKILLS_SUBDIR)}.`;
  },
};
