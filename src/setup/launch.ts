import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentId } from "../agents/types.js";
import type { RunProcess, RunProcessResult } from "./exec.js";
import { type Secret, secretHint } from "./secret.js";

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
  /**
   * Directories outside its working directory that the agent's commands must
   * be able to write, such as a package manager's cache.
   *
   * Only Codex reads this. Its sandbox confines writes to the workspace, and a
   * recorded npm run failed on the cache until the cache was named here. Claude
   * Code's recorded npm runs wrote the cache with nothing named, so its
   * invocation ignores this and stays the one those runs used.
   */
  writableDirs?: readonly string[];
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
  // The allow list, which pre-approves rather than restricts.
  //
  // `--allowedTools` names the calls that run without asking; it does not take
  // anything away. Claude Code's own help says "list of tool names to allow"
  // and its CLI reference says, of this flag, "To restrict which tools are
  // available, use `--tools` instead" — so the agent keeps its whole toolset
  // whatever is listed here, and `--tools` is deliberately never passed.
  //
  // Two kinds of rule, because this run needs two different things approved and
  // the mode on its own covers only one of them.
  //
  // `Edit(**)` and `Read(**)` — the files. `acceptEdits` already accepts edits,
  // so this is not what makes editing possible; it is what stops editing from
  // being the one load-bearing capability in the run that nothing states. Every
  // command the agent must run is pinned by a rule below, while its ability to
  // change a line of the service rested entirely on a mode staying in force —
  // and a mode is the part of this a user's own settings can move. Said as a
  // rule it survives that, and the regression test can assert it.
  //
  // Path-scoped on purpose, and `**` anchors at the working directory: setup
  // starts the agent in the service, so these grant the service and nothing
  // above it. Bare `Edit`/`Write` would approve a write anywhere on the disk,
  // which is wider than the mode they are backing up. A path rule written for
  // `Edit` is the documented way to cover `Write` and `NotebookEdit` too —
  // there is no `Write(…)` matcher — so one rule says "the files here".
  //
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
  //
  // Unconditional, where the Bash rules are not. There is always a service to
  // edit; there is not always an interpreter to name, and hanging the file rules
  // off `allowedPrograms` being non-empty would tie the agent's ability to edit
  // to whether this particular service happened to come with one.
  const allowed = input.allowedPrograms ?? [];
  const allowRules = [
    "--allowedTools",
    "Read(**)",
    "Edit(**)",
    ...allowed.flatMap((p) => [`Bash(${p}:*)`, `Bash(${TRACEROOT_OFF} ${p}:*)`]),
  ];

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
      // out for `codex exec`, or one a recorded run of this task showed it
      // needs. None of it was arrived at by analogy with Claude Code above,
      // because the two agents do not share a permission model: Claude's is a
      // per-tool allow/deny list, Codex's is a sandbox. A flag guessed from the
      // wrong model fails at the moment a user is watching, on their
      // repository, so what could not be established is left out and said out
      // loud rather than approximated.
      //
      // `exec` is the non-interactive subcommand. The prompt is the positional
      // argument, and `-` is documented as "read it from stdin" — which is the
      // channel this launch already uses for Claude, for the same reason: a
      // multi-kilobyte task in argv is visible in `ps` and subject to the
      // platform's argv limit.
      //
      // `--sandbox workspace-write` is the equivalent of Claude's
      // `--permission-mode acceptEdits`, and it is not optional: `codex exec`
      // defaults to a *read-only* sandbox (a stock install starts there, and
      // every write fails), so without it the agent reads the task, cannot
      // write a line of the instrumentation, and exits having reported that it
      // could not. It is also what OpenAI's own documentation recommends for a
      // non-interactive run. `--full-auto` is deliberately not used: the
      // current documentation says it is no longer supported, and
      // `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) is exactly the
      // bypass-all-permissions switch this function's contract refuses to offer.
      //
      // The `-c` overrides are config keys set through the documented
      // inline-override flag, and each is load-bearing:
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
      //   `features.shell_snapshot=false` — Codex's shell snapshot, on by
      //   default, re-applies the exports in the user's shell profile to every
      //   command the agent runs, so a `TRACEROOT_API_KEY` exported in
      //   `~/.zshrc` replaces the one `buildAgentEnv` hands the agent.
      //
      // `--color never` keeps ANSI escapes out of the captured stdout. The
      // completion block is recovered from that text by a fenced-block regex
      // (see `parseCompletion`), and that parse is what the "agent exited 0
      // having changed nothing" check depends on — so a user with `FORCE_COLOR`
      // exported must not be able to break it.
      //
      // `--skip-git-repo-check` because setup supports a repository that is not
      // a git repository and `codex exec` otherwise refuses to start in one
      // ("Not inside a trusted directory", on a stock install).
      //
      // `--add-dir` once per `writableDirs` entry, because `workspace-write`
      // confines writes to the working directory and a package manager's cache
      // lives outside it. The flag rather than the
      // `sandbox_workspace_write.writable_roots` key, because a path needs no
      // TOML quoting. Which directories to pass is the instrument stage's
      // decision, not this function's, and so is making sure each one exists;
      // see `prepareWritableDir`.
      //
      // NOT mirrored, because the mechanism does not exist on this side:
      //
      //   The whole allow list — the `Bash(prog:*)` rules and the `Edit(**)` and
      //   `Read(**)` rules alike. Codex has no per-tool allow list of any kind:
      //   `codex exec --help` offers no `--allowed-tools`, and what the agent may
      //   touch is set by `-s, --sandbox`, whose values are `read-only`,
      //   `workspace-write` and `danger-full-access`. Claude needs the rules
      //   because its permissions are per tool and its mode covers only some of
      //   them; `--sandbox workspace-write` below grants reads, writes and
      //   execution across the workspace in one, so there is nothing left for a
      //   rule to add. Whether the agent stops to ask before touching any of it
      //   is a separate control, and the `approval_policy` override above is
      //   where this launch settles that one.
      //
      //   `readableDirs` — Claude's `--add-dir` exists because Claude Code
      //   scopes file *reads* to the working directory and the skill installs
      //   at the repository root. Codex's sandbox governs writes, execution and
      //   network, not read scope, so the skill above the service is readable
      //   with no flag at all. (A service in a monorepo subdirectory that needs
      //   to *write* above itself — a root lockfile, say — is still open: the
      //   recorded runs were single-directory sample apps. `--add-dir` would be
      //   the mechanism, and the repository root is not passed to it on a
      //   guess.)
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
        throw new Error("agent 'codex' cannot be launched interactively");
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
          "-c",
          "features.shell_snapshot=false",
          ...(input.writableDirs ?? []).flatMap((dir) => ["--add-dir", dir]),
          // The positional prompt argument, and therefore last.
          "-",
        ],
        promptVia: "stdin",
        interactive: false,
        // `codex exec --json` emits newline-delimited events, but the field
        // names differ between releases and the recorded runs did not pass
        // `--json`, so nothing has settled which. A feed built on a guessed
        // schema either shows nothing or narrates the wrong thing; the spinner
        // and its elapsed counter say the true part either way.
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

/** A config read; the bound is for an npm that hangs, not for a slow one. */
const NPM_CACHE_QUERY_TIMEOUT_MS = 10_000;

/**
 * Where npm will write its cache, for Codex's sandbox to open to writes.
 *
 * Asked of npm itself, because the answer is npm's to give: the user's and the
 * global `.npmrc` can move the cache, and so can the environment. It is one
 * config read that runs no scripts and writes nothing but npm's own debug log,
 * as every npm command does. `--loglevel=silent` because the runner returns
 * stdout and stderr as one string, and a warning about an `.npmrc` would
 * otherwise be read as part of the path. `--no-update-notifier` because the
 * notifier's registry check is a network request this question does not need.
 *
 * Asked from the home directory, never the project. npm also reads the
 * `.npmrc` of the project it runs in, and that file is the repository's to
 * write: one line of it chose a directory Codex could write to — `/`, or
 * `~/.ssh` — in a run with the network on and no approval prompts. The sandbox
 * is what stands between a hostile repository, or a prompt injection in one,
 * and the machine, so nothing in the repository may widen it. A project that
 * moves its own cache loses nothing: inside the project it is already
 * writable, and outside it a sandboxed install was never going to be allowed.
 *
 * Only a directory strictly inside the home directory is taken, from npm or
 * from `npm_config_cache`: never the home directory itself, an ancestor of it,
 * or anywhere else on the disk, and not a link inside it that resolves out of
 * it. Anything else falls back to `~/.npm`, and so does npm missing from PATH,
 * a shim that refuses to run, or an answer that is not one absolute path.
 * `~/.npm` is npm's default on macOS and Linux; on Windows npm uses
 * `%LocalAppData%\npm-cache`, and no Windows run has been recorded.
 */
export async function resolveNpmCacheDir(input: {
  env: NodeJS.ProcessEnv;
  runProcess: RunProcess;
  /** Defaults to the real home directory; a test passes its own. */
  homeDir?: string;
}): Promise<string> {
  const home = input.homeDir ?? homedir();
  const result = await input.runProcess({
    program: "npm",
    args: ["config", "get", "cache", "--loglevel=silent", "--no-update-notifier"],
    cwd: home,
    env: input.env,
    stdio: "capture",
    timeoutMs: NPM_CACHE_QUERY_TIMEOUT_MS,
  });
  const answer = result.output.trim();
  if (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.spawnFailed &&
    !answer.includes("\n") &&
    isInsideHome(answer, home)
  ) {
    return answer;
  }
  const fromEnv = input.env.npm_config_cache ?? input.env.NPM_CONFIG_CACHE;
  if (fromEnv !== undefined && isInsideHome(fromEnv, home)) {
    return fromEnv;
  }
  return join(home, ".npm");
}

/**
 * Whether `path` is an absolute path strictly inside `home`, both as written
 * and, when it exists, as it resolves: the sandbox is handed the resolved path,
 * so a link under the home directory that points at `/` is `/`.
 */
function isInsideHome(path: string, home: string): boolean {
  if (!isAbsolute(path) || !isStrictlyInside(resolve(home), resolve(path))) {
    return false;
  }
  const real = realpathIfExists(path);
  return real === null || isStrictlyInside(realpathIfExists(home) ?? resolve(home), real);
}

function isStrictlyInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function realpathIfExists(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Makes `dir` exist and returns the path to name to Codex's sandbox, or `null`
 * when it cannot be made.
 *
 * Created here because nothing else can create it. On a fresh machine npm's
 * cache does not exist until npm's first run, and that first run is the
 * sandboxed one. Codex 0.162.1 and 0.163.0 take a missing `--add-dir` without a
 * word (read from their source, not run). On macOS it becomes a Seatbelt rule
 * for a path that is not there yet. On Linux bubblewrap cannot
 * bind a missing path, so it is dropped from the writable roots, and the
 * sandboxed `npm install` meets a read-only home as if the flag had never been
 * passed. Creating it does what npm's own first run would have done, with the
 * same default mode. A directory that already exists is left as it is.
 *
 * The real path, not the configured one, because Codex's macOS sandbox refuses
 * a writable root with a symlink below the top level ("symlinked writable roots
 * are not supported"). The refusal comes from building the sandbox itself, so a
 * `~/.npm` linked to another disk would stop every command the agent runs, not
 * only npm's. Writes are checked against the resolved path, which is why Codex
 * rewrites top-level aliases such as `/tmp` itself, so the target is the
 * directory that has to be writable.
 */
export function prepareWritableDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  } catch {
    return null;
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
 * Builds the child's environment: the parent's without `TRACEROOT_ENABLED`, the
 * host, and the credential only when no file the application loads already
 * holds it.
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
 * key"; here it is only which channel setup itself uses. Where it would beat
 * this run's key, setup warns before the launch: see {@link shadowingApiKey}.
 *
 * An inherited `TRACEROOT_ENABLED` is the one variable taken out. Exported as
 * `false`, it switched off the application run the task asks for, and the
 * trace wait then blamed the code path. Dropped rather than forced on: the
 * agent's own checks set it on their command line, and are unaffected.
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
  const { TRACEROOT_ENABLED: _inherited, ...parentEnv } = input.parentEnv;
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    TRACEROOT_HOST_URL: input.host,
  };
  if (input.credentialFiles.length === 0) {
    env.TRACEROOT_API_KEY = input.credential.reveal();
  }
  return env;
}

/**
 * The hint of a `TRACEROOT_API_KEY` the parent exports over this run's key, or
 * null when there is nothing to warn about.
 *
 * {@link buildAgentEnv} passes an exported key through, and dotenv never
 * overrides a variable that is already set. So when the key reaches the
 * application through a file, a different exported one beats it, and the
 * application's traces go to that key's project. With no such file, setup's own
 * copy goes into the environment over it.
 */
export function shadowingApiKey(input: {
  parentEnv: NodeJS.ProcessEnv;
  credential: Secret;
  credentialFiles: readonly string[];
}): string | null {
  const exported = input.parentEnv.TRACEROOT_API_KEY;
  if (
    exported === undefined ||
    input.credentialFiles.length === 0 ||
    exported === input.credential.reveal()
  ) {
    return null;
  }
  return secretHint(exported);
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
