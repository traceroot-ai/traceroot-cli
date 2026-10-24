import { constants, accessSync, existsSync, statSync } from "node:fs";
import { delimiter, join, win32 as windowsPath } from "node:path";
import { ALL_AGENTS } from "../agents/index.js";
import type { AgentAdapter, AgentId } from "../agents/types.js";
import { SetupError } from "./errors.js";
import { setupCommand } from "./invocation.js";
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

/** The extensions of a Windows batch file, which only cmd.exe can run. */
const BATCH_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

/**
 * Why the binary an agent resolved to cannot be launched, or undefined when it
 * can.
 *
 * `npm i -g` installs an agent on Windows as a batch shim, `claude.cmd`, and a
 * batch file is something only cmd.exe can run. An agent's launch cannot go
 * through cmd.exe: its arguments carry characters cmd.exe re-interprets — every
 * `Bash(prog:*)` allow rule Claude Code is given has parentheses — and the
 * process runner refuses those rather than trust an escape to survive both
 * cmd.exe and the shim's own `%*`. So a shim that resolves first on PATH is an
 * option that can only ever fail to start, on this run and on every resume,
 * with a message telling the user to install what they already have.
 *
 * First on PATH because that is the one the launch would find: a native build
 * later on PATH does not help, which is what the remedy says.
 */
function launchRefusal(
  adapter: AgentAdapter,
  resolved: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32" || !BATCH_EXTENSIONS.has(windowsPath.extname(resolved).toLowerCase())) {
    return undefined;
  }
  return `${adapter.displayName} is on PATH as a batch shim, ${resolved}, which setup cannot launch on Windows. Put the native ${adapter.binary}.exe ahead of it on PATH for setup to run it.`;
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
 * The two entries are not on this list on the same evidence:
 *
 * - `claude` — this pipeline has reached a trace with each package manager the
 *   language has.
 * - `codex` — it has reached one with pip and npm only. The settings it needs
 *   are in `buildInvocation` (./launch.ts), each with its reason.
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
 * So an entry here carries its own basis in this comment. Promoting Codex's to
 * the first kind takes runs on the package managers still missing, not a
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
 * (its binary resolves on PATH, to something setup can launch — see
 * {@link launchRefusal}). Only a runnable agent can be launched, so
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
    let unlaunchable: string | undefined;
    if (adapter.binary !== undefined) {
      const resolved = resolveOnPath(adapter.binary, env, platform);
      unlaunchable = resolved === null ? undefined : launchRefusal(adapter, resolved, platform);
      runnable = resolved !== null && unlaunchable === undefined;
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
      ...(unlaunchable === undefined ? {} : { unlaunchable }),
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
        `  ${setupCommand()} --no-instrument`,
      ].join("\n"),
    });
  }
  return adapter;
}

/** The refusal for an agent that is installed but cannot be launched. */
function unlaunchableError(message: string): SetupError {
  return new SetupError({
    stage: "select_agent",
    code: "UNSUPPORTED",
    message,
    remedy: [
      "Or generate the instrumentation prompt and run it yourself:",
      `  ${setupCommand()} --no-instrument`,
    ].join("\n"),
  });
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
 * One whose binary is on PATH and cannot be launched is refused instead, with
 * the reason: the launch would find that same binary.
 */
export async function selectAgent(input: SelectAgentInput): Promise<DetectedAgent> {
  const { detected, requested, canPrompt } = input;

  if (requested !== undefined) {
    // Validates against the agents setup can run, so an id it cannot drive
    // fails here with the names it can rather than inside that agent later.
    const adapter: AgentAdapter = requireLaunchableAgent(requested);
    const match = detected.find((d) => d.id === adapter.id);
    if (match?.unlaunchable !== undefined) {
      // Not the wrapper or alias the warning below allows for: the launch
      // would find this same binary and refuse it.
      throw unlaunchableError(match.unlaunchable);
    }
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
    // "Not found on PATH" would be false for these, and "install it" is
    // advice the user has already taken.
    const refusals = detected.flatMap((d) =>
      d.unlaunchable === undefined ? [] : [d.unlaunchable],
    );
    if (refusals.length > 0) {
      throw unlaunchableError(refusals.join("\n"));
    }
    throw new SetupError({
      stage: "select_agent",
      code: "UNSUPPORTED",
      message: "No coding agent was found on PATH, so setup cannot run one for you.",
      remedy: [
        // Named from the list rather than spelled out, so the two cannot drift.
        `Install ${LAUNCHABLE_AGENTS.map((a) => a.displayName).join(" or ")}, then rerun \`${setupCommand()}\`.`,
        "Or generate the instrumentation prompt and run it yourself:",
        `  ${setupCommand()} --no-instrument`,
      ].join("\n"),
    });
  }

  if (!canPrompt) {
    throw new SetupError({
      stage: "select_agent",
      code: "AMBIGUOUS",
      message: `Several coding agents are available: ${runnable.map((a) => a.id).join(", ")}.`,
      remedy: `Pick one with --agent, for example:\n  ${setupCommand()} --agent ${only.id}`,
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
 *
 * `generic` is excluded. It is the fallback for "no particular agent", so there
 * is nowhere to send a user who picks it — and its `detect` answers for
 * `.agents/`, the directory this very route creates when it falls back to it.
 * Left in, every repository that has taken a generic hand-over once is asked
 * from then on to choose between a real agent and a category, and the run that
 * answers "Agent (generic)" then says no coding agent is set up here.
 */
export function detectConfiguredAgents(cwd: string): AgentAdapter[] {
  return ALL_AGENTS.filter((adapter) => adapter.id !== "generic" && adapter.detect(cwd).present);
}
