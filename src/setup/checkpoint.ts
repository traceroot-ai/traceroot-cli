import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getVersion } from "../version.js";
import { findGitRoot } from "./git.js";
import { SETUP_STAGES, type SetupCheckpoint, type SetupStage } from "./types.js";

/**
 * The checkpoint lives beside the config the CLI already owns, so the existing
 * `.traceroot/.gitignore` (written by `config/manager.ts`) covers it and it can
 * never be committed by accident.
 */
export function checkpointPath(root: string): string {
  return join(root, ".traceroot", "setup.json");
}

/**
 * The directory a checkpoint belongs to: the repository root, not the working
 * directory.
 *
 * Setup writes the checkpoint at the repo root (that is what it instruments and
 * what `--resume` refers to), so reading it relative to `cwd` would silently
 * lose the checkpoint for anyone who runs `traceroot setup` from a
 * subdirectory — a rerun would look like a first run and re-do everything.
 */
export function setupRoot(cwd: string): string {
  return findGitRoot(cwd) ?? cwd;
}

/** A fresh checkpoint for a run starting now. */
export function newCheckpoint(now: Date = new Date()): SetupCheckpoint {
  const iso = now.toISOString();
  return {
    version: 1,
    startedAt: iso,
    updatedAt: iso,
    cliVersion: getVersion(),
    completedStages: [],
  };
}

function isStage(value: unknown): value is SetupStage {
  return typeof value === "string" && (SETUP_STAGES as readonly string[]).includes(value);
}

/**
 * Reads a checkpoint, returning `null` for every recoverable case (absent,
 * unreadable, malformed, wrong version). A corrupt checkpoint must never crash
 * setup — the correct response is to start fresh, and the caller warns.
 *
 * Unknown fields are dropped rather than passed through, so a checkpoint written
 * by a future CLI version cannot smuggle unexpected content into this run.
 */
export function readCheckpoint(root: string): SetupCheckpoint | null {
  const path = checkpointPath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.startedAt !== "string") {
    return null;
  }

  const completedStages = Array.isArray(obj.completedStages)
    ? obj.completedStages.filter(isStage)
    : [];

  const checkpoint: SetupCheckpoint = {
    version: 1,
    startedAt: obj.startedAt,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : obj.startedAt,
    cliVersion: typeof obj.cliVersion === "string" ? obj.cliVersion : "unknown",
    completedStages,
  };

  const copyString = (key: keyof SetupCheckpoint): void => {
    const value = obj[key];
    if (typeof value === "string") {
      // Narrow assignment: every key routed through here is a `string?` field.
      (checkpoint as unknown as Record<string, unknown>)[key] = value;
    }
  };
  for (const key of [
    "host",
    "uiBaseUrl",
    "workspaceId",
    "projectId",
    "projectName",
    "projectKeyId",
    "projectKeyHint",
    "agentId",
    "sdkVersion",
  ] as const) {
    copyString(key);
  }
  for (const key of ["service", "application", "trace", "lastError"] as const) {
    const value = obj[key];
    if (typeof value === "object" && value !== null) {
      (checkpoint as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return checkpoint;
}

/**
 * Atomically writes the checkpoint (temp file + rename), so an interrupted run
 * can never leave a truncated file where a valid one used to be — the same
 * discipline `config/manager.ts` and `skills/install.ts` already use.
 *
 * Never throws: a checkpoint is an optimization for reruns, and failing the
 * whole setup because a convenience file could not be written would be worse
 * than losing the ability to resume.
 */
export function writeCheckpoint(root: string, checkpoint: SetupCheckpoint): void {
  const target = checkpointPath(root);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    ensureGitignore(dirname(target));
    const payload = `${JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Removes the checkpoint; used by a clean rerun that starts from scratch. */
export function clearCheckpoint(root: string): void {
  try {
    rmSync(checkpointPath(root), { force: true });
  } catch {
    // best-effort
  }
}

/** Records a stage as complete, keeping the list ordered and free of duplicates. */
export function markComplete(checkpoint: SetupCheckpoint, stage: SetupStage): void {
  if (!checkpoint.completedStages.includes(stage)) {
    checkpoint.completedStages.push(stage);
    checkpoint.completedStages.sort((a, b) => SETUP_STAGES.indexOf(a) - SETUP_STAGES.indexOf(b));
  }
}

/** True when `stage` completed in a previous run. */
export function hasCompleted(checkpoint: SetupCheckpoint, stage: SetupStage): boolean {
  return checkpoint.completedStages.includes(stage);
}

/**
 * Mirrors `config/manager.ts`'s safety net: a `.gitignore` containing `*` in our
 * own directory, so a checkpoint (or a config) can never be committed. Only ever
 * acts on a directory named `.traceroot`, and never on an existing file.
 */
function ensureGitignore(dir: string): void {
  try {
    const gitignore = join(dir, ".gitignore");
    if (dir.endsWith(".traceroot") && !existsSync(gitignore)) {
      writeFileSync(gitignore, "*\n");
    }
  } catch {
    // best-effort only
  }
}
