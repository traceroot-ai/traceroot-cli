import { constants, accessSync, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ALL_AGENTS } from "../agents/index.js";
import type { AgentAdapter, AgentId } from "../agents/types.js";
import { SetupError } from "./errors.js";
import type { SelectFn } from "./select.js";
import type { DetectedAgent } from "./types.js";

/**
 * Resolves an executable on PATH. Node has no built-in `which`, and shelling
 * out to one would be slower and less portable than reading PATH directly.
 *
 * On Windows a bare name is not executable, so the PATHEXT suffixes are tried
 * as well.
 */
export function resolveOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathVar = env.PATH ?? env.Path;
  if (pathVar === undefined || pathVar === "") {
    return null;
  }
  const suffixes =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((s) => s.toLowerCase())
      : [""];

  for (const dir of pathVar.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    for (const suffix of suffixes) {
      const candidate = join(dir, `${binary}${suffix}`);
      try {
        if (statSync(candidate).isFile()) {
          // Executable, not merely present: a non-executable file of the right
          // name would otherwise be reported as runnable and auto-selected, and
          // the failure surfaces much later as a spawn error. This is what
          // `execvp` checks too.
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        // not present, or unreadable — keep looking
      }
    }
  }
  return null;
}

/**
 * The agents setup will run on the user's behalf.
 *
 * Deliberately narrower than {@link ALL_AGENTS}, which is the list the CLI
 * installs skills for. Installing a skill asks nothing of an agent. Driving one
 * headless through install, edit, run and report asks for a writable workspace,
 * network access, a package-manager cache the agent is allowed to write, and an
 * environment this CLI controls rather than one the user's shell profile
 * re-exports over the top of. A place here is earned by a recorded run of this
 * pipeline that reached a trace, for each package manager the language has —
 * not by the agent being installable.
 *
 * An agent that is not on this list is still a first-class skill target, and
 * `--no-instrument` still writes the instrumentation task out for it.
 */
const LAUNCHABLE_AGENT_IDS: readonly AgentId[] = ["claude"];

/** {@link LAUNCHABLE_AGENT_IDS} as adapters, in the registry's stable order. */
export const LAUNCHABLE_AGENTS: readonly AgentAdapter[] = ALL_AGENTS.filter((adapter) =>
  LAUNCHABLE_AGENT_IDS.includes(adapter.id),
);

export interface DetectAgentsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Probes each agent setup can run for two independent facts: whether it is
 * *configured* (a skills/config directory exists) and whether it is *runnable*
 * (its binary resolves on PATH). Only a runnable agent can be launched, so
 * conflating the two — as the CLI's existing `AgentAdapter.detect` does, since
 * it only checks directories — would let setup select an agent it cannot start.
 *
 * {@link LAUNCHABLE_AGENTS} rather than every adapter the CLI knows: an agent
 * reported here becomes a run option, and offering one whose headless run has
 * not been established is the same error one step earlier.
 *
 * Each signal carries a human-readable reason so `setup doctor` can explain
 * itself rather than printing a bare boolean.
 */
export function detectAgents(options: DetectAgentsOptions): DetectedAgent[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  return LAUNCHABLE_AGENTS.map((adapter) => {
    const evidence: string[] = [];

    const detection = adapter.detect(options.cwd);
    const configured = detection.present || existsSync(detection.skillsDir);
    if (detection.present) {
      evidence.push(`${adapter.displayName} configuration directory found`);
    }
    if (existsSync(join(detection.skillsDir, "traceroot-instrument-repo", "SKILL.md"))) {
      evidence.push("TraceRoot instrumentation skill already installed");
    }

    let runnable = false;
    if (adapter.binary !== undefined) {
      const resolved = resolveOnPath(adapter.binary, env, platform);
      runnable = resolved !== null;
      if (runnable) {
        evidence.push(`\`${adapter.binary}\` found on PATH`);
      }
    }

    return {
      id: adapter.id,
      displayName: adapter.displayName,
      runnable,
      configured,
      evidence,
    };
  });
}

export interface SelectAgentInput {
  detected: DetectedAgent[];
  /** The `--agent` value, when the user supplied one. */
  requested?: string;
  canPrompt: boolean;
  select: SelectFn;
  /** Warning sink for the "requested but not on PATH" case. */
  warn: (message: string) => void;
}

/**
 * The adapter for an explicitly requested agent, when setup can run it.
 *
 * `requireAgent` validates against the whole registry, which is the right list
 * for `skills install` and the wrong one here: it accepts an agent whose
 * headless run has never been established, and the failure then surfaces
 * somewhere inside that agent rather than at the flag that named it.
 */
function requireLaunchableAgent(id: string): AgentAdapter {
  const adapter = LAUNCHABLE_AGENTS.find((a) => a.id === id);
  if (adapter === undefined) {
    throw new SetupError({
      stage: "select_agent",
      code: "UNSUPPORTED",
      message: `Setup cannot run '${id}'. It can run: ${LAUNCHABLE_AGENTS.map((a) => a.id).join(", ")}.`,
      remedy: [
        "Name one of those, or write the instrumentation task out and run it with the agent you prefer:",
        "  traceroot setup --no-instrument",
      ].join("\n"),
    });
  }
  return adapter;
}

/**
 * Resolution ladder, in the shape the CLI already uses for skills and agents
 * elsewhere: an explicit flag always wins; exactly one runnable agent
 * auto-selects; several runnable agents prompt when that is possible and
 * otherwise fail naming the flag to pass; none runnable is an unsupported-
 * environment error that points at `--no-instrument`, which still produces a
 * usable prompt file.
 *
 * An explicitly requested agent is honoured even when its binary is not on
 * PATH — with a warning. The user may be running a wrapper, an alias, or an
 * agent installed after this shell started, and refusing would be presumptuous.
 */
export async function selectAgent(input: SelectAgentInput): Promise<DetectedAgent> {
  const { detected, requested, canPrompt } = input;

  if (requested !== undefined) {
    // Validates against the agents setup can run, so an id it cannot drive
    // fails here with the names it can rather than inside that agent later.
    const adapter: AgentAdapter = requireLaunchableAgent(requested);
    const match = detected.find((d) => d.id === adapter.id);
    const resolved: DetectedAgent = match ?? {
      id: adapter.id,
      displayName: adapter.displayName,
      runnable: false,
      configured: false,
      evidence: [],
    };
    if (!resolved.runnable && adapter.binary !== undefined) {
      input.warn(
        `\`${adapter.binary}\` was not found on PATH; setup will still try to launch ${adapter.displayName}.`,
      );
    }
    return resolved;
  }

  const runnable = detected.filter((d) => d.runnable);

  const only = runnable[0];
  if (runnable.length === 1 && only !== undefined) {
    return only;
  }

  if (runnable.length === 0 || only === undefined) {
    throw new SetupError({
      stage: "select_agent",
      code: "UNSUPPORTED",
      message: "No coding agent was found on PATH, so setup cannot run one for you.",
      remedy: [
        // Named from the list rather than spelled out, so the two cannot drift.
        `Install ${LAUNCHABLE_AGENTS.map((a) => a.displayName).join(" or ")}, then rerun \`traceroot setup\`.`,
        "Or generate the instrumentation prompt and run it yourself:",
        "  traceroot setup --no-instrument",
      ].join("\n"),
    });
  }

  if (!canPrompt) {
    throw new SetupError({
      stage: "select_agent",
      code: "AMBIGUOUS",
      message: `Several coding agents are available: ${runnable.map((a) => a.id).join(", ")}.`,
      remedy: `Pick one with --agent, for example:\n  traceroot setup --agent ${only.id}`,
    });
  }

  const chosenId = await input.select({
    stage: "select_agent",
    message: "Which coding agent should instrument this service?",
    options: runnable.map((a) => ({ value: a.id, label: a.displayName })),
  });
  const chosen = runnable.find((a) => a.id === chosenId);
  if (chosen === undefined) {
    throw new SetupError({
      stage: "select_agent",
      code: "AMBIGUOUS",
      message: `'${chosenId}' is not one of the available agents.`,
    });
  }
  return chosen;
}
