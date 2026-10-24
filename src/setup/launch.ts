import type { AgentId } from "../agents/types.js";
import type { RunProcess, RunProcessResult } from "./exec.js";
import type { Secret } from "./secret.js";

/**
 * The assignment the task puts in front of the project's own checks —
 * `TRACEROOT_ENABLED=false pytest` — so the agent's test runs send no traces
 * into the user's project. Named here because every allow rule is written twice
 * over it; see {@link buildInvocation}.
 */
const TRACEROOT_OFF = "TRACEROOT_ENABLED=false";

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
  // `Bash(prog:*)` — one allow rule per program the agent has to execute, and a
  // second with `TRACEROOT_ENABLED=false` in front of it.
  //
  // Edit approval does not extend to execution. A shell builtin like `echo`
  // succeeds without a rule, which proves nothing: executing an interpreter at
  // an absolute path is a different decision entirely, and without a rule it is
  // refused. That refusal costs the whole point of the run — the code gets
  // instrumented correctly, every attempt to run it is denied, and the run ends
  // having emitted no trace at all.
  //
  // The prefixed rule is there because the task tells the agent to run the
  // project's checks as `TRACEROOT_ENABLED=false <command>`, and Claude Code
  // matches a rule against the start of the command — an environment
  // assignment is the start. A headless run given `Bash(python3:*)` refused
  // `TRACEROOT_ENABLED=false python3 …` as needing approval and ran it once
  // `Bash(TRACEROOT_ENABLED=false python3:*)` was added. The pair permits
  // nothing the bare rule does not, beyond that one variable set to `false`:
  // the program is still named after the assignment, and the assignment is
  // never a rule on its own, which would let anything at all follow it.
  const allowed = input.allowedPrograms ?? [];
  const allowRules =
    allowed.length > 0
      ? [
          "--allowedTools",
          ...allowed.flatMap((p) => [`Bash(${p}:*)`, `Bash(${TRACEROOT_OFF} ${p}:*)`]),
        ]
      : [];

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
    default:
      // Only the agents in `LAUNCHABLE_AGENTS` reach here with a case of their
      // own. `generic` has no launchable binary at all, and the machine routes
      // it — like any id setup does not drive — to the prompt-only path before
      // ever getting here.
      throw new Error(`agent '${agentId}' cannot be launched`);
  }
}

export interface LaunchAgentInput {
  invocation: AgentInvocation;
  task: string;
  cwd: string;
  /** Parent environment to derive the child's from. */
  parentEnv: NodeJS.ProcessEnv;
  /**
   * The application credential: always redacted out of the agent's output, and
   * put in its environment only when {@link buildAgentEnv} has nowhere else to
   * put it.
   */
  credential: Secret;
  /** See {@link buildAgentEnv}. */
  credentialFiles: readonly string[];
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
 * Builds the child's environment: the parent's, the host, and the credential
 * only when no file the application loads already holds it.
 *
 * `credentialFiles` is every file the application can read this credential out
 * of, and it is the same list — settled in the same place, for the same reason —
 * that `verifyApplication` is given: the project env file the run wrote the key
 * into, plus the project's own file when the key resolved from one that was
 * already there. Empty means there is no such file, and the environment is the
 * only channel left.
 *
 * Non-empty, the variable is not merely redundant here but harmful. *Every*
 * command the agent runs inherits the agent's environment, and the SDK
 * initializes from this variable unasked — `observe` starts it when nothing
 * else has — so an agent that runs the project's own test suite to check its
 * work exports a trace per instrumented call, into the user's project, under
 * the same key as the application's own traces. Nothing in a trace list tells
 * those apart from the application's, so the task also has the agent run its
 * checks with `TRACEROOT_ENABLED=false`; withholding the variable is the half
 * that does not depend on the agent doing as it is told. It also leaves the
 * credential reaching the application the way production will deliver it: out
 * of the file the entry point loads.
 *
 * Which is also why the caller decides rather than this function: with no such
 * file, an agent that cannot authenticate cannot prove any of its own work.
 *
 * Withholding means not adding it. A key the user's own shell exports is in
 * `parentEnv` already and stays there — the agent runs in the user's
 * environment, and taking a variable back out of it is a different decision
 * from declining to add one. `verifyApplication` does take it out, because
 * there the question put to the application is explicitly "and without the
 * key"; here it is only which channel setup itself uses.
 *
 * When the credential does go here it goes here and nowhere else — not in
 * `argv` (visible in `ps`), not in the task file (which is written to disk),
 * and not in the parent's own environment (which would leak into every later
 * child in this process). A scoped copy achieves the handoff without mutating
 * the parent's environment globally, and is trivially assertable in a test.
 *
 * `host` is unconditional. It is not a credential, nothing exports without a
 * key, and an agent that inherits the wrong instance is a long debugging
 * session for a self-hosted or staging user.
 */
export function buildAgentEnv(input: {
  parentEnv: NodeJS.ProcessEnv;
  credential: Secret;
  credentialFiles: readonly string[];
  host: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input.parentEnv,
    TRACEROOT_HOST_URL: input.host,
  };
  if (input.credentialFiles.length === 0) {
    env.TRACEROOT_API_KEY = input.credential.reveal();
  }
  return env;
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
      credentialFiles: input.credentialFiles,
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
