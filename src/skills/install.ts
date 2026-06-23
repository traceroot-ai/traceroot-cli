import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { CliError } from "../output.js";

/** Inputs for {@link installBundledSkill}. */
export interface InstallBundledSkillInput {
  /** Directory inside the package holding the skill's files (markdown). */
  sourceDir: string;
  /** Destination skill directory (e.g. `<cwd>/.claude/skills/<name>`). */
  targetDir: string;
  /** Overwrite an existing skill directory. */
  force: boolean;
  /** Compute the plan without touching the filesystem. */
  dryRun: boolean;
}

/** Outcome of a skill install (or a dry-run plan). */
export interface InstallBundledSkillResult {
  /** Files written (or that would be written), as forward-slash relative paths. */
  files: string[];
  /** Whether an existing skill directory was (or would be) replaced. */
  overwritten: boolean;
}

/**
 * Lists the regular files under `root` as paths relative to it. Rejects symlinks
 * anywhere in the tree: bundled skills are plain markdown, so a symlink would
 * mean a tampered package and could copy content from outside the bundle.
 */
function listFiles(root: string, rel = ""): string[] {
  const dir = rel === "" ? root : join(root, rel);
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const childRel = rel === "" ? entry : join(rel, entry);
    const abs = join(root, childRel);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      throw new CliError(`Refusing to install symlink in skill bundle: ${childRel}`);
    }
    if (stat.isDirectory()) {
      out.push(...listFiles(root, childRel));
    } else if (stat.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

/** Normalizes a native relative path to forward slashes for stable output. */
function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

/**
 * Copies a bundled skill directory to its target. Copies into a sibling temp
 * directory first, then swaps it into place, so an interrupted copy never leaves
 * a half-written skill where a complete one used to be. Refuses to overwrite an
 * existing skill unless `force` is set. In `dryRun` mode nothing is written; the
 * returned plan still reflects what would happen.
 */
export function installBundledSkill(input: InstallBundledSkillInput): InstallBundledSkillResult {
  const { sourceDir, targetDir, force, dryRun } = input;
  // Enumerate once (this is also where symlinks are rejected); derive both the
  // posix-relative plan and the copy list from the same traversal.
  const nativeFiles = listFiles(sourceDir);
  const files = nativeFiles.map(toPosix);
  const overwritten = existsSync(targetDir);

  if (dryRun) {
    return { files, overwritten };
  }

  if (overwritten && !force) {
    throw new CliError(
      `TraceRoot skill already exists at ${relative(process.cwd(), targetDir) || targetDir}\n\nUse --force to overwrite it.`,
    );
  }

  const tmpDir = `${targetDir}.${process.pid}.tmp`;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const rel of nativeFiles) {
      const src = join(sourceDir, rel);
      const dest = join(tmpDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    mkdirSync(dirname(targetDir), { recursive: true });
    // Replace atomically where possible: remove the old tree, then rename the
    // fully-populated temp dir into place.
    if (overwritten) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    renameSync(tmpDir, targetDir);
  } catch (err) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    if (err instanceof CliError) {
      throw err;
    }
    throw new CliError(
      `Failed to install skill to ${relative(process.cwd(), targetDir) || targetDir}`,
    );
  }

  return { files, overwritten };
}
