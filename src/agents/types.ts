/**
 * Coding agents the CLI can install skills for. `claude` (Claude Code) and
 * `codex` (OpenAI Codex) are first-class; `generic` writes to a tool-neutral
 * `.agents/skills` location (e.g. for Cursor/Windsurf and other agents).
 */
export type AgentId = "claude" | "codex" | "generic";

/** Result of probing the working directory for an agent's presence. */
export interface AgentDetection {
  id: AgentId;
  /** Whether the agent's config directory already exists in the project. */
  present: boolean;
  /** Where this agent discovers skills (project-local, or global for Codex). */
  skillsDir: string;
}

/**
 * Per-agent knowledge: where skills live and how to phrase the next step. Actual
 * file copying is shared (see `skills/install.ts`); an adapter only decides the
 * destination path and the human-facing hints, so adding an agent stays cheap.
 */
export interface AgentAdapter {
  id: AgentId;
  /** Human-readable name, e.g. "Claude Code". */
  displayName: string;
  /**
   * Absolute install directory for a skill. Project-local agents resolve it
   * under `cwd`; global agents (e.g. Codex) ignore `cwd`.
   */
  getSkillInstallPath(cwd: string, skillName: string): string;
  /** Probe whether this agent is set up (relative to `cwd` for project-local agents). */
  detect(cwd: string): AgentDetection;
  /** One-line hint telling the user how to use the installed skill. */
  getUsageHint(skillName: string): string;
}
