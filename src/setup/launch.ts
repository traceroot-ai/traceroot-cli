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
  /**
   * What this agent's captured stdout can be parsed into for the activity feed.
   *
   * `claude-stream-json` is Claude Code's `--output-format stream-json`, which
   * `createActivityParser` reads. `none` means the run shows a spinner and an
   * elapsed counter and no per-tool lines — which is the honest rendering for
   * an agent whose event schema this CLI has not verified, and strictly better
   * than feeding one parser somebody else's format and narrating whatever
   * happens to match.
   *
   * It is on the invocation rather than keyed off the agent id at the call
   * site, because it is a property of the argv built here: the format is a
   * consequence of the flags, so the two cannot drift apart.
   */
  activityFormat: "claude-stream-json" | "none";
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
 *
 * Each case is built from that agent's own documented interface rather than
 * translated out of the one above it. The paragraphs so far describe a tool
 * whose permissions are a list of named tools; the next agent's are a sandbox,
 * and the two express "edit files, ask nobody" in nothing like the same way.
 * Where an intent has no mechanism on the other side, the case says so in
 * place of reaching for the nearest-looking flag.
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
            activityFormat: "none",
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
            activityFormat: "claude-stream-json",
          };
    case "codex":
      // Every flag here is one OpenAI's published Codex documentation spells
      // out for `codex exec`. None of it was arrived at by analogy with Claude
      // Code above, because the two agents do not share a permission model:
      // Claude's is a per-tool allow/deny list, Codex's is a sandbox. A flag
      // guessed from the wrong model fails at the moment a user is watching, on
      // their repository, so what could not be established is left out and said
      // out loud rather than approximated.
      //
      // What "documented" does and does not mean here: every flag, subcommand
      // and config key below is named in OpenAI's own Codex reference, and none
      // of it has been run against an installed `codex` — there was no binary on
      // the machine this was written on to run `codex exec --help` against. So
      // the spellings are sourced, and the combination is unproven. The two `-c`
      // overrides are the weakest link: the flag takes `key=value` and the keys
      // exist, but that this CLI's dotted spelling of them parses is an
      // inference. It fails loudly if it is wrong — a usage error at startup,
      // before the agent has touched a file — which is the failure mode to
      // prefer when something has to be inferred at all.
      //
      // `exec` is the non-interactive subcommand. The prompt is the positional
      // argument, and `-` is documented as "read it from stdin" — which is the
      // channel this launch already uses for Claude, for the same reason: a
      // multi-kilobyte task in argv is visible in `ps` and subject to the
      // platform's argv limit.
      //
      // `--sandbox workspace-write` is the equivalent of Claude's
      // `--permission-mode acceptEdits`, and it is not optional: `codex exec`
      // defaults to a *read-only* sandbox, so without it the agent reads the
      // task, cannot write a line of the instrumentation, and exits having
      // reported that it could not. It is also what OpenAI's own documentation
      // recommends for a non-interactive run. `--full-auto` is deliberately not
      // used: the current documentation says it is no longer supported, and
      // `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) is exactly the
      // bypass-all-permissions switch this function's contract refuses to offer.
      //
      // The two `-c` overrides are documented config keys set through the
      // documented inline-override flag, and both are load-bearing:
      //
      //   `sandbox_workspace_write.network_access=true` — under
      //   `workspace-write` the sandbox has network access turned off by
      //   default. The first thing this task asks for is `pip install` or
      //   `npm install`, so the default turns the whole run into a long way of
      //   discovering that the SDK could not be fetched.
      //
      //   `approval_policy="never"` — a non-interactive run has nobody to
      //   approve anything, and the policy otherwise comes from the user's own
      //   `$CODEX_HOME/config.toml`. Pinned so this launch does not inherit an
      //   `on-request` policy from a file setup has never read. Quoted so the
      //   value is unambiguously a TOML string.
      //
      // `--color never` keeps ANSI escapes out of the captured stdout. The
      // completion block is recovered from that text by a fenced-block regex
      // (see `parseCompletion`), and that parse is what the "agent exited 0
      // having changed nothing" check depends on — so a user with `FORCE_COLOR`
      // exported must not be able to break it.
      //
      // `--skip-git-repo-check` because setup supports a repository that is not
      // a git repository and `codex exec` otherwise refuses to start in one.
      //
      // NOT mirrored, because the mechanism does not exist on this side:
      //
      //   `allowedPrograms` — Codex has no per-program allow list. Claude needs
      //   one because `acceptEdits` accepts edits and refuses execution; under
      //   `workspace-write` Codex runs commands inside the sandbox instead, so
      //   the thing those rules buy is already the default here.
      //
      //   `readableDirs` — Claude's `--add-dir` exists because Claude Code
      //   scopes file *reads* to the working directory and the skill installs
      //   at the repository root. Codex's sandbox governs writes, execution and
      //   network, not read scope, so the skill above the service is readable
      //   with no flag at all. (A service in a monorepo subdirectory that needs
      //   to *write* above itself — a root lockfile, say — is the open question
      //   the first recorded Codex run should answer;
      //   `sandbox_workspace_write.writable_roots` is the documented key for
      //   it, and it is not set here on a guess.)
      //
      //   The deny list — `EnterPlanMode`, `Task`, `Agent` exist to stop a
      //   plan-mode exit ending the run without doing the work, and to stop
      //   subagents spending minutes on access they cannot gain. `codex exec`
      //   has neither a plan mode to exit nor a subagent tool to spawn, so the
      //   intent holds without a flag. Web search is the one tool worth keeping
      //   off, and it is off unless `--search` is passed — so it is withheld by
      //   omission rather than denied by name.
      if (interactive) {
        // Not a limitation worth hiding behind an invented flag. Nothing in
        // this pipeline builds an interactive invocation — the instrument stage
        // passes `interactive: false` — and how Codex's TUI takes an initial
        // prompt is not something the documentation consulted for the headless
        // path established. Whoever turns interactive runs on reads that first.
        throw new Error(
          "agent 'codex' cannot be launched interactively: setup has only established its headless `codex exec` invocation",
        );
      }
      return {
        program: "codex",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "--color",
          "never",
          "-c",
          "sandbox_workspace_write.network_access=true",
          "-c",
          'approval_policy="never"',
          // The positional prompt argument, and therefore last.
          "-",
        ],
        promptVia: "stdin",
        interactive: false,
        // `codex exec --json` emits newline-delimited events, but the field
        // names differ between releases and nothing here has been run against
        // the binary to settle which. A feed built on a guessed schema either
        // shows nothing or narrates the wrong thing; the spinner and its
        // elapsed counter say the true part either way.
        activityFormat: "none",
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
 * the same key as the application's own traces. Those are the traces setup then
 * has to tell apart from the application's, and the task's claim that the suite
 * "loads no credential and starts no SDK" is only true once this variable is
 * gone. Withholding it leaves the credential reaching the application the way
 * production will deliver it: out of the file the entry point loads.
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
