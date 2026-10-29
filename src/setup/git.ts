import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunProcess } from "./exec.js";

/**
 * Git is read, never written. Setup records the state of the worktree so it can
 * report what changed and warn about pre-existing edits; it never stashes,
 * commits, checks out or reverts. The user's uncommitted work is theirs, and a
 * tool that tidies it up "helpfully" during an install is a tool nobody trusts
 * twice.
 */

/** Walks up from `start` looking for a `.git` entry; `null` outside a repo. */
export function findGitRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export interface GitState {
  inRepo: boolean;
  root: string | null;
  dirty: boolean;
  /** Repo-relative paths with uncommitted changes, at the moment of the probe. */
  changedFiles: string[];
}

/**
 * Parses `git status --porcelain -z` output into repo-relative paths.
 *
 * NUL-delimited, because the newline form C-quotes any path with a non-ASCII byte
 * or a `"` in it — reporting `"caf\303\251.ts"` for `café.ts` — and separates a
 * rename's two paths with a literal ` -> ` that a filename is allowed to contain.
 */
export function parsePorcelain(output: string): string[] {
  const files: string[] = [];
  const records = output.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? "";
    if (record === "") {
      continue;
    }
    // "XY path", one record per entry; the new path is what matters.
    files.push(record.slice(3));
    // A rename or copy is two records: the new path, then the original.
    const status = record.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      i += 1;
    }
  }
  return files.sort();
}

export interface ReadGitStateInput {
  cwd: string;
  runProcess: RunProcess;
  env: NodeJS.ProcessEnv;
}

/** Reads the current worktree state. Never fails the caller. */
export async function readGitState(input: ReadGitStateInput): Promise<GitState> {
  const root = findGitRoot(input.cwd);
  if (root === null) {
    return { inRepo: false, root: null, dirty: false, changedFiles: [] };
  }

  const result = await input.runProcess({
    program: "git",
    // `--no-optional-locks` so the probe cannot take `index.lock` to refresh the
    // stat cache: this module reads and never writes, and a status that loses the
    // lock race to a concurrent git command reports a clean worktree. `-z`
    // because the newline form C-quotes any path with a non-ASCII byte.
    args: ["--no-optional-locks", "status", "--porcelain", "-z"],
    cwd: root,
    env: input.env,
    stdio: "capture",
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    // Git exists as a directory but the command failed (permissions, a broken
    // index). Treat it as "in a repo, state unknown" rather than as an error.
    return { inRepo: true, root, dirty: false, changedFiles: [] };
  }

  const changedFiles = parsePorcelain(result.output);
  return { inRepo: true, root, dirty: changedFiles.length > 0, changedFiles };
}

/**
 * Files changed since a baseline snapshot. Used after the agent runs to record
 * what *actually* changed, independent of what the agent claimed — the agent's
 * self-report is diagnostics, this is evidence.
 *
 * Less `own`, the paths setup wrote itself since the baseline, when given: see
 * {@link withoutOwnWrites}.
 */
export function changedSince(
  baseline: readonly string[],
  current: readonly string[],
  own?: { root: string; paths: readonly string[] },
): string[] {
  const before = new Set(baseline);
  const changed = current.filter((path) => !before.has(path));
  return own === undefined ? changed : withoutOwnWrites(own.root, changed, own.paths);
}

/**
 * Changed files with the ones setup wrote itself taken out, so what is left is
 * what the agent changed.
 *
 * `own` is every path this run wrote, absolute: a file, or a directory whose
 * whole contents are setup's. An entry inside one of them is setup's.
 *
 * So is a directory entry that holds nothing else. `git status` spells a
 * directory with nothing tracked in it as the directory alone, so the skill
 * setup installs into a new `.claude/skills/<name>/` arrives as `?? .claude/`,
 * which says nothing about what else is in there. The directory is read to
 * find out, and anything in it that is not setup's keeps the entry: an agent
 * that wrote there changed something.
 *
 * Kept whenever that cannot be settled — a read that fails, or more than
 * {@link OWN_WRITE_WALK_BUDGET} entries — because an entry left in can only
 * stop a run being failed as having changed nothing.
 */
export function withoutOwnWrites(
  root: string,
  changed: readonly string[],
  own: readonly string[],
): string[] {
  const owned = own.map((path) => resolve(path));
  return changed.filter((entry) => !isOwnWrite(resolve(root, entry), entry.endsWith("/"), owned));
}

/** How many entries one directory entry may be read through before it is kept. */
const OWN_WRITE_WALK_BUDGET = 500;

function isOwnWrite(path: string, isDirectory: boolean, owned: readonly string[]): boolean {
  if (owned.some((own) => isWithin(own, path))) {
    return true;
  }
  if (!isDirectory || !owned.some((own) => isWithin(path, own))) {
    return false;
  }
  const budget = { left: OWN_WRITE_WALK_BUDGET };
  return holdsOnly(path, owned, budget);
}

/** Whether everything under `dir` is inside one of `owned`. */
function holdsOnly(dir: string, owned: readonly string[], budget: { left: number }): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    budget.left -= 1;
    if (budget.left < 0) {
      return false;
    }
    const path = join(dir, entry.name);
    if (owned.some((own) => isWithin(own, path))) {
      continue;
    }
    if (!entry.isDirectory() || !holdsOnly(path, owned, budget)) {
      return false;
    }
  }
  return true;
}

/** Whether `path` is `dir` or inside it. */
function isWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * What git says about whether a path is ignored.
 *
 * Three values, because there are three answers and collapsing them loses the
 * one that matters. `unknown` is "git could not tell us" — no git on PATH, a
 * directory that is not a repository, a broken index — and it must read as
 * neither `ignored` (which would go silent about a live credential) nor
 * `not-ignored` (which would assert a fact nobody established).
 */
export type IgnoreState = "ignored" | "not-ignored" | "unknown";

export interface IsPathIgnoredInput {
  /** Repository root, which is where the question is asked from. */
  root: string;
  /** The path to ask about, relative to `root` and `/`-separated. */
  path: string;
  runProcess: RunProcess;
  env: NodeJS.ProcessEnv;
}

/**
 * Whether git ignores `path`, asked of git rather than worked out from a file.
 *
 * Reading `<root>/.gitignore` and matching patterns by hand gets this wrong in
 * every direction. Git consults a `.gitignore` in every directory along the
 * path, `.git/info/exclude`, the `core.excludesFile` in the user's home, and
 * the index; it applies last-match-wins with `!` re-inclusion, and the full
 * pattern language has `*`, `**`, character classes, trailing-slash
 * directory-only rules and a leading-slash anchor. A matcher that handles the
 * handful of spellings we thought of reports "not ignored" for a file the user
 * ignored three directories up, and "ignored" for a pattern it half-parsed.
 *
 * One path per call, deliberately. `-q` exits 0 when *any* argument is ignored,
 * so a batched call cannot say which — and this is asked about a file holding a
 * live API key, where "something in that list was fine" is not an answer.
 */
export async function isPathIgnored(input: IsPathIgnoredInput): Promise<IgnoreState> {
  const result = await input.runProcess({
    program: "git",
    // `--no-optional-locks` for the same reason `readGitState` uses it: this
    // module reads and never writes, and `check-ignore` consults the index.
    // `--` so a path beginning with a dash is a path and not a flag.
    args: ["--no-optional-locks", "check-ignore", "-q", "--", input.path],
    cwd: input.root,
    env: input.env,
    stdio: "capture",
    timeoutMs: 15_000,
  });

  // 0 and 1 are the documented answers. Everything else is a failure wearing an
  // exit code — 128 from git itself, 127 when `runProcess` could not spawn at
  // all — and none of them is evidence about the file.
  if (result.exitCode === 0) {
    return "ignored";
  }
  if (result.exitCode === 1) {
    return "not-ignored";
  }
  return "unknown";
}
