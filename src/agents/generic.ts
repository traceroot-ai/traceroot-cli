import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentDetection } from "./types.js";

/** Tool-neutral skills directory shared by non-Claude agents. */
const AGENTS_DIR = ".agents";
const SKILLS_SUBDIR = "skills";

/**
 * Generic adapter for agents that follow the tool-neutral `.agents/skills/`
 * convention. Cursor, Windsurf, and other non-first-class agents can map here
 * without bespoke adapters (Codex has its own first-class adapter).
 */
export const genericAdapter: AgentAdapter = {
  id: "generic",
  displayName: "Agent (generic)",
  getSkillInstallPath(cwd: string, skillName: string): string {
    return join(cwd, AGENTS_DIR, SKILLS_SUBDIR, skillName);
  },
  detect(cwd: string): AgentDetection {
    const skillsDir = join(cwd, AGENTS_DIR, SKILLS_SUBDIR);
    return { id: "generic", present: existsSync(join(cwd, AGENTS_DIR)), skillsDir };
  },
  getUsageHint(skillName: string): string {
    return `Point your agent at .agents/skills/${skillName} to use this skill.`;
  },
};
