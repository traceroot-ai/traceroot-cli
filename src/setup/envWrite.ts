import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Writing the project credential into a dotenv file.
 *
 * The complement of `config/envFile.ts`, which only reads. The rules: replace
 * keys in place so comments and ordering survive, append new keys after a blank
 * line, `chmod 0600`, and diff before writing so an unchanged value is not a
 * write at all.
 *
 * The target is always `.env.traceroot`, never `.env`: `.env` is frequently
 * committed and frequently holds shared, non-secret defaults, and a tool that
 * silently drops a live credential into a tracked file has done real damage.
 *
 * Nor `.env.local`. That name is Next.js's convention
 * and therefore already belongs to a great many of the repositories setup runs
 * in — writing into a file the project itself owns and loads means our lines and
 * theirs are indistinguishable afterwards, to a rerun and to a human. A file
 * named after this tool collides with nobody.
 */

// `\r?$` because `.` does not match `\r`: without it a CRLF file matches no line
// at all, so a rerun appends a second copy of the key instead of replacing the
// first, and `removeEnvKeys` cannot remove the old one. `config/envFile.ts`
// strips the same carriage return when reading.
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*?)\r?$/;

/**
 * What a `.env.traceroot` says about itself, written once when setup creates it.
 *
 * A file appears in someone's repository with a live credential in it and no
 * account of where it came from is a file nobody can reason about. So the
 * header says all of it: who wrote it, what is in it, that it must not be
 * committed, and that it can be deleted once it has done its job.
 * The last line matters most — without it the honest reading of a secret on
 * disk is "this is permanent now".
 *
 * `#` because that is the comment syntax dotenv parsers actually implement, and
 * because {@link upsertEnvContent} already skips any line that is not a
 * `KEY=value`, so these survive a rerun untouched and in place.
 *
 * Never interpolated with anything. This is the one file in the CLI where
 * putting a key somewhere it does not belong is unrecoverable, so the header is
 * a constant and cannot be handed a value by accident.
 */
export const ENV_FILE_HEADER: readonly string[] = [
  "# Written by `traceroot setup`. This file contains a live API key.",
  "# Do not commit it. It can be deleted once your application is sending traces.",
];

/** Quotes a value only when it would otherwise be misparsed. */
function quoteIfNeeded(value: string): string {
  if (value === "") {
    return '""';
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value;
  }
  return /[\s#"']/.test(value) ? JSON.stringify(value) : value;
}

export interface UpsertResult {
  /** Keys actually written; empty when every value already matched. */
  written: string[];
  created: boolean;
}

/**
 * Renders the new file contents. Pure, so the diff logic is testable without
 * touching the filesystem.
 */
export function upsertEnvContent(
  existing: string | null,
  updates: Record<string, string>,
): { content: string; written: string[] } {
  // The header goes on at creation and never again. `existing === null` is the
  // only signal that means "this file did not exist a moment ago" — checking
  // for the header text instead would re-add it to a file a user had
  // deliberately stripped it from, and checking nothing at all would stack a
  // fresh copy on top of the file on every rerun.
  const lines = existing === null ? [...ENV_FILE_HEADER, ""] : existing.split("\n");
  // A trailing newline yields a final empty element; drop it and re-add on write.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const written: string[] = [];
  // Which keys the file already mentions at all, so the append pass below only
  // adds the ones it does not. Distinct from "which were rewritten": a key
  // already holding the right value is present but is not a write.
  const present = new Set<string>();

  // Every occurrence, not just the first: `config/envFile.ts` (and dotenv, and
  // `node --env-file`) resolve a duplicate key to the LAST one, so rewriting only
  // the first leaves the stale value in effect while reporting success.
  for (let i = 0; i < lines.length; i += 1) {
    const match = (lines[i] ?? "").match(LINE);
    const key = match?.[1];
    if (key === undefined) {
      continue;
    }
    const desired = updates[key];
    if (desired === undefined) {
      continue;
    }
    present.add(key);
    const currentRaw = (match?.[2] ?? "").trim();
    const current =
      currentRaw.length >= 2 &&
      currentRaw[0] === currentRaw[currentRaw.length - 1] &&
      (currentRaw[0] === '"' || currentRaw[0] === "'")
        ? currentRaw.slice(1, -1)
        : currentRaw;
    if (current === desired) {
      continue; // already correct — not a write
    }
    lines[i] = `${key}=${quoteIfNeeded(desired)}`;
    if (!written.includes(key)) {
      written.push(key);
    }
  }

  const missing = Object.entries(updates).filter(([key]) => !present.has(key));
  if (missing.length > 0) {
    if (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() !== "") {
      lines.push("");
    }
    for (const [key, value] of missing) {
      lines.push(`${key}=${quoteIfNeeded(value)}`);
      written.push(key);
    }
  }

  return { content: lines.length === 0 ? "" : `${lines.join("\n")}\n`, written };
}

/**
 * Applies an upsert to disk atomically with 0600 permissions. Returns the keys
 * that changed; an empty list means nothing was written.
 */
export function upsertEnvFile(path: string, updates: Record<string, string>): UpsertResult {
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : null;
  const { content, written } = upsertEnvContent(existing, updates);

  // The mode is part of this function's contract, so it is enforced even when
  // there is nothing to write: a file that already holds the right value can
  // still be group- or world-readable, and it holds a live key. `lstatSync`
  // because a symlink here should be left alone rather than have its target
  // chmod-ed.
  if (existed) {
    try {
      const stats = lstatSync(path);
      if (stats.isFile() && (stats.mode & 0o177) !== 0) {
        chmodSync(path, 0o600);
      }
    } catch {
      // Best-effort: win32 and some filesystems do not support this.
    }
  }

  if (written.length === 0) {
    return { written: [], created: false };
  }

  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // Clear a temp file left behind by a crashed run with this pid, then create
    // ours exclusively: `wx` never follows a symlink and never writes into a file
    // that already exists, so a planted `<path>.<pid>.tmp` makes the write fail —
    // and fall into the cleanup below — instead of redirecting the credential.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best-effort: win32 and some filesystems do not support this.
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  return { written, created: !existed };
}

/** Removes keys from a dotenv file, leaving every other line untouched. */
export function removeEnvKeys(path: string, keys: readonly string[]): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const wanted = new Set(keys);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const key = line.match(LINE)?.[1];
    if (key !== undefined && wanted.has(key)) {
      removed.push(key);
      continue;
    }
    kept.push(line);
  }
  if (removed.length === 0) {
    return [];
  }
  writeFileSync(path, kept.join("\n"), { mode: 0o600 });
  return removed;
}

/**
 * Whether an existing `.gitignore` already covers `entry`.
 *
 * `entry` is a path relative to the repository root, so it may contain slashes
 * — `test1/.env.traceroot` — and the anchoring rules git applies are what make
 * this worth spelling out rather than doing with `includes`:
 *
 * - A pattern with no slash matches a basename at ANY depth, so a plain
 *   `.env.traceroot` covers the file wherever under the root it lands.
 * - A pattern with a slash is anchored to the directory holding the
 *   `.gitignore`, so `/.env.traceroot` covers the root's copy and nothing else.
 *   Treating that as covering `test1/.env.traceroot` is precisely the mistake
 *   that would commit an API key.
 *
 * Conservative by construction: anything not recognised here is treated as not
 * covering the file, and the worst case is a duplicate ignore line. The
 * opposite error costs a leaked credential.
 */
function alreadyIgnored(patterns: readonly string[], entry: string): boolean {
  const basename = entry.slice(entry.lastIndexOf("/") + 1);
  // Last match wins, as git itself does, and a leading `!` re-includes: returning
  // on the first positive rule reported a file as ignored when a later `!` line
  // put it back, which is the one error here that costs a leaked credential.
  let ignored = false;
  for (const raw of patterns) {
    if (raw === "" || raw.startsWith("#")) {
      continue;
    }
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    const matches =
      // Exact, and the root-anchored spelling of the exact same path.
      pattern === entry ||
      pattern === `/${entry}` ||
      // Unanchored: matches this basename at any depth, which includes ours.
      (!pattern.includes("/") && (pattern === basename || pattern === ".env*"));
    if (matches) {
      ignored = !negated;
    }
  }
  return ignored;
}

/**
 * Ensures a `.gitignore` rule covers `entry`, appending one when it is missing.
 *
 * `entry` is relative to `root`, which is the repository root — one ignore file
 * for the whole repository, because that is the one git consults for every path
 * in it. The alternative, a `.gitignore` dropped into the service directory,
 * would mean writing a new file into the user's application folder to protect a
 * file we put there ourselves.
 *
 * Returns the action taken so the caller can tell the user. Only ever appends —
 * a user's ignore file is theirs, and rewriting it would be a surprise.
 */
export function ensureIgnored(root: string, entry: string): "already" | "appended" | "failed" {
  const path = join(root, ".gitignore");
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const patterns = existing.split("\n").map((line) => line.trim());
    if (alreadyIgnored(patterns, entry)) {
      return "already";
    }
    const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${existing}${prefix}${entry}\n`);
    return "appended";
  } catch {
    return "failed";
  }
}
