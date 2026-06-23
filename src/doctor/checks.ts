import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeAdapter } from "../agents/claude.js";
import type { AuthSource, ResolvedAuth } from "../config/resolve.js";
import type { RepoDetection } from "../repo/detect.js";
import { BUILTIN_SKILLS } from "../skills/registry.js";
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

  const hasKey = auth.apiKey.value !== undefined;
  checks.push({
    name: "api_key_resolved",
    category: "credentials",
    status: hasKey ? "pass" : "warn",
    message: hasKey
      ? `API key resolved from ${describeSource(auth.apiKey.source, configPath)}`
      : "No API key found. Run `traceroot login`, set TRACEROOT_API_KEY, or pass --api-key.",
  });

  const host = auth.hostUrl.value;
  checks.push({
    name: "host_resolved",
    category: "credentials",
    status: host !== undefined ? "pass" : "warn",
    message:
      host !== undefined
        ? `Host resolved: ${host}`
        : "No host found. Run `traceroot login`, set TRACEROOT_HOST_URL, or pass --host.",
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
    message: configExists
      ? `Config file present at ${configPath}`
      : `No config file at ${configPath} (optional if using env vars).`,
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
 * Concise skill-readiness signal. Detailed per-skill status (which skills, where)
 * is owned by `traceroot skills list --agent <agent>`; doctor only answers
 * "are TraceRoot skills installed for the recommended agent yet?".
 */
function agentSkillChecks(input: DoctorInput): DoctorCheck[] {
  const { cwd } = input;
  const skillsDir = claudeAdapter.detect(cwd).skillsDir;
  const anyInstalled = BUILTIN_SKILLS.some((skill) =>
    existsSync(join(skillsDir, skill.name, "SKILL.md")),
  );

  return [
    {
      name: "skills_installed",
      category: "agent_skills",
      status: anyInstalled ? "pass" : "warn",
      message: anyInstalled
        ? "TraceRoot skills installed for Claude Code (run `traceroot skills list` for details)"
        : "No TraceRoot skills installed for Claude Code. Run `traceroot skills install traceroot-instrument-repo --agent claude`.",
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

function runtimeEnvChecks(input: DoctorInput): DoctorCheck[] {
  const { env, auth } = input;
  const hasKeyEnv =
    typeof env.TRACEROOT_API_KEY === "string" && env.TRACEROOT_API_KEY.trim() !== "";
  const hasHostEnv =
    typeof env.TRACEROOT_HOST_URL === "string" && env.TRACEROOT_HOST_URL.trim() !== "";
  const cliAuthAvailable = auth.apiKey.value !== undefined;

  // Distinguish "the CLI can authenticate" (config/flags) from "the env var is
  // exported in this shell" — the instrumented app reads the latter at runtime,
  // so an absent env var is not contradictory with resolved CLI credentials.
  const keyMessage = hasKeyEnv
    ? "TRACEROOT_API_KEY is set in this shell"
    : cliAuthAvailable
      ? "TRACEROOT_API_KEY is not set in this shell. CLI auth is available from config, but instrumented apps may need this env var at runtime."
      : "TRACEROOT_API_KEY is not set in this shell; instrumented apps need it at runtime.";

  return [
    {
      name: "env_api_key",
      category: "runtime_env",
      status: hasKeyEnv ? "pass" : "warn",
      message: keyMessage,
    },
    {
      name: "env_host",
      category: "runtime_env",
      status: hasHostEnv || auth.hostUrl.value !== undefined ? "pass" : "warn",
      message: hasHostEnv
        ? "TRACEROOT_HOST_URL is set in this shell"
        : auth.hostUrl.value !== undefined
          ? "TRACEROOT_HOST_URL is not set in this shell (host resolved from config for CLI use)."
          : "TRACEROOT_HOST_URL is not set in this shell.",
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
