/**
 * Coding agents the CLI can install skills for. `claude` (Claude Code) is fully
 * supported; `generic` writes to a tool-neutral `.agents/skills` location.
 * Codex/Cursor/Windsurf are intentionally not separate adapters yet — they
 * share the generic convention.
 */
export type AgentId = "claude" | "generic";

/** Result of probing the working directory for an agent's presence. */
export interface AgentDetection {
  id: AgentId;
  /** Whether the agent's config directory already exists in the project. */
  present: boolean;
  /** Where this agent discovers project-local skills. */
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
  /** Absolute install directory for a skill under `cwd`. */
  getSkillInstallPath(cwd: string, skillName: string): string;
  /** Probe whether this agent is set up in `cwd`. */
  detect(cwd: string): AgentDetection;
  /** One-line hint telling the user how to use the installed skill. */
  getUsageHint(skillName: string): string;
}
