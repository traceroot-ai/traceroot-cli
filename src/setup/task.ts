import { posix, relative, resolve } from "node:path";
import { setupCommand } from "./invocation.js";
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
   * Every file the application can read the TraceRoot credential out of — the
   * same list `buildAgentEnv` is given, settled once by the caller so the two
   * cannot come to disagree.
   *
   * Only its emptiness is read here, because the files themselves are already
   * named to the agent as {@link envFiles}: it decides which channel the hard
   * rules describe, and `buildAgentEnv` withholds the variable over exactly the
   * same answer.
   *
   * Required rather than optional: an optional one is satisfied by omitting
   * it, and omitting it here tells the agent its key is in an environment the
   * launch has just withheld it from — which is the one thing this field exists
   * to prevent.
   */
  credentialFiles: readonly string[];
  /**
   * Which of {@link envFiles} holds the TraceRoot key, relative to the agent's
   * working directory. Null when no credential file was written — a tracked env
   * file is refused, and a key that already resolved from the user's own
   * environment is never written to one at all.
   *
   * It is one of `envFiles`, not a file of its own: the credential goes into the
   * project's `.env` now, so the agent loads one file and gets both. Naming it
   * separately buys one sentence — that this load is what keeps tracing working
   * after the run ends — and nothing else.
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
 * It contains no credentials. Where the key is instead depends on the channel
 * the run settled: a file the application loads in the ordinary case, and the
 * agent's own process environment when there is no such file — `buildAgentEnv`
 * decides that over the same `credentialFiles`, and the hard rules below say
 * which it was.
 *
 * The final section defines "done" as the application having run once, and not
 * as a permalink: neither SDK prints one, so a step that waited for it waited
 * forever. The CLI establishes the trace itself, by polling — the completion
 * block below is diagnostics, never the pass/fail signal.
 */
/**
 * The env file as the entry point itself sees it.
 *
 * `detectEnvFiles` names the file relative to the service directory, which is
 * where the agent is standing. The instruction it ends up in is not run from
 * there, though — it is a line of the application's own source, and
 * `python api/main.py` from the repository root resolves `"./.env"` against the
 * repository root, finds nothing, and says nothing. Tracing is then silently
 * off behind a line in the entry point that looks right.
 *
 * So the path is re-expressed against the entry point's own directory, to be
 * anchored on that file's own location at runtime.
 */
function entryRelativeEnvFile(envFile: string, entryPoint: string): string {
  // Forward slashes throughout: this becomes a path inside a source string
  // literal, where a Windows separator would read as an escape.
  const slashed = (path: string): string => path.replaceAll("\\", "/");
  return posix.relative(posix.dirname(slashed(entryPoint)), slashed(envFile));
}

/**
 * What the load points at when no entry point was detected.
 *
 * The depth of the file the agent picks is the whole content of that path, and
 * detection did not establish it. Assuming the service root — which is what
 * this used to do — writes `.env` into a `src/main.py` that needed `../.env`,
 * and neither loader complains: python-dotenv treats a missing file as a no-op
 * and dotenv returns an error nobody reads. The application starts, emits
 * nothing, and the run spends its whole trace timeout before reporting that the
 * instrumented path never ran.
 *
 * A placeholder cannot be mistaken for a working path, and step 6 says in
 * prose whose job it is to replace it.
 */
const ENV_PATH_PLACEHOLDER = "<path from this file to the env file>";

function envPathFor(envFile: string, entryPoint: string | null): string {
  return entryPoint === null ? ENV_PATH_PLACEHOLDER : entryRelativeEnvFile(envFile, entryPoint);
}

/** The load a Python entry point performs, anchored on its own location. */
function loadDotenvCall(envFile: string, entryPoint: string | null): string {
  return `load_dotenv(Path(__file__).resolve().parent / "${envPathFor(envFile, entryPoint)}")`;
}

/**
 * The load a Node entry point performs, anchored on its own location.
 *
 * `import "dotenv/config"`, which this instruction used to show, is wrong in
 * two independent ways. It resolves against `process.cwd()` rather than against
 * the entry point — the same mistake the Python form above exists to avoid —
 * and it reads `.env` and only `.env`, while the credential goes wherever
 * `chooseCredentialEnvFile` put it, which is an existing `.env.local` where the
 * project has one. A Node service whose key went there, told to load
 * `dotenv/config`, starts with no TraceRoot credential and nothing printed.
 *
 * `new URL(..., import.meta.url)` is the ESM counterpart of Python's `__file__`
 * anchor, and dotenv accepts a URL for `path`. The CommonJS form is named
 * beside it rather than guessed at: which module system the entry point uses is
 * not something detection establishes.
 */
function loadDotenvCallTs(envFile: string, entryPoint: string | null): string {
  return `config({ path: new URL("${envPathFor(envFile, entryPoint)}", import.meta.url) })`;
}

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
 *
 * The shape now includes where the pair goes, because where it went was modelled
 * here too. A load and an `initialize()` at module scope run on import, and a
 * project's test suite imports its entry point; `observe` starts the SDK itself
 * when nothing else has, so every test that touches an instrumented function
 * exported a trace of its own, each indistinguishable from the application's.
 * Three extra lines put the pair inside the `__main__` guard, where it runs when
 * the application does.
 *
 * The guard keeps the load off the import path. It does not keep the tests
 * quiet on its own: `observe` starts the SDK whenever `TRACEROOT_API_KEY` is in
 * the environment, and the key gets there without the entry point's help — the
 * agent's own environment, a shell export, an older `load_dotenv()` at module
 * scope that the application already had. A real run's suite did exactly that
 * with `initialize()` correctly under the guard. So the task also has the agent
 * run the suite with `TRACEROOT_ENABLED=false`, which is what actually keeps it
 * out of the user's project.
 *
 * The snippet imports from the package step 2 installed, and only names that
 * package exports. The Node one used to be the Python SDK's shape transcribed:
 * a bare `initialize()` that instruments nothing in an ES module.
 */
function initSnippet(service: DetectedService, envFiles: readonly string[]): string {
  const [envFile] = envFiles;
  if (service.language !== "python") {
    // The env load, named rather than imported for its side effect — and both
    // it and `initialize()` inside the function the file runs, not at module
    // scope.
    //
    // `import "dotenv/config"` is what this used to show, and it reads `.env`
    // resolved against `process.cwd()` — neither this file's directory nor
    // necessarily the file the credential went into, which is wherever
    // `chooseCredentialEnvFile` put it. The explicit call names the file setup
    // actually wrote and anchors it on the entry point.
    //
    // Module scope is the other half of it, and the reason the comment that
    // used to sit above `initialize()` here is gone. Module scope runs on
    // import, so a test suite that imports this module loads the credential and
    // starts the SDK, and then every test reaching an instrumented function
    // exports a trace of its own. `observe(options, fn, ...args)` invokes rather
    // than wraps, auto-initializing at call time when `TRACEROOT_API_KEY` is
    // set, so there is no module-scope wrapper to arm either — with the load
    // inside the function, importing the module loads no credential. It can
    // still export, whenever the key reaches the test process some other way,
    // which is why the task runs the suite with `TRACEROOT_ENABLED=false`
    // rather than trusting the placement to keep it quiet. And the claim
    // that `initialize()` must precede the provider's import was never true of
    // this SDK: the instrumentors patch the provider's class methods through
    // `wrapt`, which does not care whether it was imported first. What it has to
    // precede is the first model call and the first `observe`.
    //
    // `instrumentModules`, naming the provider, because without it
    // `initialize()` falls back to hooking `require()`, and an ES module — which
    // this snippet is, anchored on `import.meta.url` — never goes through it. A
    // bare `initialize()`, which is what this used to show, instrumented nothing.
    const load =
      envFile === undefined
        ? { imports: [] as string[], call: [] as string[] }
        : {
            imports: ['import { config } from "dotenv";'],
            call: [
              `  ${loadDotenvCallTs(envFile, service.entryPoint)};   // the app's own credentials`,
            ],
          };
    return [
      "```typescript",
      ...load.imports,
      'import { TraceRoot } from "@traceroot-ai/traceroot";',
      'import OpenAI from "openai";   // the provider library, imported wherever it already was',
      "",
      "// The function this file calls when it is run directly — not module scope.",
      "async function main() {",
      ...load.call,
      "  TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });   // name the library this app uses",
      "  await run();   // whatever this file already does",
      "}",
      "",
      "main();   // however this file already starts itself",
      "```",
    ].join("\n");
  }
  const dotenvImports =
    envFile === undefined ? [] : ["from pathlib import Path", "from dotenv import load_dotenv", ""];
  // Indented, because it belongs to the guard below rather than to the module.
  const credentialLoad =
    envFile === undefined
      ? []
      : [`    ${loadDotenvCall(envFile, service.entryPoint)}   # the app's own credentials`];
  return [
    "```python",
    ...dotenvImports,
    "import traceroot",
    "from traceroot import Integration, observe",
    "",
    "import anthropic   # the provider library, imported wherever it already was",
    "",
    "",
    'if __name__ == "__main__":',
    ...credentialLoad,
    "    traceroot.initialize(integrations=[Integration.ANTHROPIC])   # name the library this app uses",
    "    main()   # whatever this file already calls to run",
    "```",
    "",
    "and, for a short-lived script only, `traceroot.flush()` before exit.",
  ].join("\n");
}

/**
 * Step 3's account of the TypeScript SDK, where the Python one lists its
 * `Integration` members.
 *
 * The Python list used to render here for every language, under a "verified
 * against" line naming the Node package — which exports neither `Integration`
 * nor `using_attributes`, and has `flush` only as `TraceRoot.flush()`. These
 * names are read from `@traceroot-ai/traceroot` 0.5.0 and 0.6.0, whose
 * `InitializeOptions` take the same `instrumentModules` keys.
 */
function typescriptApi(): string {
  return `\`instrumentModules\` is what instruments the provider. Name each library this application
calls, set to the module it imports, and leave out the ones it does not. Without it, \`initialize()\`
auto-instruments only modules loaded with \`require()\` — CommonJS — so in an ES module it
instruments nothing. The keys it takes in \`@traceroot-ai/traceroot\`:

\`\`\`
openAI  anthropic  langchain  bedrock  typeSafe  claudeAgentSDK  openaiAgents  piCodingAgent
piAgentCore
\`\`\`

LangChain's key takes \`@langchain/core/callbacks/manager\`, not the LangChain class, and the Vercel
AI SDK needs no key at all; the skill's TypeScript reference covers both. For step 4, spans come
from \`observe\`, user and session from \`usingAttributes\`, and a short-lived script awaits
\`TraceRoot.flush()\` before it exits, all from \`@traceroot-ai/traceroot\`. If an import fails when
you run the app, read the error and fix it then.`;
}

/**
 * The virtualenv this task tells a service with none of its own to create.
 *
 * Named once so the prose that recommends it and `taskInterpreters`, which says
 * what the agent is allowed to execute, cannot come to disagree.
 */
const FALLBACK_INTERPRETER = "./.venv/bin/python";

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

/**
 * Every spelling of the interpreter this task tells the agent to run.
 *
 * Whoever launches the agent has to permit each of them. A permission rule
 * matches the start of a command literally, so permitting one spelling while
 * the task recommends another refuses the command the task just gave — and a
 * refusal there costs the whole run, because the code gets instrumented and
 * nothing is allowed to execute it.
 *
 * There are two because the task names the interpreter twice: absolutely in
 * the install step and relatively in the run command (see
 * `relativeInterpreter`). The install step also single-quotes it for the shell;
 * that spelling is read off the command itself, by {@link leadingProgram}, so
 * the quoting is written in one place. `null` is a service with no virtualenv
 * at all, where the task's own advice is to create one and use it from then on.
 */
export function taskInterpreters(
  interpreter: string | null,
  root: string,
  servicePath: string,
): string[] {
  if (interpreter === null) {
    return [FALLBACK_INTERPRETER];
  }
  const named = relativeInterpreter(interpreter, root, servicePath);
  // One spelling for an interpreter outside the tree: there the task names the
  // absolute path in both places.
  return named === interpreter ? [interpreter] : [interpreter, named];
}

/**
 * The command the task tells the agent to run the service with.
 *
 * Named rather than inlined because the launch has to allow the program it
 * starts with — see {@link taskPrograms} — and a second copy of this expression
 * is a second thing to keep in step.
 */
function serviceRunLine(
  service: DetectedService,
  root: string,
  pythonInterpreter: string | null,
): string {
  const entry = service.entryPoint ?? "<entry point>";
  // Per language: a Node service was being told to run its entry point with a
  // Python interpreter.
  return service.language === "python"
    ? `${pythonInterpreter === null ? "python3" : relativeInterpreter(pythonInterpreter, root, service.path)} ${entry}`
    : entry.endsWith(".ts")
      ? `npx tsx ${entry}`
      : `node ${entry}`;
}

/**
 * The program a command starts with, as a permission rule has to name it, or
 * null when there is nothing for a rule to name.
 *
 * Taken as written, quotes included, because a rule matches the start of a
 * command literally. `installCommand`'s pip branch single-quotes an absolute
 * interpreter, closing and re-opening around any `'` in the path, so that
 * command starts with `'<path>'`, a prefix `Bash(<path>:*)` does not name. The
 * word is kept whole rather than split on whitespace, which would cut a path
 * with a space in two, and rather than un-escaped, which would be a second
 * place that has to agree with how it was quoted.
 */
function leadingProgram(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("'")) {
    // One shell word: single-quoted runs, with an escaped `'` between them.
    return /^(?:'[^']*'|\\')+/.exec(trimmed)?.[0] ?? null;
  }
  return trimmed.split(/\s+/)[0] ?? null;
}

/**
 * Every program the rendered task tells the agent to execute.
 *
 * Derived from the functions that render the task, not listed again beside
 * them. A program the task names and the launch does not allow is simply
 * refused in a headless run — `buildInvocation` says what that costs — and the
 * two lists drifted apart exactly once already: the task has told a TypeScript
 * service to run `npx tsx <entry>`, a Poetry or Bun project to install with its
 * own package manager, and a pip or Poetry project to check itself with
 * `pytest`, since before any of them were allowed.
 *
 * All three commands, because all three are commands the task hands over in
 * full and expects to be run on the first attempt: step 2 installs, step 5
 * checks, and the service facts say how to run it. The check is no wider a
 * permission than the other two — the run line already executes the project's
 * own code, and what this list scopes is which programs may be started, not
 * whether the project's code may run at all.
 *
 * Scoped to this run's own commands rather than to every command any run could
 * name, so a Python service does not hand the agent a rule for `bun`.
 */
export function taskPrograms(
  input: Pick<
    BuildSetupTaskInput,
    "service" | "root" | "sdk" | "pythonInterpreter" | "verifyCommand"
  >,
): string[] {
  const { service } = input;
  const python = input.pythonInterpreter ?? null;
  const programs = new Set(taskInterpreters(python, input.root, service.path));
  for (const command of [
    serviceRunLine(service, input.root, python),
    installCommand(input.sdk, service, service.language, python),
    // Null when no check was detected, where the task tells the agent to find
    // the project's own — which is a command nobody here can name, so there is
    // nothing to allow and `leadingProgram` is never asked.
    input.verifyCommand,
  ]) {
    const program = command === null ? null : leadingProgram(command);
    if (program !== null) {
      programs.add(program);
    }
  }
  return [...programs];
}

export function buildSetupTask(input: BuildSetupTaskInput): string {
  const { service, sdk, skillPath, verifyCommand, interactive } = input;
  const python = input.pythonInterpreter ?? null;
  const envFiles = input.envFiles ?? [];
  // Held separately so it is narrowed where the instruction is built: the
  // section exists only because there is a file to name.
  const envFile = envFiles[0] ?? null;
  const credentialEnvFile = input.credentialEnvFile ?? null;

  // Where the agent's own credential is, which is no longer always "in your
  // environment". `buildAgentEnv` withholds the variable whenever a file the
  // application loads holds the key, so that nothing the agent runs incidentally
  // — the project's own test suite above all — can export a trace of its own.
  //
  // Said flatly, as this rule used to say it, that is a claim the agent acts on:
  // it is told not to grep for the variable and, if the SDK reports no
  // credential, to report that rather than to check the load that would fix it.
  const whereTheKeyIs =
    input.credentialFiles.length === 0
      ? "`TRACEROOT_API_KEY` is already set in your environment — checked before you started. Do " +
        "not confirm it, print it or grep for it. If the SDK reports at runtime that it is " +
        "missing, say so in your report."
      : "`TRACEROOT_API_KEY` is **not** in your environment — a file the application loads holds " +
        "it instead, and the load you add in step 3 is what gets it to the SDK. Do not print it, " +
        "grep for it or copy it anywhere else. If the SDK reports at runtime that it is missing, " +
        "that load is the first thing to check.";

  // Where "not at module scope" actually is, which differs by runtime: the
  // guard is a Python idiom with no Node counterpart.
  const runPath =
    service.language === "python"
      ? 'the entry point\'s `if __name__ == "__main__":` block'
      : "the function the entry point calls to start itself when it is run directly";

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
  const runLine = serviceRunLine(service, input.root, python);

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
  // the user's application, and nothing records what it finds.
  //
  // The suite runs with `TRACEROOT_ENABLED=false`, said in the command itself
  // rather than left to a sentence elsewhere. A plain `pytest` in the agent's
  // environment, or under an entry point that loads its `.env` at module scope,
  // has a key within reach, and `observe` starts the SDK on its own in every
  // test that reaches an instrumented function. A real project's suite landed
  // in the user's project that way, seconds after the application's own trace
  // — which is the only trace this step is for, and the one setup looks for.
  const disabled = "TRACEROOT_ENABLED=false";
  const fromTheApp =
    "2. Exercise the instrumented path once with TraceRoot enabled, by running the application itself as step 6 says, so at least one trace is actually emitted. The trace `traceroot setup` looks for is the application's own; the tests are not a way to produce it.";
  const verifySteps =
    verifyCommand !== null
      ? [
          `1. Run \`${disabled} ${verifyCommand}\` once and confirm it passes. The variable switches the SDK off, so the suite sends no traces of its own into the user's project.`,
          fromTheApp,
        ].join("\n")
      : [
          `1. No test command was detected. Find the project's own check (its test script, a health command, or a smoke script) and run it once, with \`${disabled}\` in front of it so it sends no traces of its own.`,
          fromTheApp,
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
  // Two kinds of minimalism, now kept apart on purpose. Changing little of
  // somebody's repository is worth asking for; emitting one span for a whole
  // agent run is not. This rule's old ending — "the minimum wiring", read
  // beside a step headed "add manual spans only where auto-instrumentation
  // cannot reach" — granted both, and with no coverage standard stated
  // anywhere the narrowest reading wins: one span on the agent entrypoint of an
  // application that runs its own tool loop, where the published example of
  // that same shape carries seven, with no tool spans, no session attributes
  // and a trace holding nothing to open. So this rule now says what it bounds,
  // and step 4 states the coverage — which is a branch, not a number: an
  // application whose framework runs the loop is correct at one span, and the
  // published examples of that shape have exactly one.
  "Touch the fewest files that can work: the dependency manifest, the application entry point, " +
    "and the files holding the functions step 4 asks you to cover. That bounds how much of the " +
    "repository you change, not how much of the run the trace covers. A decorator on a function " +
    "that is already there changes no behaviour; a refactor, a new module or a wrapper written " +
    "to host a span does, and none of those are wanted.",
  `Install exactly \`${sdk.package}\` version \`${sdk.version}\` — pin it. Do not install "latest" and do not upgrade unrelated dependencies.`,
  "Do not hand-write a span around anything the integrations you enable already instrument. How " +
    "much that is depends on which kind they are: a model provider's integration covers the calls " +
    "to that provider and nothing about the structure around them, while an agent framework's " +
    "also covers the tool calls and the loop that makes them. Step 4 says how to tell, and what " +
    "is left for you either way.",
  whereTheKeyIs,
  "Never print, log, echo or hardcode an API key.",
  "Do not write the key into any file — not source, not config, not a `.env`. You never write it " +
    "anywhere, so you never need to check what is tracked or gitignored.",
  "The application must keep working when `TRACEROOT_API_KEY` is absent. Write it that way and " +
    "move on: **do not run the application with the key unset to check.** Not with `env -u`, not " +
    "with an empty assignment, not by popping it in a wrapper script. That pass is not part of " +
    "this task, and each attempt is another full run of somebody's application.",
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

One question inside them was not answered for you: setup does not know whether this application
has a user or a session concept, so the table in the skill's analyse step is still yours to read
and apply. Step 4 says where its answer goes.

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
python3 -m venv .venv && ${FALLBACK_INTERPRETER} -m pip install ${sdk.package}==${sdk.version}
\`\`\`

Then run the application with \`${FALLBACK_INTERPRETER}\` throughout.`
      : ""
}

### 3. Initialize on the path that runs the application

In the entry point of the service at \`${service.path}\`, put the credential load and
\`initialize()\` where they run when the application is **run**, and not at module scope. Here
that place is ${runPath}.

Module scope runs on import, and a project's test suite imports its entry point. A module that
loads the credential and initializes on import makes every test that touches an instrumented
function export a trace of its own, each one indistinguishable from the application's and
impossible to tell apart afterwards.

The order that matters is not the import order. \`initialize()\` has to run before the first model
call and before the first instrumented function runs: \`observe\` starts the SDK itself when nothing
else has, and a second \`initialize()\` after that is skipped with a warning, so the integrations
you named would never be applied. Auto-instrumentation patches the provider library's own methods,
which works whether or not that library has already been imported — so leave its imports where
they are.

${initSnippet(service, envFiles)}

${
  service.language === "python"
    ? `Two shapes cannot do this. A module another process imports in order to run it — uvicorn,
gunicorn, a queue worker — has no such place to put it, so initialize where the framework starts
up instead. And an application that needs its own credentials while it is still being imported — a
client constructed at module scope — has to keep the load there.`
    : `Two shapes cannot do this. A module another process imports in order to run it — a server
started by a process manager, a queue worker — has no such place to put it, so initialize where the
framework starts up instead. And an application that needs its own credentials while it is still
being imported — a client constructed at module scope — has to keep the load there.`
}

Whatever the shape, the run path does not on its own keep the project's tests from exporting.
\`observe\` starts the SDK by itself whenever \`TRACEROOT_API_KEY\` is in the environment, and the key
can get there without the entry point's help — your own environment, a shell export, a \`.env\`
loaded at import by code that was there before you. What keeps a test run out of the user's project
is \`TRACEROOT_ENABLED=false\` on the command that runs it, which is how step 5 runs the suite.

${
  service.language === "python"
    ? `None of this belongs in the project's test configuration — not a \`conftest.py\`, not a fixture, not
a \`pytest.ini\`. Those are the user's files, and the variable on the command line does the job
without touching them.`
    : `None of this belongs in the project's test configuration — not a test setup file, not a fixture,
not the test runner's config. Those are the user's files, and the variable on the command line does
the job without touching them.`
}

${
  service.language === "python"
    ? `That is the whole API you need: \`initialize\`, \`observe\`, \`using_attributes\`, \`flush\`.

\`Integration\` members, verified against \`${sdk.package}==${sdk.version}\`:

\`\`\`
OPENAI  ANTHROPIC  LANGCHAIN  GOOGLE_GENAI  CREWAI  OPENAI_AGENTS  CLAUDE_AGENT_SDK
LLAMA_INDEX  AUTOGEN  AGNO  GROQ  DSPY  GOOGLE_ADK  MISTRAL  PYDANTIC_AI  BEDROCK
AGENT_FRAMEWORK
\`\`\`

Gemini is \`GOOGLE_GENAI\` and Bedrock is \`BEDROCK\`, which are the two people guess wrong.
Nothing above needs verifying before you write it. If an import fails when you run the app, read
the error and fix it then.`
    : typescriptApi()
}

### 4. Cover this application's boundaries with spans

A trace is read as a tree, so there has to be a tree. This step fails in both directions: a whole
run that arrives as one span names no tool, times nothing separately and gives a failure inside it
no location — while a span wrapped around work something else already traces reports one call as
two, and afterwards cannot be told from real nesting.

So cover every boundary that nothing else covers:

- **One outermost span around a single logical run** — the request handler, the agent entrypoint,
  the \`main()\` of a script — so everything else nests inside it and the trace has a root worth
  opening. This one is never in doubt.
- **User and session attributes, always.** Attach them once, around that outermost span, and not
  inside each tool. The table in the skill's analyse step is for deciding what the values are, not
  whether to attach them: a one-span trace carries them too.
- **One span per model call.** The integrations you enabled in step 3 already emit these for the
  provider calls they cover, so ordinarily you write none here. Write one by hand only for a model
  call those integrations do not reach.
- **One span per tool this application's own code calls.** Where it runs its own tool loop — reads
  the tool calls out of the model's reply and dispatches to its own functions — nothing else can
  see those calls, so each tool function gets a span, and so does the step that dispatches between
  them.
- **No span on a tool a framework calls for you.** Where the tools are only registered — passed in
  a \`tools=[…]\` list, or declared with the framework's own decorator — and nothing in this
  repository calls them itself, that framework's integration already emits a span per tool
  execution. Decorating them there produces two spans for one call.
- **One span per external call that nothing else instruments** — an outbound HTTP request, a
  database query, a queue publish the run makes on its own.

**Which of the two tool cases you are in is decided by one question: does a line in this repository
call the tool function?** If it does, this application owns the loop and its tools are yours to
cover. If the only mention of the function is its registration, the framework owns the loop and
they are not. **If you cannot tell, leave the tools undecorated** — add the outermost span and the
attributes, and stop there. A span you left out reads as an absence in the trace, which is
recoverable; a doubled span misreports what the application did.

Spans go on boundaries, not on lines. Helpers, pure functions, parsers, formatters and loop bodies
get none however many of them there are: the reference's "What to instrument" section is the
limit, and a span nobody would go looking for is cost without signal. Give each one a name a
reader would recognise and the \`type\` the skill documents for it — a run or an agent step is
\`agent\`, a tool is \`tool\`, anything else is \`span\`.

Then read back what you added. One span and the attributes is the whole job for an application
whose framework runs the loop; it is not, for one that runs its own, where every tool your code
calls belongs in the trace.

### 5. Verify the application still works

${verifySteps}

Do this **after** the code is instrumented. Do not run the application first for a "before"
baseline — it is a full pass through somebody's application and setup records nothing from it. If
the app is already broken, step 6 will tell you and you can say so then.

If any of these fails, fix it before continuing. Do not report success with a failing check.

### 6. Run it once, so a trace actually exists
${
  envFile !== null
    ? `
The application may need credentials of its own to run — an LLM API key, a database URL. They are
not in your environment. These env files exist near this service:

${bullet(envFiles.map((file) => `\`${file}\``))}

Load them **from inside the entry point**, resolved against that file rather than against the
directory the app happens to be started from:

${
  service.language === "python"
    ? `\`\`\`python
from pathlib import Path
from dotenv import load_dotenv

if __name__ == "__main__":
    ${loadDotenvCall(envFile, service.entryPoint)}   # beside initialize(), as in step 3
\`\`\``
    : `\`\`\`typescript
import { config } from "dotenv";

async function main() {
  ${loadDotenvCallTs(envFile, service.entryPoint)};   // beside initialize(), as in step 3
}
\`\`\`

A CommonJS entry point has no \`import.meta.url\`; there the same path is \`join(__dirname, "...")\`.`
}${
  service.entryPoint === null
    ? `

That path is a placeholder: setup could not identify the entry point, so it cannot measure the
path for you. Replace it with the path from the file you add the load to, out to \`${envFile}\`.
The files listed above are named relative to the directory you are standing in; the load is
relative to the file it sits in. A load that resolves to nothing raises nothing — the application
starts and emits no trace.
`
    : ""
}

${
  credentialEnvFile === null
    ? ""
    : `\`traceroot setup\` wrote \`TRACEROOT_API_KEY\` into \`${credentialEnvFile}\`, so that load is also
what keeps tracing working once this run ends: the key is in **your** environment because setup put
it there for this run, and nothing hands it to the user's next one.

`
}Your shell cannot do this for you — \`set -a\`, \`. file\`, \`$(...)\` and multi-part pipelines are
all refused by your own sandbox, and trying them costs minutes. Loading in-process is also the
better answer: it is what makes the application runnable by a human afterwards, which a shell
incantation in your scrollback does not. Add the dotenv package to the manifest if you import it.
Never print, echo or cat the contents of these files.
`
    : ""
}
Instrumenting the code does not emit anything; **running** it does. Execute the application, or the
narrowest thing that exercises an instrumented path — an entry point that calls it, one function
call with the real client — so the SDK sends a trace before you finish. The project's test suite is
not one of those things: it runs with TraceRoot switched off, and the trace \`traceroot setup\` looks
for is the one the application sends when it runs.

Do not skip this because a check in the previous step passed. A check that never touches an
instrumented path proves the app still works and proves nothing about tracing. If nothing here
runs the code, setup has nothing to verify and the run ends without a trace.

### 7. Definition of done

Done means the code is instrumented and the application has **run once, successfully**. Stop there.

**There is no confirmation line to wait for.** The SDK does not announce the trace it sent — no
trace id, no URL, nothing on stdout or stderr — so a run that exported a trace looks exactly like
a run that exported nothing. Do not read that silence as a failure, do not add code to break it,
and do not run the application again to go looking: a second run tells you nothing the first did
not, and it is another full pass through somebody's application, with whatever that spends and
whatever it writes.

**Confirming the trace is not your job.** \`traceroot setup\` polls the API for it in the stage
after this one and fails the run if nothing arrives, so there is nothing you can add here and no
way for a missing trace to pass unnoticed. Do not query the API yourself — not with
\`traceroot traces list\`, not with \`traceroot traces get\`, not with curl.

If the application itself printed a trace id or a URL, pass it along below. Ordinarily it will not
have, so \`trace_id\` is null — that is the normal answer, not a failure and not a trace missed.

### 8. Report back

End your final message with a fenced block in exactly this form:

\`\`\`${COMPLETION_FENCE}
{
  "files_changed": ["path/one", "path/two"],
  "sdk_version": "${sdk.version}",
  "service": "${service.path}",
  "trace_id": "the trace id you observed, or null",
  "tests_passed": true,
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
 * Deliberately lenient. Parsing agent prose is fragile, so a missing or
 * malformed block yields `null` and the run continues: the CLI establishes
 * every fact that matters (files changed, tests passing, trace arrived) by
 * observation rather than by report.
 *
 * One claim is acted on, and only in the direction that cannot invent success.
 * An agent reporting `files_changed: []` fails the instrument stage, because a
 * run that edited nothing instrumented nothing — and a sandboxed agent that was
 * stopped from editing says exactly that and still exits 0. The stage requires
 * the worktree to agree before it fails, so a dropped or malformed block is
 * still nobody's failure.
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
 * What an agent's output says after the task it echoed, or all of it when the
 * task is not in it verbatim.
 *
 * `codex exec` prints the prompt it was given before its reply, and the task's
 * report template is itself a valid completion block. Parsed whole, a reply
 * without a block read as the template's placeholders.
 */
export function afterEchoedTask(output: string, task: string): string {
  const at = output.lastIndexOf(task);
  return at === -1 ? output : output.slice(at + task.length);
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
  /** The list the agent's task is given; the snippet loads its head. */
  envFiles: readonly string[];
  /** The interpreter the service runs on, when one was found. */
  pythonInterpreter: string | null;
}): string {
  const { service, sdk, skillPath, envFiles } = input;
  // The project's own command when there is one, so the line can be copied.
  const testRun = `TRACEROOT_ENABLED=false ${service.testCommand ?? "<your test command>"}`;
  // The agent's snippet, unfenced for a terminal, so the two cannot drift
  // apart. This one used to leave out the env-file load, so an application
  // changed exactly as shown started without its key and sent nothing. Only
  // the code between the fences: the sentence after them is the task's prose,
  // and indented here it would read as a line of the program.
  const snippet = initSnippet(service, envFiles).split("\n");
  const init = snippet.slice(1, snippet.lastIndexOf("```"));
  // The package that load imports. Neither SDK depends on it.
  const dotenv =
    envFiles.length === 0 ? null : service.language === "python" ? "python-dotenv" : "dotenv";
  const install = installCommand(sdk, service, service.language, input.pythonInterpreter);
  // Named beside the load, as the agent's task does: that load anchors on
  // `import.meta.url`, which a CommonJS entry point does not have, and which
  // module system the entry point uses is not something detection establishes.
  const commonJs =
    dotenv === "dotenv"
      ? [
          "",
          "     A CommonJS module has no import.meta.url. There, require() the",
          '     packages and give the same path as join(__dirname, "...").',
        ]
      : [];
  // The agent is told to pick the integration; someone copying the block is
  // not, and detection does not establish which provider the service calls.
  const python =
    service.language === "python"
      ? [
          "",
          "     Anthropic stands in for your provider: import and name the library",
          "     your application calls. A short-lived script also calls",
          "     traceroot.flush() before it exits.",
        ]
      : [];
  // The same for Node, plus what leaving `instrumentModules` out would do,
  // since that is the line someone copying this would trim.
  const node =
    service.language === "python"
      ? []
      : [
          "",
          "     OpenAI stands in for your provider: import the library your",
          "     application calls and name it in instrumentModules. Leave",
          "     instrumentModules out and initialize() instruments only modules",
          "     loaded with require() (CommonJS), so an ES module gets no model spans.",
          "     A short-lived script also awaits TraceRoot.flush() before it exits.",
        ];

  return [
    `Add TraceRoot to ${service.path} by hand:`,
    "",
    dotenv === null
      ? "  1. Install the SDK, pinned:"
      : `  1. Install the SDK, pinned, and ${dotenv} for the load in step 2:`,
    `       ${dotenv === null ? install : `${install} ${dotenv}`}`,
    "",
    `  2. Initialize it on the path that runs ${service.entryPoint ?? "your entry point"},`,
    service.language === "python"
      ? '     under its if __name__ == "__main__": guard rather than at module scope.'
      : "     inside the function it calls to start itself rather than at module scope.",
    "     Module scope runs on import, and your test suite imports your entry",
    "     point, so initializing there starts the SDK in every test:",
    "",
    ...init.map((line) => (line === "" ? "" : `       ${line}`)),
    ...commonJs,
    ...python,
    ...node,
    "",
    "  3. Run your tests with TraceRoot switched off. The SDK starts itself",
    "     whenever TRACEROOT_API_KEY is set, guard or no guard, so a plain run",
    "     sends every test's trace to your project:",
    `       ${testRun}`,
    "",
    "  4. Read the skill for framework-specific integrations and manual spans:",
    `       ${skillPath}/SKILL.md`,
    "",
    "  5. Run your application once so it emits a trace, then:",
    `       ${setupCommand()} --resume`,
  ].join("\n");
}
