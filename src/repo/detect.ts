import { existsSync } from "node:fs";
import { join } from "node:path";

/** A language the CLI recognizes for instrumentation guidance. */
export type RepoLanguage = "typescript" | "javascript" | "python";

/** A package/dependency manager inferred from lockfiles or manifests. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "uv" | "pip" | "poetry";

/** Shape of the repo, derived from marker files in the working directory. */
export interface RepoDetection {
  root: string;
  hasPackageJson: boolean;
  hasPyprojectToml: boolean;
  hasRequirementsTxt: boolean;
  hasTsconfigJson: boolean;
  likelyLanguages: RepoLanguage[];
  packageManager?: PackageManager;
}

/** Lockfile → package manager, in detection priority order (Node then Python). */
const LOCKFILE_MANAGERS: ReadonlyArray<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
];

/**
 * Inspects `cwd` for common project markers and returns a structured summary.
 * Pure detection by file presence only — never reads or executes anything, so it
 * is safe to run in any directory and deterministic in tests.
 */
export function detectRepo(cwd: string = process.cwd()): RepoDetection {
  const has = (name: string): boolean => existsSync(join(cwd, name));

  const hasPackageJson = has("package.json");
  const hasTsconfigJson = has("tsconfig.json");
  const hasPyprojectToml = has("pyproject.toml");
  const hasRequirementsTxt = has("requirements.txt");

  const likelyLanguages: RepoLanguage[] = [];
  if (hasTsconfigJson) {
    likelyLanguages.push("typescript");
  }
  if (hasPackageJson) {
    likelyLanguages.push("javascript");
  }
  if (hasPyprojectToml || hasRequirementsTxt) {
    likelyLanguages.push("python");
  }

  let packageManager: PackageManager | undefined;
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (has(lockfile)) {
      packageManager = manager;
      break;
    }
  }
  // Fall back to pip when a requirements.txt is the only Python signal.
  if (packageManager === undefined && hasRequirementsTxt) {
    packageManager = "pip";
  }

  return {
    root: cwd,
    hasPackageJson,
    hasPyprojectToml,
    hasRequirementsTxt,
    hasTsconfigJson,
    likelyLanguages,
    packageManager,
  };
}
