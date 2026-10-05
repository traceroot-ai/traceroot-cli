import { relative, resolve } from "node:path";
import type { ResolvedSdk } from "./sdk.js";
import { installCommand } from "./sdk.js";
import type { DetectedService } from "./types.js";

/** The fence tag the agent must use for its machine-readable completion block. */
export const COMPLETION_FENCE = "json traceroot-setup-result";

export interface BuildSetupTaskInput {
  service: DetectedService;
  /** Repository root, so an absolute interpreter can be named from the service. */
  root: string;
  sdk: ResolvedSdk;
  /** Display path of the installed skill, e.g. `.claude/skills/traceroot-instrument-repo`. */
  skillPath: string;
  /** Command the agent should run to verify the app, when one was detected. */
  verifyCommand: string | null;
  /**
   * Interactive agents may ask the user questions. Background agents must abort
   * instead of guessing — without this distinction a non-interactive agent
   * either hangs or invents an answer.
   */
  interactive: boolean;
  /** Evidence that TraceRoot is already present, so the agent extends rather than duplicates. */
  existingInstrumentation: string[];
  /** Virtualenv interpreter to install into and run with, when one was found. */
  pythonInterpreter?: string | null;
  /** Env files near the service, named so the agent does not go hunting. */
  envFiles?: readonly string[];
  /**
   * The dotenv file this run wrote the project credential into, relative to the
   * agent's working directory. Null when no credential file was written — a
   * tracked `.env.traceroot` is refused, and a key that already resolved from
   * the user's own config is never written to one at all. Naming a file that is
   * not there would replace a missing credential with an exception.
   */
  credentialEnvFile?: string | null;
}

function bullet(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

/**
 * Renders the instrumentation task handed to the coding agent.
 *
 * The prompt is scoped to exactly one service, chosen by the CLI before the
 * agent starts — the agent is never asked to pick, because a wrong pick produces
 * a confident, wrong success. It carries an exact SDK version rather than
 * "install the latest", so two runs of `traceroot setup` install the same thing.
 * It contains no credentials: the key reaches the agent through its process
 * environment only.
 *
 * The final section defines "done" as a real trace permalink, not as a clean
 * exit. The CLI verifies that independently — the completion block below is
 * diagnostics, never the pass/fail signal.
 */
/**
 * The canonical initialization block, spelled out rather than described.
 *
 * An agent handed a description rather than the code runs consecutive
 * introspection calls — `dir(traceroot)`, the version, the `Integration`
 * members, the module path — before writing a line. Telling it to introspect
 * *once* instead of repeatedly does not help: telling someone how to look a
 * thing up does not stop them looking it up. Leaving nothing to look up does.
 *
 * The snippet is the shape, not the answer — the agent still has to place it in
 * a real entry point, pick the right integration, and decide what to wrap. What
 * it no longer has to do is discover what the package exports.
 */
function initSnippet(
  service: DetectedService,
  envFiles: readonly string[],
  credentialEnvFile: string | null,
): string {
  if (service.language !== "python") {
    return [
      "```typescript",
      'import { initialize, observe } from "@traceroot-ai/traceroot";',
      "",
      "// Before importing the SDK you are instrumenting.",
      "initialize();",
      "```",
    ].join("\n");
  }
  // The credential file first, then the app's own. Both are loads the agent
  // would otherwise have to invent, and the order is the order they matter in:
  // the SDK reads its key at `initialize()`, the application reads its own
  // keys later.
  //
  // The credential file is the line that closes the loop. Before it, setup
  // wrote `.env.traceroot` and nothing on the machine ever read it — the key
  // reached the application through this run's child environment and vanished
  // with it, so the first time the user started their own app it sent nothing.
  const calls = [
    credentialEnvFile === null
      ? null
      : { call: `load_dotenv("${credentialEnvFile}")`, note: "the TraceRoot key setup wrote" },
    envFiles.length === 0
      ? null
      : { call: `load_dotenv("${envFiles[0]}")`, note: "the app's own credentials" },
  ].filter((entry) => entry !== null);
  // Comments aligned across the calls. Two paths of different lengths put the
  // two notes at different columns, which reads as two unrelated lines rather
  // than as one block with a note against each entry.
  const width = Math.max(0, ...calls.map(({ call }) => call.length));
  const loads = calls.map(({ call, note }) => `${call.padEnd(width)}   # ${note}`);
  const dotenv = loads.length > 0 ? ["from dotenv import load_dotenv", "", ...loads, ""] : [];
  return [
    "```python",
    ...dotenv,
    "import traceroot",
    "from traceroot import Integration, observe",
    "",
    "traceroot.initialize(integrations=[Integration.ANTHROPIC])   # name the library this app uses",
    "",
    "import anthropic   # must come after initialize()",
    "```",
    "",
    "and, for a short-lived script only, `traceroot.flush()` before exit.",
  ].join("\n");
}

/**
 * Why the credential load above is neither optional nor redundant.
 *
 * It has to be said outright, because every other thing this task says about
 * the key points the other way: `TRACEROOT_API_KEY` is already in the agent's
 * environment, and the hard rules tell it not to confirm, print or grep for it.
 * An agent reading that reasonably concludes a `load_dotenv` of a credential
 * file is dead code and drops it — and dropping it is exactly the failure. The
 * key is in the agent's environment because `traceroot setup` put it there for
 * the duration of this run; the user's own next run does not get it.
 *
 * Per language because the mechanism is not the same one. Python's loader runs
 * where it is written, so the line in the snippet is the whole answer and the
 * only cost is a dependency the task then tells the agent to declare. ES module
 * imports are hoisted, so the equivalent line in a TypeScript entry point runs
 * *after* the imports it was meant to precede — there the file has to be loaded
 * before the process starts, which is a change to how the app is launched
 * rather than a line of code.
 */
function credentialEnvFileNote(service: DetectedService, credentialEnvFile: string | null): string {
  if (credentialEnvFile === null) {
    return "";
  }
  if (service.language === "python") {
    return `
Loading \`${credentialEnvFile}\` is not redundant. \`TRACEROOT_API_KEY\` is in **your** environment
because \`traceroot setup\` put it there for this run; nothing loads that file afterwards, so
without that line the application stops sending traces the moment this run ends.
Add \`python-dotenv\` to the dependency manifest, since you are importing it.
`;
  }
  return `
\`traceroot setup\` wrote \`TRACEROOT_API_KEY\` to \`${credentialEnvFile}\`. It is in **your**
environment because setup put it there for this run; nothing loads that file afterwards, so the
application stops sending traces the moment this run ends. Load it **before the process starts** —
\`--env-file=${credentialEnvFile}\` on the start script is the smallest change — and not from
inside the entry point: ES module imports are hoisted, so a \`dotenv\` call written above them
still runs after they have been evaluated.
`;
}

/**
 * The shortest unambiguous way to name an interpreter from the service directory.
 *
 * Returns a relative path when the interpreter is inside the repository, and the
 * absolute path otherwise. A relative path that climbs out of the tree entirely
 * is harder to read than the absolute one it replaces, so it is not used.
 */
function relativeInterpreter(interpreter: string, root: string, servicePath: string): string {
  // Outside the repository: a relative path would climb out of the tree and be
  // harder to read than the absolute one it replaces.
  if (relative(root, interpreter).startsWith("..")) {
    return interpreter;
  }
  const serviceDir = servicePath === "." ? root : resolve(root, servicePath);
  const rel = relative(serviceDir, interpreter);
  // `./` unless it already climbs: a leading-dot directory like `.venv` is a
  // relative path that still needs the prefix to read as one in a shell.
  return rel.startsWith("..") ? rel : `./${rel}`;
}

export function buildSetupTask(input: BuildSetupTaskInput): string {
  const { service, sdk, skillPath, verifyCommand, interactive } = input;
  const python = input.pythonInterpreter ?? null;
  const envFiles = input.envFiles ?? [];
  const credentialEnvFile = input.credentialEnvFile ?? null;

  const runMode = interactive
    ? "You are running interactively. If something is genuinely ambiguous, ask the user."
    : [
        "You are running non-interactively and cannot ask questions.",
        "If a step needs a decision you cannot make safely, stop and explain exactly what is needed.",
        "Do not guess.",
      ].join(" ");

  // A bare command, never a shell that loads an env file first.
  //
  // The obvious `set -a && . ../.env && set +a && python main.py` is refused
  // by the agent's own sandbox before it reaches a shell: `set -a` mutates
  // shell options, `. file` evaluates arbitrary code, `$(...)` is command
  // substitution, and a multi-part pipeline needs separate approval. Every
  // spelling of it is blocked, in a different way each time. Suggesting any of
  // them is suggesting a wall.
  // Relative to the service, not absolute.
  //
  // The agent's working directory is the service, and an absolute interpreter
  // path routinely contains spaces and parentheses — a repository under
  // `~/Documents/My Project (2026)/` produces a command the agent has to quote
  // correctly on the first try. Watching it fail: an absolute quoted form, then
  // a backslash-escaped form, then a `pwd` to orient itself, then the relative
  // form that worked. Four attempts to run one program.
  //
  // `relative()` gives `../.venv/bin/python` from `<root>/svc`, which has no
  // quoting hazard at all. Absolute is kept only when the interpreter lives
  // outside the tree, where a relative path would be worse.
  const entry = service.entryPoint ?? "<entry point>";
  // Per language: a Node service was being told to run its entry point with a
  // Python interpreter.
  const runLine =
    service.language === "python"
      ? `${python === null ? "python3" : relativeInterpreter(python, input.root, service.path)} ${entry}`
      : entry.endsWith(".ts")
        ? `npx tsx ${entry}`
        : `node ${entry}`;

  const serviceFacts = bullet([
    `path: \`${service.path}\``,
    `language: ${service.language}`,
    `framework: ${service.framework ?? "none detected"}`,
    `entry point: ${service.entryPoint ?? "not detected — find it before editing"}`,
    `package manager: ${service.packageManager ?? "unknown"}`,
    `detected from: ${service.evidence.join("; ")}`,
    // How to run it, worked out before the agent starts. Left to itself, an
    // agent gets from "the code is instrumented" to "the code has run once" via
    // `pwd`, `cd`, `export`, a hand-written dotenv parser and several failed
    // invocations, because the application's own credentials live in a file
    // nothing has mentioned to it.
    //
    // The whole command, not a template. A `<entry point>` placeholder is a
    // hole in the one fact that exists to save the agent from looking things
    // up, and it fills that hole by reading the directory and running the
    // application once to see if it guessed right.
    `run it with: \`${runLine}\` — the whole command, worked out before you started. If it fails, read the error and adapt; do not go looking for the entry point, the interpreter or the env file first.`,
  ]);

  const existing =
    input.existingInstrumentation.length > 0
      ? [
          "",
          "## TraceRoot is already partly present",
          "",
          "The following signals were found before you started:",
          "",
          bullet(input.existingInstrumentation),
          "",
          "Extend what exists. Do not add a second initialization, a second exporter, or duplicate spans.",
        ].join("\n")
      : "";

  // One run each, and the credentials-absent pass is deliberately absent.
  //
  // Asking the agent to prove the app survives without the key makes it run the
  // application many times over, stripping the key several different ways
  // (`env -u`, an empty assignment, `os.environ.pop`, a dotenv wrapper) because
  // there is no one obvious way to unset it. Each run is a full pass through
  // the user's application. The CLI already does this
  // pass itself, in `verify_application`, with the key removed from the child
  // environment; doing it in both places pays for it twice and only the CLI's
  // answer is recorded.
  const verifySteps =
    verifyCommand !== null
      ? [
          `1. Run \`${verifyCommand}\` once and confirm it passes.`,
          "2. Exercise the instrumented path once with TraceRoot enabled so at least one trace is actually emitted. Running the tests is often not enough: run the app, or a script that calls into the traced code.",
        ].join("\n")
      : [
          "1. No test command was detected. Find the project's own check (its test script, a health command, or a smoke script) and run it once.",
          "2. Exercise the instrumented path once with TraceRoot enabled so at least one trace is actually emitted.",
        ].join("\n");

  return `# Instrument this service with TraceRoot

${runMode}

## Scope — read this first

${
  service.agentMustIdentify
    ? `You are instrumenting **exactly one** service, in **${service.language}**. No dependency
manifest identified it, so finding it is your first job.

${serviceFacts}

Determine the target from concrete signals — a dependency manifest, an entry point, an application
that actually runs. **Do not infer from loose hints**: a stray script, a file extension or a mention
in a README is not evidence. If exactly one candidate is unambiguous, proceed with it. In every
other case — several candidates, none, or any doubt about which application the user meant — **stop
and ask**. List the candidate paths you found and have the user pick exactly one, then state the
single strongest piece of evidence before going further.

Do not instrument more than one service or language in this run.`
    : `You are instrumenting **exactly one** service. It has already been chosen:

${serviceFacts}

Do not instrument any other service, directory or language in this run, even if the repository
contains more than one. If what you find on disk contradicts the facts above, stop and say so
rather than switching targets.`
}
${existing}

## Hard rules

${bullet([
  "Tracing is additive. Do not change business logic, and do not refactor unrelated code.",
  "Touch the fewest files that can work: dependency manifest, the application entry point, and the minimum wiring.",
  `Install exactly \`${sdk.package}\` version \`${sdk.version}\` — pin it. Do not install "latest" and do not upgrade unrelated dependencies.`,
  "Prefer the SDK's supported auto-instrumentation for this framework over hand-written spans. Add manual spans only at boundaries auto-instrumentation misses.",
  "`TRACEROOT_API_KEY` is already set in your environment — checked before you started. Do not " +
    "confirm it, print it or grep for it. If the SDK reports at runtime that it is missing, say " +
    "so in your report.",
  "Never print, log, echo or hardcode an API key.",
  "Do not write the key into any file — not source, not config, not a `.env`. You never write it " +
    "anywhere, so you never need to check what is tracked or gitignored.",
  "The application must keep working when `TRACEROOT_API_KEY` is absent. Write it that way and " +
    "move on: **do not run the application with the key unset to check.** Not with `env -u`, not " +
    "with an empty assignment, not by popping it in a wrapper script. `traceroot setup` makes " +
    "that exact pass itself afterwards and records the result; yours is thrown away, and each " +
    "attempt is another full run of somebody's application.",
  "Do not add flush/shutdown handling to a long-running server. Add a single flush before exit only for a short-lived script, CLI or serverless handler that would otherwise drop its trace.",
  "Do not read other services in this repository to copy their instrumentation. They may be " +
    "instrumented against a different SDK version, or wrongly. The skill and the installed " +
    "package are the reference.",
  "Do not delegate any of this to a subagent. A subagent gets the same file access you have, so " +
    "it cannot read anything you cannot — it only takes minutes to find that out.",
  "The API you need is written out in step 3. Do not introspect the package to confirm it, and " +
    "do not go looking for the SDK's source tree — it is normally outside the directories you can " +
    "read. If an import fails when you run the app, read the error and fix it then; that is the " +
    "moment a wrong assumption actually costs something.",
  "Your permissions are already set for this task: edits are accepted and the commands named " +
    "here are allowed. Do not read `.claude/settings.json`, `.claude/settings.local.json` or " +
    "`.claude/hooks/` to work out what you may run, and do not probe with throwaway commands. " +
    "If a command is genuinely refused, name it in your report and carry on with what you can do.",
  "Do not create additional files for this setup run. The TraceRoot skill directory and the " +
    "task file were installed by `traceroot setup` on purpose — leave them alone. Do not add " +
    "your own scratch files, notes or task directories.",
])}

## Steps

### 1. Read the TraceRoot skill

\`${skillPath}/SKILL.md\` is installed and is the source of truth for SDK APIs, initialization
order and framework integrations. Read it before writing code. If it is missing, install it with
\`traceroot skills install traceroot-instrument-repo\`.

Read it for **step 4 onward** — install, initialize, spans, verify. Its steps 1-3 (check the API
key, analyse the repository, confirm which service) were done by \`traceroot setup\` before you
started and their answers are the facts above. Do not redo them and do not put them on a
checklist.

### 2. Install the SDK

Run it **once**. Its own output is the confirmation — do not follow it with \`pip show\`, an import
check, or a listing of \`site-packages\`. If it failed you will see that in the output; if it
succeeded, so is everything downstream.

Run:

\`\`\`bash
${installCommand(sdk, service, service.language, python)}
\`\`\`
${
  service.language === "python" && python !== null
    ? `
This is the interpreter this service runs on, found before you started. Use it for the install
above **and** for every command that runs the application — \`"${python}" main.py\`, not \`python3
main.py\`. A package installed into one interpreter is invisible to another.`
    : service.language === "python"
      ? `
No virtualenv was found for this service. If that command fails with
\`externally-managed-environment\`, the system Python is marked read-only by the OS (PEP 668) and
the fix is a virtualenv, not a flag to force past it:

\`\`\`bash
python3 -m venv .venv && ./.venv/bin/python -m pip install ${sdk.package}==${sdk.version}
\`\`\`

Then run the application with \`./.venv/bin/python\` throughout.`
      : ""
}

### 3. Initialize as early as possible

Initialize TraceRoot before the LLM/agent libraries are imported, in the entry point of the
service at \`${service.path}\`. Auto-instrumentation that runs after those imports will silently
capture nothing.

${initSnippet(service, envFiles, credentialEnvFile)}
${credentialEnvFileNote(service, credentialEnvFile)}
That is the whole API you need: \`initialize\`, \`observe\`, \`using_attributes\`, \`flush\`.

\`Integration\` members, verified against \`${sdk.package}==${sdk.version}\`:

\`\`\`
OPENAI  ANTHROPIC  LANGCHAIN  GOOGLE_GENAI  CREWAI  OPENAI_AGENTS  CLAUDE_AGENT_SDK
LLAMA_INDEX  AUTOGEN  AGNO  GROQ  DSPY  GOOGLE_ADK  MISTRAL  PYDANTIC_AI  BEDROCK
AGENT_FRAMEWORK
\`\`\`

Gemini is \`GOOGLE_GENAI\` and Bedrock is \`BEDROCK\`, which are the two people guess wrong.
Nothing above needs verifying before you write it. If an import fails when you run the app, read
the error and fix it then.

### 4. Add manual spans only where auto-instrumentation cannot reach

Auto-instrumentation is the goal, not the floor. If the SDK's integration for this framework
already captures the LLM and agent calls, **you are done after step 3** — do not decorate
individual functions to make the trace look richer.

Add a manual span only where there is a boundary auto-instrumentation genuinely misses and the
trace is incomplete without it. One or two is normal. A decorator on every function in the file
is not instrumentation, it is noise, and each one is another edit and another thing to get wrong.

### 5. Verify the application still works

${verifySteps}

Do this **after** the code is instrumented. Do not run the application first for a "before"
baseline — it is a full pass through somebody's application and setup records nothing from it. If
the app is already broken, step 6 will tell you and you can say so then.

If any of these fails, fix it before continuing. Do not report success with a failing check.

### 6. Run it once, so a trace actually exists
${
  envFiles.length > 0
    ? `
The application may need credentials of its own to run — an LLM API key, a database URL. They are
not in your environment and \`TRACEROOT_API_KEY\` is not one of them. These env files exist near
this service:

${bullet(envFiles.map((file) => `\`${file}\``))}

Load them **from inside the entry point**, not from your shell:

${
  service.language === "python"
    ? `\`\`\`python
from dotenv import load_dotenv
load_dotenv("${envFiles[0]}")   # before traceroot.initialize()
\`\`\``
    : `\`\`\`typescript
import "dotenv/config";        // or: config({ path: "${envFiles[0]}" })
\`\`\``
}

Your shell cannot do this for you — \`set -a\`, \`. file\`, \`$(...)\` and multi-part pipelines are
all refused by your own sandbox, and trying them costs minutes. Loading in-process is also the
better answer: it is what makes the application runnable by a human afterwards, which a shell
incantation in your scrollback does not. Add the dotenv package to the manifest if you import it.
Never print, echo or cat the contents of these files.
`
    : ""
}
Instrumenting the code does not emit anything; **running** it does. Execute the application, or the
narrowest thing that exercises an instrumented path — a test, a script, one function call with the
real client — so the SDK sends a trace before you finish.

Do not skip this because a check in the previous step passed. A check that never touches an
instrumented path proves the app still works and proves nothing about tracing. If nothing here
runs the code, setup has nothing to verify and the run ends without a trace.

### 7. Definition of done

Done means the code is instrumented and you have **run it once**. Stop there.

On flush the SDK prints one line to stderr naming the trace it sent:

\`\`\`
[traceroot] trace 71b5f7754ba01ef84fd292d89144cac4 → https://api.example
\`\`\`

Seeing that line is the confirmation. It is the whole check — nothing further is needed and
nothing further is wanted.

Do not query the API to confirm the trace arrived. Do not run \`traceroot traces list\` or
\`traceroot traces get\`. \`traceroot setup\` is waiting on that trace itself, against the API,
and it fails the run if none shows up — so a second check here proves nothing the CLI is not
already proving, and a trace that has not finished being ingested will send you back to re-run
an application that was working the first time.

If the run printed a trace id or a URL, pass it along below. If it did not, leave \`trace_id\`
null and finish. A null there is not a failure.

### 8. Report back

End your final message with a fenced block in exactly this form:

\`\`\`${COMPLETION_FENCE}
{
  "files_changed": ["path/one", "path/two"],
  "sdk_version": "${sdk.version}",
  "service": "${service.path}",
  "trace_id": "the trace id you observed, or null",
  "tests_passed": true,
  "tests_passed_without_credentials": true,
  "notes": "anything the user should know"
}
\`\`\`

Then, in prose: what you changed, how to run the app, and anything you could not complete.
`;
}

/** What the agent claimed, when it emitted a parseable completion block. */
export interface ParsedCompletion {
  filesChanged: string[];
  sdkVersion: string | null;
  traceId: string | null;
  notes: string | null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Extracts the agent's completion block from its output.
 *
 * Deliberately lenient and deliberately non-load-bearing. Parsing agent prose is
 * fragile, so nothing downstream depends on this succeeding: a missing or
 * malformed block yields `null` and the run continues, because the CLI
 * establishes every fact that matters (files changed, tests passing, trace
 * arrived) by observation rather than by report.
 */
export function parseCompletion(output: string): ParsedCompletion | null {
  const fence = /```(?:json)?[ \t]*traceroot-setup-result[ \t]*\r?\n([\s\S]*?)```/g;
  // Take the last block: an agent that retries prints its final answer last.
  let raw: string | null = null;
  for (const match of output.matchAll(fence)) {
    raw = match[1] ?? null;
  }
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  return {
    filesChanged: asStringArray(obj.files_changed),
    sdkVersion: asStringOrNull(obj.sdk_version),
    traceId: asStringOrNull(obj.trace_id),
    notes: asStringOrNull(obj.notes),
  };
}

/**
 * Instructions for adding the SDK by hand.
 *
 * The third route exists because "run an agent over my code" and "write me a
 * prompt" are both answers to a question some people simply want to answer
 * themselves. Making that a first-class choice rather than an undocumented flag
 * is the difference between a tool that respects the user and one that assumes.
 */
export function manualInstructions(input: {
  service: DetectedService;
  sdk: ResolvedSdk;
  skillPath: string;
}): string {
  const { service, sdk, skillPath } = input;
  const init =
    service.language === "python"
      ? ["import traceroot", "", "traceroot.initialize()"].join("\n")
      : ['import { initialize } from "@traceroot-ai/traceroot";', "", "initialize();"].join("\n");

  return [
    `Add TraceRoot to ${service.path} by hand:`,
    "",
    "  1. Install the SDK, pinned:",
    `       ${installCommand(sdk, service)}`,
    "",
    `  2. Initialize it as early as possible in ${service.entryPoint ?? "your entry point"},`,
    "     before any LLM or agent library is imported:",
    "",
    ...init.split("\n").map((line) => (line === "" ? "" : `       ${line}`)),
    "",
    "  3. Read the skill for framework-specific integrations and manual spans:",
    `       ${skillPath}/SKILL.md`,
    "",
    "  4. Run your application once so it emits a trace, then:",
    "       traceroot setup --resume",
  ].join("\n");
}
