import { constants, accessSync, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ALL_AGENTS, requireAgent } from "../agents/index.js";
import type { AgentAdapter } from "../agents/types.js";
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

export interface DetectAgentsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Probes every known agent for two independent facts: whether it is
 * *configured* (a skills/config directory exists) and whether it is *runnable*
 * (its binary resolves on PATH). Only a runnable agent can be launched, so
 * conflating the two — as the CLI's existing `AgentAdapter.detect` does, since
 * it only checks directories — would let setup select an agent it cannot start.
 *
 * Each signal carries a human-readable reason so `setup doctor` can explain
 * itself rather than printing a bare boolean.
 */
export function detectAgents(options: DetectAgentsOptions): DetectedAgent[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  return ALL_AGENTS.map((adapter) => {
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
    // Validates against the adapter allowlist, so an unknown id fails with the
    // supported names rather than silently falling through.
    const adapter: AgentAdapter = requireAgent(requested);
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
        "Install Claude Code or Codex, then rerun `traceroot setup`.",
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
