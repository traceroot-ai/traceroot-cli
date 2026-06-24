import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeAdapter } from "../agents/claude.js";
import type { AuthSource, ResolvedAuth } from "../config/resolve.js";
import type { RepoDetection } from "../repo/detect.js";
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
    case "auto-env-file":
      return ".env (auto-loaded)";
    case "env-file":
      return "--env-file";
    case "env":
      return "environment";
    case "flag":
      return "--api-key / --host flags";
    default:
      return "(none)";
  }
}

function credentialChecks(input: DoctorInput): DoctorCheck[] {
  const { auth, configPath, credentialsValid } = input;
  const checks: DoctorCheck[] = [];

  // API key and host are required for CLI readiness, so their absence is a hard
  // failure (red ✗ + non-zero exit), not a neutral warning.
  const hasKey = auth.apiKey.value !== undefined;
  checks.push({
    name: "api_key_resolved",
    category: "credentials",
    status: hasKey ? "pass" : "fail",
    message: hasKey
      ? `API key resolved from ${describeSource(auth.apiKey.source, configPath)}`
      : "API key not found. Run `traceroot login`.",
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
 * Readiness-oriented skill checks (not a full inventory — that's
 * `traceroot skills list --agent <agent>`). The instrumentation skill is the one
 * that matters for getting started, so its absence is an actionable warning; the
 * quickstart skill is explicitly optional.
 */
function agentSkillChecks(input: DoctorInput): DoctorCheck[] {
  const skillsDir = claudeAdapter.detect(input.cwd).skillsDir;
  const installed = (name: string): boolean => existsSync(join(skillsDir, name, "SKILL.md"));

  const hasInstrument = installed("traceroot-instrument-repo");
  const hasQuickstart = installed("traceroot-quickstart");

  return [
    {
      name: "skill_instrument",
      category: "agent_skills",
      status: hasInstrument ? "pass" : "warn",
      message: hasInstrument
        ? "Instrumentation skill installed for Claude Code"
        : "Instrumentation skill not installed. Run `traceroot skills install traceroot-instrument-repo`",
    },
    {
      name: "skill_quickstart",
      category: "agent_skills",
      status: hasQuickstart ? "pass" : "warn",
      message: hasQuickstart
        ? "Quickstart skill installed for Claude Code"
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
  ];
  return { checks, summary: summarize(checks) };
}
