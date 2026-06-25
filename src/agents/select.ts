import { CliError } from "../output.js";
import { type Prompt, dim, isInteractive, readLine } from "../prompt.js";
import { AGENT_IDS, requireAgent } from "./index.js";
import type { AgentAdapter, AgentId } from "./types.js";

/** The agent chosen when the user presses Enter at the prompt. */
const DEFAULT_AGENT: AgentId = "claude";

/** Inputs for {@link resolveAgentOrPrompt}. `prompt`/`isInteractive` are injectable for tests. */
export interface ResolveAgentInput {
  /** The `--agent` value, if the user supplied one. */
  agentId?: string;
  /** JSON mode never prompts — it fails fast instead. */
  json: boolean;
  /** A ready-to-run example shown in the missing-agent error. */
  example: string;
  /** Defaults to "stdin and stdout are both TTYs". */
  isInteractive?: boolean;
  /** Reads one line from the user; defaults to a readline prompt on stdout (matches `login`). */
  prompt?: Prompt;
}

/**
 * Resolves the target agent. When `--agent` was supplied it is validated exactly
 * as before (`requireAgent`). When it is missing: in an interactive TTY the user
 * is asked for it as plain text (login-style), with the valid options shown on
 * one line and Enter accepting the default (`claude`). In non-interactive or
 * `--json` mode no prompt is shown and a {@link CliError} with an actionable
 * message is thrown (so no partial output or prompt text leaks).
 */
export async function resolveAgentOrPrompt(input: ResolveAgentInput): Promise<AgentAdapter> {
  const { agentId, json, example } = input;

  if (agentId !== undefined) {
    return requireAgent(agentId);
  }

  const interactive = input.isInteractive ?? isInteractive();

  if (json || !interactive) {
    throw new CliError(
      `Missing required option --agent.\nChoose one of: ${AGENT_IDS.join(", ")}.\nExample:\n  ${example}`,
    );
  }

  const prompt = input.prompt ?? readLine;
  const answer = (
    await prompt(`Agent (${AGENT_IDS.join(", ")}) ${dim(`(default: ${DEFAULT_AGENT})`)}: `)
  ).trim();
  // Enter accepts the default; otherwise validate the typed value.
  return requireAgent(answer === "" ? DEFAULT_AGENT : answer);
}
