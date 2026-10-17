import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { CliError, ExitCode } from "../output.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { genericAdapter } from "./generic.js";
import type { AgentAdapter, AgentId } from "./types.js";

/** All agent adapters, in stable order. */
export const ALL_AGENTS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter, genericAdapter];

/** Valid `--agent` values, for validation and help text. */
export const AGENT_IDS: readonly AgentId[] = ALL_AGENTS.map((a) => a.id);

/**
 * Resolves an agent adapter by id, throwing a {@link CliError} with the valid
 * choices when the id is unknown.
 */
export function requireAgent(id: string): AgentAdapter {
  const adapter = ALL_AGENTS.find((a) => a.id === id);
  if (adapter === undefined) {
    throw new CliError(
      `Unknown agent '${id}'. Supported agents: ${AGENT_IDS.join(", ")}.`,
      ExitCode.usage,
    );
  }
  return adapter;
}

/**
 * Whether `target` lies inside `dir` — the same test {@link displaySkillPath}
 * uses to decide whether a path can be shown relative to it.
 */
export function isInsideDirectory(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Renders a skill install path for display: relative to `cwd` when it lives
 * inside the project (e.g. `.claude/skills/<name>`), otherwise an absolute path
 * with the home directory abbreviated to `~` (e.g. `~/.codex/skills/<name>` for
 * Codex's global location).
 */
export function displaySkillPath(cwd: string, target: string): string {
  if (isInsideDirectory(cwd, target)) {
    return relative(cwd, target);
  }
  const home = homedir();
  if (target === home) {
    return "~";
  }
  if (target.startsWith(home + sep)) {
    return `~${target.slice(home.length)}`;
  }
  return target;
}
