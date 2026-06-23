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

function agentSkillChecks(input: DoctorInput): DoctorCheck[] {
  const { cwd } = input;
  const checks: DoctorCheck[] = [];
  const detection = claudeAdapter.detect(cwd);

  checks.push({
    name: "claude_skills_dir",
    category: "agent_skills",
    status: existsSync(detection.skillsDir) ? "pass" : "warn",
    message: existsSync(detection.skillsDir)
      ? "Claude Code skills directory found"
      : "Claude Code skills directory not found (.claude/skills).",
  });

  for (const skill of BUILTIN_SKILLS) {
    const installed = existsSync(join(detection.skillsDir, skill.name, "SKILL.md"));
    checks.push({
      name: `skill_${skill.name.replace(/-/g, "_")}`,
      category: "agent_skills",
      status: installed ? "pass" : "warn",
      message: installed ? `${skill.name} installed` : `${skill.name} not installed`,
    });
  }

  return checks;
}

function repoChecks(input: DoctorInput): DoctorCheck[] {
  const { detection } = input;
  const marker = (name: string, present: boolean, label: string): DoctorCheck => ({
    name,
    category: "repo",
    status: present ? "pass" : "warn",
    message: present ? `${label} found` : `${label} not found`,
  });

  const checks: DoctorCheck[] = [
    marker("package_json", detection.hasPackageJson, "package.json"),
    marker("pyproject_toml", detection.hasPyprojectToml, "pyproject.toml"),
    marker("requirements_txt", detection.hasRequirementsTxt, "requirements.txt"),
    marker("tsconfig_json", detection.hasTsconfigJson, "tsconfig.json"),
  ];

  const langs = detection.likelyLanguages;
  checks.push({
    name: "languages_detected",
    category: "repo",
    status: langs.length > 0 ? "pass" : "warn",
    message: langs.length > 0 ? `Languages detected: ${langs.join(", ")}` : "No language detected",
  });

  checks.push({
    name: "package_manager",
    category: "repo",
    status: detection.packageManager !== undefined ? "pass" : "warn",
    message:
      detection.packageManager !== undefined
        ? `Package manager: ${detection.packageManager}`
        : "Package manager not detected",
  });

  return checks;
}

function runtimeEnvChecks(input: DoctorInput): DoctorCheck[] {
  const { env, auth } = input;
  const hasKeyEnv =
    typeof env.TRACEROOT_API_KEY === "string" && env.TRACEROOT_API_KEY.trim() !== "";
  const hasHost =
    (typeof env.TRACEROOT_HOST_URL === "string" && env.TRACEROOT_HOST_URL.trim() !== "") ||
    auth.hostUrl.value !== undefined;

  return [
    {
      name: "env_api_key",
      category: "runtime_env",
      status: hasKeyEnv ? "pass" : "warn",
      message: hasKeyEnv ? "TRACEROOT_API_KEY is set" : "TRACEROOT_API_KEY is not set",
    },
    {
      name: "env_host",
      category: "runtime_env",
      status: hasHost ? "pass" : "warn",
      message: hasHost ? "Host is available (env or config)" : "TRACEROOT_HOST_URL is not set",
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
