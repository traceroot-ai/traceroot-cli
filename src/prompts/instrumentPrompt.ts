import type { RepoDetection } from "../repo/detect.js";

/** Renders a yes/no marker for the detected-facts block. */
function presence(value: boolean): string {
  return value ? "present" : "absent";
}

/** Human summary of detected languages for the facts block. */
function languageSummary(detection: RepoDetection): string {
  if (detection.likelyLanguages.includes("python")) {
    if (detection.likelyLanguages.includes("typescript")) {
      return "Python and TypeScript/JavaScript";
    }
    return "Python";
  }
  if (detection.likelyLanguages.length > 0) {
    return "TypeScript/JavaScript";
  }
  return "unknown";
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
4. **Initialize auto-instrumentation as early as possible** in app startup — before the LLM/agent libraries are imported.
5. **Add manual spans** around the meaningful boundaries:
   - agents
   - tools
   - LLM calls
   - retrieval
   - external API calls
   - important workflow boundaries
6. **Preserve existing behavior.** The app must run unchanged when \`TRACEROOT_API_KEY\` is absent — warn, never crash.
7. **Minimize changes.** Touch the fewest files needed; do not refactor unrelated code.
8. **Never print or hardcode API keys.** Do not write the literal key into source or echo it back.
9. **Read credentials from the environment/config** (\`TRACEROOT_API_KEY\`, optional \`TRACEROOT_HOST_URL\`) — never from inline literals.
10. **Run the existing tests or a smoke check** to confirm nothing broke.
11. **Verify with the TraceRoot CLI** after running the app/tests:
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
