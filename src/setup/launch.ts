import type { AgentId } from "../agents/types.js";
import type { RunProcess, RunProcessResult } from "./exec.js";
import type { Secret } from "./secret.js";

/**
 * An agent launch described as data rather than as an inline `spawn` call, so
 * the exact argv and stdin handling for each agent can be asserted in a test
 * without starting a process. The single most important property — that no
 * credential ever appears in `args` — is then a one-line assertion instead of a
 * code review.
 */
export interface AgentInvocation {
  program: string;
  args: string[];
  /**
   * How the task text reaches the agent. `stdin` pipes it; `argv` passes it as
   * a trailing positional argument (some agents only accept a prompt that way).
   * Either is safe: the task contains no secrets.
   */
  promptVia: "stdin" | "argv";
  interactive: boolean;
}

export interface BuildInvocationInput {
  agentId: AgentId;
  task: string;
  /**
   * Interactive hands the terminal to the agent so the user can supervise;
   * background runs it headless and captures its output. `--json` forces
   * background, since a TUI cannot share stdout with an event stream.
   */
  interactive: boolean;
  /**
   * Shell commands the agent may run without asking, as bare program names.
   *
   * `acceptEdits` accepts file edits and nothing else. A non-interactive run
   * has nobody to ask about a Bash call, so anything not listed here is simply
   * refused — and the agent discovers that only by trying, one command at a
   * time, at the end of a run it has otherwise completed.
   */
  allowedPrograms?: readonly string[];
  /**
   * Directories the agent may read outside its working directory.
   *
   * The skill lives at the repository root while the agent works inside one
   * service, and an agent that cannot read its own instructions guesses.
   */
  readableDirs?: readonly string[];
}

/**
 * Builds the invocation for an agent.
 *
 * Subagents are denied. A subagent inherits the parent's permission scope, so
 * it can never read something the parent could not — but it takes minutes to
 * discover that, and those minutes buy nothing. There is no instrumentation
 * task for a single service that a second agent makes faster.
 *
 * Permission posture is deliberately conservative: the agent runs with its
 * normal approval flow, edits accepted, and plan mode disabled (a plan-mode exit
 * would end the run without doing the work). Setup never offers a
 * bypass-all-permissions switch — asking a user to disable their agent's safety
 * rails during a first-run install teaches exactly the wrong habit.
 */
export function buildInvocation(input: BuildInvocationInput): AgentInvocation {
  const { agentId, interactive } = input;
  // `--add-dir` for each, and the flag is repeatable rather than variadic, so
  // unlike `--disallowedTools` it cannot swallow what follows it.
  //
  // This exists because moving the agent into the service directory takes away
  // its access to the skill. Claude Code scopes file reads to the working
  // directory, and the skill installs at the repository root — so
  // `references/python-instrument.md`, the file holding the actual Python
  // recipe, comes back "requested permissions ... but you haven't granted it
  // yet" and the agent falls back to guessing from the summary.
  const extraDirs = (input.readableDirs ?? []).flatMap((dir) => ["--add-dir", dir]);
  // `Bash(prog:*)` — one allow rule per program the agent has to execute.
  //
  // Edit approval does not extend to execution. A shell builtin like `echo`
  // succeeds without a rule, which proves nothing: executing an interpreter at
  // an absolute path is a different decision entirely, and without a rule it is
  // refused. That refusal costs the whole point of the run — the code gets
  // instrumented correctly, every attempt to run it is denied, and the run ends
  // having emitted no trace at all.
  const allowed = input.allowedPrograms ?? [];
  const allowRules =
    allowed.length > 0 ? ["--allowedTools", ...allowed.map((p) => `Bash(${p}:*)`)] : [];

  switch (agentId) {
    case "claude":
      // ORDER MATTERS. `--disallowedTools` is variadic, so anything following it
      // is swallowed as another tool name — including a positional prompt, which
      // gets split on whitespace into hundreds of bogus deny rules and leaves the
      // agent running with no task at all. Any variadic flag must therefore be
      // followed by a single-value flag before the prompt, never by the prompt.
      return interactive
        ? {
            program: "claude",
            args: [
              ...extraDirs,
              ...allowRules,
              "--disallowedTools",
              "EnterPlanMode",
              "Task",
              "Agent",
              "--permission-mode",
              "acceptEdits",
            ],
            promptVia: "argv",
            interactive: true,
          }
        : {
            program: "claude",
            args: [
              ...extraDirs,
              ...allowRules,
              "-p",
              // Streamed JSON so the wizard can show what the agent is doing
              // without handing it the terminal. `--verbose` is what makes
              // `-p` emit each turn rather than only the final result.
              "--output-format",
              "stream-json",
              "--verbose",
              "--disallowedTools",
              "EnterPlanMode",
              "Task",
              "Agent",
              "--permission-mode",
              "acceptEdits",
            ],
            promptVia: "stdin",
            interactive: false,
          };
    case "codex":
      return interactive
        ? { program: "codex", args: [], promptVia: "argv", interactive: true }
        : { program: "codex", args: ["exec", "-"], promptVia: "stdin", interactive: false };
    default:
      // `generic` has no launchable binary; the machine routes this case to the
      // prompt-only path before ever getting here.
      throw new Error(`agent '${agentId}' cannot be launched`);
  }
}

export interface LaunchAgentInput {
  invocation: AgentInvocation;
  task: string;
  cwd: string;
  /** Parent environment to derive the child's from. */
  parentEnv: NodeJS.ProcessEnv;
  /** The application credential handed to the agent. */
  credential: Secret;
  host: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  runProcess: RunProcess;
  /**
   * Called with the agent's output as it arrives, so the wizard can render what
   * it is doing. Only meaningful for a captured launch — an interactive agent
   * writes straight to the terminal and there is nothing to forward.
   */
  onData?: (chunk: string) => void;
}

/**
 * Builds the child's environment: the parent's, plus the TraceRoot credential.
 *
 * The credential is placed here and nowhere else — not in `argv` (visible in
 * `ps`), not in the task file (which is written to disk), and not in the
 * parent's own environment (which would leak into every later child in this
 * process). A scoped copy achieves the handoff without mutating the parent's
 * environment globally, and is trivially assertable in a test.
 */
export function buildAgentEnv(input: {
  parentEnv: NodeJS.ProcessEnv;
  credential: Secret;
  host: string;
}): NodeJS.ProcessEnv {
  return {
    ...input.parentEnv,
    TRACEROOT_API_KEY: input.credential.reveal(),
    TRACEROOT_HOST_URL: input.host,
  };
}

/** Runs the agent with the task and a scoped environment. */
export function launchAgent(input: LaunchAgentInput): Promise<RunProcessResult> {
  const { invocation, task } = input;
  return input.runProcess({
    program: invocation.program,
    args: invocation.promptVia === "argv" ? [...invocation.args, task] : [...invocation.args],
    cwd: input.cwd,
    env: buildAgentEnv({
      parentEnv: input.parentEnv,
      credential: input.credential,
      host: input.host,
    }),
    stdin: invocation.promptVia === "stdin" ? task : undefined,
    stdio: invocation.interactive ? "inherit" : "capture",
    onData: invocation.interactive ? undefined : input.onData,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    secrets: [input.credential],
  });
}
