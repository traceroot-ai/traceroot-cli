import type { RepoDetection } from "../repo/detect.js";

/** Renders a yes/no marker for the detected-facts block. */
function presence(value: boolean): string {
  return value ? "present" : "absent";
}

/** Human summary of detected languages for the facts block. */
function languageSummary(detection: RepoDetection): string {
  const langs = detection.likelyLanguages;
  const hasPython = langs.includes("python");
  // `tsconfig.json` implies TypeScript (and JS); otherwise `package.json` alone is JS.
  const node = langs.includes("typescript")
    ? "TypeScript/JavaScript"
    : langs.includes("javascript")
      ? "JavaScript"
      : undefined;

  if (hasPython && node !== undefined) {
    return `Python and ${node}`;
  }
  if (hasPython) {
    return "Python";
  }
  return node ?? "unknown";
}

/** Optional agent context so the prompt references the right skill location. */
export interface InstrumentPromptOptions {
  /** Agent id used in the example install command (defaults to `claude`). */
  agentId?: string;
  /** Display path of the installed skill directory (defaults to the Claude path). */
  skillPath?: string;
}

/**
 * Builds the agent-ready instrumentation prompt for the current repo. The prompt
 * instructs the agent to drive the change (the CLI never edits app code itself)
 * and embeds the detected repo facts. It contains no credentials — only
 * instructions to read them from the environment.
 */
export function buildInstrumentPrompt(
  detection: RepoDetection,
  options: InstrumentPromptOptions = {},
): string {
  const agentId = options.agentId ?? "claude";
  const skillPath = options.skillPath ?? ".claude/skills/traceroot-instrument-repo";
  const facts = [
    "Detected repository facts:",
    `- package.json: ${presence(detection.hasPackageJson)}`,
    `- pyproject.toml: ${presence(detection.hasPyprojectToml)}`,
    `- requirements.txt: ${presence(detection.hasRequirementsTxt)}`,
    `- tsconfig.json: ${presence(detection.hasTsconfigJson)}`,
    `- likely language: ${languageSummary(detection)}`,
    `- package manager: ${detection.packageManager ?? "unknown"}`,
  ].join("\n");

  return `# Instrument this repository with TraceRoot

You are working inside an existing codebase. Add TraceRoot tracing/observability.
Tracing is **additive**: never change business logic or rewrite features.

${facts}

## Instructions

1. **Use the installed TraceRoot skill if available.** If \`${skillPath}/SKILL.md\` exists, follow it — it is the source of truth for SDK details. (Install it with \`traceroot skills install traceroot-instrument-repo --agent ${agentId}\`.)
2. **Detect the stack.** Confirm the language, framework, and package manager from the manifests above and the actual imports in use.
3. **Add the TraceRoot SDK.** Python → the \`traceroot\` package; TypeScript/Node.js → \`@traceroot-ai/traceroot\` (Mastra apps → \`@traceroot-ai/mastra\`). Use the detected package manager.
4. **Initialize on the path that runs the application.** Put the credential load and \`initialize()\` where they run when the application is *run*, and not at module scope — in Python the \`if __name__ == "__main__":\` block, in Node the function the entry point calls to start itself. Module scope runs on import, and a project's test suite imports its entry point: a module that initializes on import makes every test that touches an instrumented function export a trace of its own, each one indistinguishable from the application's afterwards.
   - The order that matters is not the import order. \`initialize()\` has to run before the first model call and before the first instrumented function runs: \`observe\` starts the SDK itself when nothing else has, and a second \`initialize()\` after that is skipped with a warning, so the integrations you named would never be applied. Auto-instrumentation patches the provider library's own methods, which works whether or not that library has already been imported — so leave its imports where they are.
   - Two shapes cannot do this. A module another process imports in order to run it — uvicorn, gunicorn, a queue worker — has no such place, so initialize at the framework's own startup hook instead. And an application that needs its own credentials while it is still being imported has to keep the load at module scope.
   - Whatever the shape, the run path does not on its own keep the project's tests from exporting: \`observe\` starts the SDK by itself whenever \`TRACEROOT_API_KEY\` is in the environment, however it got there. Run the project's own checks with \`TRACEROOT_ENABLED=false\` in the environment — \`TRACEROOT_ENABLED=false pytest\`, \`TRACEROOT_ENABLED=false npm test\` — so that they do not export.
   - None of this belongs in the project's test configuration — not a \`conftest.py\`, not a fixture, not a \`pytest.ini\`. Those are the user's files, and the variable on the command line does the job without touching them.
5. **Add manual spans** around the meaningful boundaries:
   - agents
   - tools
   - LLM calls
   - retrieval
   - external API calls
   - important workflow boundaries
6. **Preserve existing behavior.** The app must run unchanged when \`TRACEROOT_API_KEY\` is absent — warn, never crash.
7. **Cover the functions this repository's own code calls.** Where this application runs its own tool loop — reads the tool calls out of the model's reply and dispatches to its own functions — each of those functions gets a span, and so does the step that dispatches between them. Where a tool is only registered, passed in a \`tools=[…]\` list or declared with the framework's own decorator, the framework owns the call and its integration already emits a span per execution, so decorating it reports one call as two. The question is answerable from the source: does a line in this repository call this function? **If you cannot tell, leave it undecorated** — a span you left out reads as an absence in the trace, which is recoverable, while a doubled span misreports what the application did. Do not refactor unrelated code.
8. **Never print or hardcode API keys.** Do not write the literal key into source or echo it back.
9. **Read credentials from the environment/config** (\`TRACEROOT_API_KEY\`, optional \`TRACEROOT_HOST_URL\`) — never from inline literals.
10. **Run the existing tests or a smoke check with \`TRACEROOT_ENABLED=false\`** in front of the command, to confirm nothing broke without sending the tests' traces to the project.
11. **Verify with the TraceRoot CLI** after running the app itself — the one run here with TraceRoot on:
    - \`traceroot status\`
    - \`traceroot traces list --limit 5\`
    - \`traceroot traces get <trace-id>\`
12. **Report back** with:
    - files changed
    - instrumentation added (which spans, where)
    - how to run the app
    - whether a trace was observed (include the trace id)
    - any missing spans or follow-up recommendations
`;
}
