import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentDetection } from "./types.js";

/** The project-local directory Claude Code discovers skills from. */
const CLAUDE_DIR = ".claude";
const SKILLS_SUBDIR = "skills";

/**
 * Adapter for Claude Code. Skills install to `<cwd>/.claude/skills/<name>/`,
 * the standard project-local skill discovery path.
 */
export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  getSkillInstallPath(cwd: string, skillName: string): string {
    return join(cwd, CLAUDE_DIR, SKILLS_SUBDIR, skillName);
  },
  detect(cwd: string): AgentDetection {
    const skillsDir = join(cwd, CLAUDE_DIR, SKILLS_SUBDIR);
    return { id: "claude", present: existsSync(join(cwd, CLAUDE_DIR)), skillsDir };
  },
  getUsageHint(skillName: string): string {
    return `Open Claude Code in this repo and the "${skillName}" skill will be available.`;
  },
};
