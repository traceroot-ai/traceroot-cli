import { createInterface } from "node:readline";
import { type Writers, CliError, logInfo } from "../output.js";
import { AGENT_IDS, ALL_AGENTS, displaySkillPath, requireAgent } from "./index.js";
import type { AgentAdapter } from "./types.js";

/** Inputs for {@link resolveAgentOrPrompt}. `prompt`/`isInteractive` are injectable for tests. */
export interface ResolveAgentInput {
  /** The `--agent` value, if the user supplied one. */
  agentId?: string;
  cwd: string;
  /** JSON mode never prompts — it fails fast instead. */
  json: boolean;
  /** A ready-to-run example shown in the missing-agent error. */
  example: string;
  writers: Writers;
  /** Defaults to "stdin and stdout are both TTYs". */
  isInteractive?: boolean;
  /** Reads one line from the user; defaults to a readline prompt on stdout (matches `login`). */
  prompt?: (question: string) => Promise<string>;
}

/** Reads a visible line from stdin (same readline style as `login`'s prompts). */
function readLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Renders the choice menu from the registered adapters (no duplicated agent strings). */
function choiceMenu(cwd: string): string {
  const rows = ALL_AGENTS.map((agent) => {
    const dir = `${displaySkillPath(cwd, agent.detect(cwd).skillsDir)}/`;
    return `  ${agent.id.padEnd(8)} ${agent.displayName} — ${dir}`;
  });
  return ["Select a target agent:", ...rows].join("\n");
}

/**
 * Resolves the target agent. When `--agent` was supplied it is validated exactly
 * as before (`requireAgent`). When it is missing: in an interactive TTY the user
 * is shown the choices and prompted; in non-interactive or `--json` mode no
 * prompt is shown and a {@link CliError} with an actionable message is thrown
 * (so no partial output or prompt text leaks). The choices and their install
 * locations are derived from the registered adapters.
 */
export async function resolveAgentOrPrompt(input: ResolveAgentInput): Promise<AgentAdapter> {
  const { agentId, cwd, json, example, writers } = input;

  if (agentId !== undefined) {
    return requireAgent(agentId);
  }

  const interactive =
    input.isInteractive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

  if (json || !interactive) {
    throw new CliError(
      `Missing required option --agent.\nChoose one of: ${AGENT_IDS.join(", ")}.\nExample:\n  ${example}`,
    );
  }

  const prompt = input.prompt ?? readLine;
  logInfo(choiceMenu(cwd), writers);
  const answer = (await prompt(`Agent (${AGENT_IDS.join("/")}): `)).trim();
  // Validates the selection; an empty/unknown answer throws the standard CliError.
  return requireAgent(answer);
}
