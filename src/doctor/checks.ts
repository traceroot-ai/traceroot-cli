import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ALL_AGENTS } from "../agents/index.js";
import type { AuthSource, ResolvedAuth } from "../config/resolve.js";
import type { RepoDetection } from "../repo/detect.js";
import type { SetupCheckpoint } from "../setup/types.js";
import type { DoctorCheck, DoctorReport, DoctorSummary } from "./types.js";

/** Inputs for {@link buildDoctorReport}. All IO results are passed in pre-resolved. */
export interface DoctorInput {
  cwd: string;
  auth: ResolvedAuth;
  /** Network validation result; `null` when it was skipped (no credentials). */
  credentialsValid: boolean | null;
  configPath: string;
  detection: RepoDetection;
  env: NodeJS.ProcessEnv;
  /**
   * The `setup` checkpoint, when one exists. Supplied by `setup doctor` and by
   * a plain `doctor` run in a repository that has been set up. Absent means
   * "setup has not run here", which is a neutral fact, not a failure.
   */
  checkpoint?: SetupCheckpoint | null;
  /** Include the setup section even when no checkpoint exists (`setup doctor`). */
  includeSetup?: boolean;
}

/**
 * Reduces a host URL to its origin (`scheme://host[:port]`) for display, dropping
 * any embedded userinfo (`user:pass@`), path, query, or fragment so credentials
 * or tokens in the configured host can never leak into doctor output. Falls back
 * to a generic phrase if the value can't be parsed as a URL.
 */
function safeHostOrigin(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(set)";
  }
}

/** Friendly description of where a credential resolved from (no secret values). */
function describeSource(source: AuthSource, configPath: string): string {
  switch (source) {
    case "config":
      return configPath;
    case "credentials-file":
      return "credentials file";
    case "auto-env-file":
      return ".env (auto-loaded)";
    case "env-file":
      return "--env-file";
    case "env":
      return "environment";
    case "flag":
      return "--api-key / --host flags";
    case "default":
      return "built-in default";
    default:
      return "(none)";
  }
}

function credentialChecks(input: DoctorInput): DoctorCheck[] {
  const { auth, configPath, credentialsValid } = input;
  const checks: DoctorCheck[] = [];

  // A credential and host are required for CLI readiness, so their absence is a
  // hard failure (red ✗ + non-zero exit), not a neutral warning.
  const credential = auth.credential;
  const hasCredential = credential.kind !== "none" && credential.value !== undefined;
  const kindLabel = credential.kind === "session" ? "Session credential" : "API key";
  checks.push({
    name: "credentials_resolved",
    category: "credentials",
    status: hasCredential ? "pass" : "fail",
    message: hasCredential
      ? `${kindLabel} resolved from ${describeSource(credential.source, configPath)}`
      : "No credentials found. Run `traceroot login`.",
  });

  const host = auth.hostUrl.value;
  checks.push({
    name: "host_resolved",
    category: "credentials",
    status: host !== undefined ? "pass" : "fail",
    message:
      host !== undefined
        ? `Host resolved: ${safeHostOrigin(host)}`
        : "Host not found. Run `traceroot login`.",
  });

  // Only assert validity when we actually attempted a check.
  if (credentialsValid !== null) {
    checks.push({
      name: "api_credentials_valid",
      category: "credentials",
      status: credentialsValid ? "pass" : "fail",
      message: credentialsValid
        ? "API credentials valid"
        : "API credentials invalid or host unreachable.",
    });
  }

  return checks;
}

function localFileChecks(input: DoctorInput): DoctorCheck[] {
  const { configPath } = input;
  const checks: DoctorCheck[] = [];
  const configExists = existsSync(configPath);

  checks.push({
    name: "config_file_present",
    category: "traceroot_files",
    status: configExists ? "pass" : "warn",
    message: configExists ? `Config file present at ${configPath}` : "No config file found",
  });

  if (configExists) {
    const dir = dirname(configPath);
    if (basename(dir) === ".traceroot") {
      const gitignored = existsSync(join(dir, ".gitignore"));
      checks.push({
        name: "config_gitignored",
        category: "traceroot_files",
        status: gitignored ? "pass" : "warn",
        message: gitignored
          ? "Config directory is gitignored"
          : "Config directory has no .gitignore; the API key could be committed.",
      });
    }

    // Best-effort permission check; meaningless on win32, so skip it there.
    if (process.platform !== "win32") {
      try {
        const mode = statSync(configPath).mode & 0o777;
        const safe = (mode & 0o077) === 0;
        checks.push({
          name: "config_permissions",
          category: "traceroot_files",
          status: safe ? "pass" : "warn",
          message: safe
            ? "Config file permissions are restrictive (0600)"
            : `Config file is group/world-readable (mode ${mode.toString(8)}); run \`chmod 600 ${configPath}\`.`,
        });
      } catch {
        // ignore stat failures
      }
    }
  }

  return checks;
}

/**
 * Display names of the supported agents that have `skillName` installed, in the
 * stable `claude, codex, generic` order. Mirrors `skills list` so doctor reflects
 * multi-agent installs (not just Claude Code).
 */
function installedFor(cwd: string, skillName: string): string[] {
  return ALL_AGENTS.filter((agent) =>
    existsSync(join(agent.getSkillInstallPath(cwd, skillName), "SKILL.md")),
  ).map((agent) => agent.displayName);
}

/**
 * Readiness-oriented skill checks (not a full inventory — that's
 * `traceroot skills list`). The instrumentation skill is the one that matters for
 * getting started, so its absence is an actionable warning; the quickstart skill
 * is explicitly optional. A skill counts as present if installed for any agent.
 */
function agentSkillChecks(input: DoctorInput): DoctorCheck[] {
  const instrumentAgents = installedFor(input.cwd, "traceroot-instrument-repo");
  const quickstartAgents = installedFor(input.cwd, "traceroot-quickstart");

  return [
    {
      name: "skill_instrument",
      category: "agent_skills",
      status: instrumentAgents.length > 0 ? "pass" : "warn",
      message:
        instrumentAgents.length > 0
          ? `Instrumentation skill installed for ${instrumentAgents.join(", ")}`
          : "Instrumentation skill not installed. Run `traceroot skills install traceroot-instrument-repo`",
    },
    {
      name: "skill_quickstart",
      category: "agent_skills",
      status: quickstartAgents.length > 0 ? "pass" : "warn",
      message:
        quickstartAgents.length > 0
          ? `Quickstart skill installed for ${quickstartAgents.join(", ")}`
          : "Quickstart skill not installed",
    },
  ];
}

/**
 * Summarizes the detected project shape as positive facts. Absent markers for a
 * language the repo doesn't use are NOT warnings (a TypeScript repo shouldn't be
 * dinged for having no pyproject.toml); only a repo with no recognized markers
 * at all warns. JSON consumers can re-derive raw facts from `repo/detect`.
 */
function repoChecks(input: DoctorInput): DoctorCheck[] {
  const { detection } = input;
  const checks: DoctorCheck[] = [];

  if (detection.hasPackageJson) {
    checks.push({
      name: "node_project",
      category: "repo",
      status: "pass",
      message: "Node project detected: package.json",
    });
  }
  if (detection.hasTsconfigJson) {
    checks.push({
      name: "typescript",
      category: "repo",
      status: "pass",
      message: "TypeScript detected: tsconfig.json",
    });
  }
  if (detection.hasPyprojectToml || detection.hasRequirementsTxt) {
    const marker = detection.hasPyprojectToml ? "pyproject.toml" : "requirements.txt";
    checks.push({
      name: "python_project",
      category: "repo",
      status: "pass",
      message: `Python project detected: ${marker}`,
    });
  }
  if (detection.packageManager !== undefined) {
    checks.push({
      name: "package_manager",
      category: "repo",
      status: "pass",
      message: `Package manager: ${detection.packageManager}`,
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: "project_markers",
      category: "repo",
      status: "warn",
      message:
        "No supported project markers found (package.json, pyproject.toml, requirements.txt).",
    });
  }

  return checks;
}

/**
 * Reports whether the runtime env vars an instrumented app reads are exported in
 * THIS shell — distinct from CLI auth/config readiness (covered under
 * Credentials). A var absent from the shell is a neutral warning, never a green
 * pass. Messages are kept terse (no semicolon explanations).
 */
function runtimeEnvChecks(input: DoctorInput): DoctorCheck[] {
  const { env } = input;
  const hasKeyEnv =
    typeof env.TRACEROOT_API_KEY === "string" && env.TRACEROOT_API_KEY.trim() !== "";
  const hasHostEnv =
    typeof env.TRACEROOT_HOST_URL === "string" && env.TRACEROOT_HOST_URL.trim() !== "";

  return [
    {
      name: "env_api_key",
      category: "runtime_env",
      status: hasKeyEnv ? "pass" : "warn",
      message: hasKeyEnv
        ? "TRACEROOT_API_KEY is set in this shell"
        : "TRACEROOT_API_KEY is not set in this shell",
    },
    {
      name: "env_host",
      category: "runtime_env",
      status: hasHostEnv ? "pass" : "warn",
      message: hasHostEnv
        ? "TRACEROOT_HOST_URL is set in this shell"
        : "TRACEROOT_HOST_URL is not set in this shell",
    },
  ];
}

/**
 * Reports on a `setup` run: how far it got, and what is blocking completion.
 *
 * Driven entirely by the checkpoint, which is why the checkpoint exists — a
 * setup that stopped at VERIFY_TRACE looks identical, from the outside, to one
 * that never ran, and the difference is exactly what the user needs to be told.
 *
 * Only a *failed* setup is a hard failure here. A repository where setup has
 * never run is a neutral warning: `doctor` is also useful to people who
 * instrumented by hand.
 */
function setupChecks(input: DoctorInput): DoctorCheck[] {
  const checkpoint = input.checkpoint;

  if (checkpoint === undefined || checkpoint === null) {
    return input.includeSetup === true
      ? [
          {
            name: "setup_run",
            category: "setup",
            status: "warn",
            message: "`traceroot setup` has not been run in this directory.",
          },
        ]
      : [];
  }

  const checks: DoctorCheck[] = [];
  const completed = new Set(checkpoint.completedStages);
  const finished = completed.has("complete") && checkpoint.trace !== undefined;

  checks.push({
    name: "setup_completed",
    category: "setup",
    status: finished ? "pass" : "fail",
    message: finished
      ? `Setup completed on ${checkpoint.updatedAt}`
      : `Setup is incomplete; it stopped at '${checkpoint.lastError?.stage ?? lastStage(checkpoint)}'. Run \`traceroot setup --resume\`.`,
  });

  if (checkpoint.lastError !== undefined && !finished) {
    checks.push({
      name: "setup_last_error",
      category: "setup",
      status: "fail",
      // The message was authored secret-free by SetupError; it is safe to echo.
      message: `Last error (${checkpoint.lastError.code}): ${checkpoint.lastError.message.split("\n")[0]}`,
    });
  }

  if (checkpoint.projectName !== undefined) {
    checks.push({
      name: "setup_project",
      category: "setup",
      status: "pass",
      message: `Project: ${checkpoint.projectName}`,
    });
  }
  if (checkpoint.projectKeyHint !== undefined) {
    checks.push({
      name: "setup_project_key",
      category: "setup",
      status: "pass",
      // The hint is at most a prefix and four trailing characters.
      message: `Project API key: ${checkpoint.projectKeyHint}`,
    });
  }
  if (checkpoint.service !== undefined) {
    checks.push({
      name: "setup_service",
      category: "setup",
      status: "pass",
      message: `Instrumented service: ${checkpoint.service.path} (${checkpoint.service.language}${
        checkpoint.service.framework === null ? "" : `, ${checkpoint.service.framework}`
      })`,
    });
  }
  if (checkpoint.sdkVersion !== undefined) {
    checks.push({
      name: "setup_sdk_version",
      category: "setup",
      status: "pass",
      message: `SDK version pinned: ${checkpoint.sdkVersion}`,
    });
  }

  const application = checkpoint.application;
  if (application !== undefined) {
    checks.push({
      name: "setup_application_verified",
      category: "setup",
      status: application.passed ? "pass" : application.skippedReason !== null ? "warn" : "fail",
      message: application.passed
        ? `Application passes \`${application.command}\` with and without TraceRoot credentials`
        : (application.skippedReason ??
          `Application check \`${application.command}\` did not pass`),
    });
  }

  checks.push({
    name: "setup_first_trace",
    category: "setup",
    status: checkpoint.trace === undefined ? "fail" : "pass",
    message:
      checkpoint.trace === undefined
        ? "No first trace has been observed. Run the instrumented application, then `traceroot setup --resume`."
        : `First trace: ${checkpoint.trace.traceUrl}`,
  });

  return checks;
}

/** The furthest stage a checkpoint recorded, for the "stopped at" message. */
function lastStage(checkpoint: SetupCheckpoint): string {
  const stages = checkpoint.completedStages;
  return stages[stages.length - 1] ?? "precheck";
}

/** Tallies check statuses. */
function summarize(checks: DoctorCheck[]): DoctorSummary {
  const summary: DoctorSummary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return summary;
}

/**
 * Assembles the full diagnostic report from pre-resolved inputs. Pure: all
 * network IO (credential validation) happens before this is called, so the
 * report is deterministic and never crashes on missing credentials or skills
 * (those degrade to `warn`).
 */
export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const checks = [
    ...credentialChecks(input),
    ...localFileChecks(input),
    ...agentSkillChecks(input),
    ...repoChecks(input),
    ...runtimeEnvChecks(input),
    ...setupChecks(input),
  ];
  return { checks, summary: summarize(checks) };
}
