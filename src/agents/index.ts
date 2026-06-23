import { CliError } from "../output.js";
import { claudeAdapter } from "./claude.js";
import { genericAdapter } from "./generic.js";
import type { AgentAdapter, AgentId } from "./types.js";

/** All agent adapters, in stable order. */
export const ALL_AGENTS: readonly AgentAdapter[] = [claudeAdapter, genericAdapter];

/** Valid `--agent` values, for validation and help text. */
export const AGENT_IDS: readonly AgentId[] = ALL_AGENTS.map((a) => a.id);

/**
 * Resolves an agent adapter by id, throwing a {@link CliError} with the valid
 * choices when the id is unknown.
 */
export function requireAgent(id: string): AgentAdapter {
  const adapter = ALL_AGENTS.find((a) => a.id === id);
  if (adapter === undefined) {
    throw new CliError(`Unknown agent '${id}'. Supported agents: ${AGENT_IDS.join(", ")}.`);
  }
  return adapter;
}
