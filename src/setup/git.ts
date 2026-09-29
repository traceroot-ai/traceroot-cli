import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** Parses `git status --porcelain` output into repo-relative paths. */
export function parsePorcelain(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    // "XY path" — and for renames, "XY old -> new"; the new path is what matters.
    const path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    files.push(arrow === -1 ? path : path.slice(arrow + 4));
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
    args: ["status", "--porcelain"],
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
 */
export function changedSince(baseline: readonly string[], current: readonly string[]): string[] {
  const before = new Set(baseline);
  return current.filter((path) => !before.has(path));
}
