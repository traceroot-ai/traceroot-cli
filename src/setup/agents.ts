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
 * re-exports over the top of.
 *
 * The two entries are not on this list on the same evidence, and the comment
 * that used to stand here claimed otherwise. It said a place was "earned by a
 * recorded run of this pipeline that reached a trace, for each package manager
 * the language has". That is still the bar Claude Code cleared, and it is not
 * the bar Codex cleared:
 *
 * - `claude` — recorded runs of this pipeline, through to a trace, per package
 *   manager. The strong case, and the one the sentence above described.
 * - `codex` — its headless interface read off OpenAI's published Codex
 *   documentation (`codex exec`, a prompt on stdin via `-`, the
 *   `workspace-write` sandbox, and the config overrides for approvals and
 *   sandbox network access; see `buildInvocation` in ./launch.ts). No run of this
 *   pipeline has driven Codex to a trace, on any package manager. What is
 *   established is that the invocation is spelled out of documented flags
 *   rather than guessed at; what is not established is that a Codex run of
 *   *this* task installs an SDK, edits an entry point and emits a trace.
 *   `codex exec --help` on codex-cli 0.163.0 confirms the spellings, and that
 *   is the whole of what a binary has confirmed.
 *
 * It is here anyway because the alternative is worse for the user it is about.
 * A wizard that finds `codex` on PATH and offers nothing but "run it yourself"
 * is not being careful on their behalf — it is declining to try the thing they
 * installed, on a machine where the one agent it does offer is absent. The run
 * stays safe to attempt rather than certain to work: the sandbox is explicit,
 * no bypass switch is ever passed, a failure pauses the run without reverting
 * the user's worktree, and `--no-instrument` still writes the task out for
 * whichever agent they prefer.
 *
 * So the rule going forward is that an entry here carries its own basis in this
 * comment. Promoting Codex's to the first kind takes recorded runs, not a
 * second reading of the same documentation.
 *
 * An agent that is not on this list is still a first-class skill target, and
 * `--no-instrument` still writes the instrumentation task out for it.
 */
const LAUNCHABLE_AGENT_IDS: readonly AgentId[] = ["claude", "codex"];

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
 * reported here becomes a run option, which is a different thing from an agent
 * the CLI merely installs a skill for. What earns a place on that list is
 * recorded with the list itself, entry by entry, because the two entries are
 * not there on the same evidence and a single sentence here would have to
 * misdescribe one of them.
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

/**
 * Every agent the CLI knows that is already set up on this machine, in the
 * registry's stable order.
 *
 * Deliberately not {@link LAUNCHABLE_AGENTS}. That list answers "which agent may
 * setup drive headless", and a route that writes a markdown task out for the
 * user drives nothing: there is no controlled environment to earn, because the
 * user starts the agent themselves. Narrowing this to the launchable list is
 * how a machine with both Codex and Claude Code came to be told to run the task
 * in Claude Code, with Codex never mentioned.
 *
 * Presence, not runnability. A hand-over is opened in whatever the user already
 * runs — an IDE, a wrapper, an agent with no CLI binary at all — so a binary on
 * PATH is the wrong question here, and each adapter's own `detect` is the right
 * one: Codex reports `$CODEX_HOME` in the home directory while Claude Code
 * reports a project-local `.claude`, and collapsing the two would install the
 * skill where that agent will never look for it.
 */
export function detectConfiguredAgents(cwd: string): AgentAdapter[] {
  return ALL_AGENTS.filter((adapter) => adapter.detect(cwd).present);
}
