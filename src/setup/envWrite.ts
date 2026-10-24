import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Writing the project credential into a dotenv file.
 *
 * The complement of `config/envFile.ts`, which only reads. The rules: replace
 * keys in place so comments and ordering survive, append new keys after a blank
 * line, `chmod 0600` a file this creates but never one the project had, and diff
 * before writing so an unchanged value is not a write at all.
 *
 * The target is a file the project already loads — see
 * {@link chooseCredentialEnvFile}. This module used to invent `.env.traceroot`
 * so that our lines could never be confused with the user's. It bought that at
 * the price of a filename no runtime reads: every loader had to be taught the
 * path, the file had to be added to `.gitignore` by us, and a user who deleted
 * it as the header invited them to broke their own application. A credential
 * nothing loads is not a safer credential, it is a setup that did not happen.
 */

// `\r?$` because `.` does not match `\r`: without it a CRLF file matches no line
// at all, so a rerun appends a second copy of the key instead of replacing the
// first, and `removeEnvKeys` cannot remove the old one. `config/envFile.ts`
// strips the same carriage return when reading.
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*?)\r?$/;

/**
 * What a credential env file this run *created* says about itself.
 *
 * Written once, at creation, and never added to a file the project already had
 * — the whole point of writing into the project's own `.env` is that the
 * credential sits among the user's other secrets, and prefacing their file with
 * a note about ours would be the loudest thing in it.
 *
 * Two facts, both load-bearing: who wrote the file, so it is not a mystery a
 * month later, and that it must not be committed. The old header also said the
 * file could be deleted once traces were flowing, which was true of a file only
 * this tool read and is false of this one: deleting it now takes the
 * application's own configuration with it.
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
  "# Created by `traceroot setup`. This file contains a live API key.",
  "# Do not commit it.",
];

/**
 * The env file names a project is expected to own, in the order they are found.
 *
 * Shared with `detectEnvFiles` so that the file setup writes the credential
 * into and the files setup tells the agent about are drawn from one list. A
 * third name added here is a name both of them learn.
 */
export const PROJECT_ENV_FILES: readonly string[] = [".env", ".env.local"];

export interface CredentialEnvFile {
  /** Bare filename, to be joined onto the service directory. */
  name: string;
  /** False when the file is not on disk yet and the caller will create it. */
  existed: boolean;
}

/**
 * Which of the project's env files the credential belongs in.
 *
 * Preference, and the reasons, in order:
 *
 * 1. An existing `.env.local`. Where that name is a convention at all it is the
 *    convention for local secrets, and the toolchains that define it gitignore
 *    it out of the box — `create-next-app` ships `.env*.local`. A project that
 *    has one has already nominated it as the place a live key goes.
 * 2. An existing `.env`. The common case, and the file every dotenv
 *    implementation in both ecosystems reads without being told to.
 * 3. A `.env` we create. Never a `.env.local` we create: a file we invent has
 *    to be one the project's loader finds by default, and `.env` is the only
 *    name that qualifies. `python-dotenv`'s `load_dotenv()` searches for `.env`
 *    and no other name, so a `.env.local` conjured into a Python project would
 *    reproduce precisely the bug this module stopped having — a credential in a
 *    file nothing reads.
 *
 * `.env.local` before `.env` is the one ordering that is not obvious, because
 * `.env` is the more widely read name. The tiebreak is not which file is read;
 * it is which file is committed. Next.js documents `.env` as the place for
 * shared defaults that belong in version control, and a run that put a live key
 * there would be refused by the caller's tracked-file check and leave the user
 * with nothing — while the `.env.local` beside it was both loaded and ignored.
 */
export function chooseCredentialEnvFile(serviceDir: string): CredentialEnvFile {
  for (const name of [".env.local", ".env"]) {
    if (existsSync(join(serviceDir, name))) {
      return { name, existed: true };
    }
  }
  return { name: ".env", existed: false };
}

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
 * Applies an upsert to disk atomically. Returns the keys that changed; an empty
 * list means nothing was written.
 *
 * A file this creates is 0600. A file that already existed keeps the mode it
 * had: it is the project's own env file, and other things read it — a
 * container running as another uid reads a 0644 `.env` and cannot read a 0600
 * one, so tightening it took the application's whole configuration away, not
 * only the key, and nothing put the mode back.
 */
export function upsertEnvFile(path: string, updates: Record<string, string>): UpsertResult {
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : null;
  const { content, written } = upsertEnvContent(existing, updates);

  if (written.length === 0) {
    return { written: [], created: false };
  }

  // Carried onto the replacement, because the rename below swaps in a new file
  // and with it a new mode. `statSync` rather than `lstatSync`: through a
  // symlink, the mode that matters is that of the file the project reads, and a
  // link's own (0777 on Linux) would leave the key world-writable.
  const mode = existed ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // Clear a temp file left behind by a crashed run with this pid, then create
    // ours exclusively: `wx` never follows a symlink and never writes into a file
    // that already exists, so a planted `<path>.<pid>.tmp` makes the write fail —
    // and fall into the cleanup below — instead of redirecting the credential.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, content, { mode, flag: "wx" });
    try {
      // Again after the write, because the mode `writeFileSync` creates with is
      // narrowed by the umask.
      chmodSync(tmp, mode);
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

/**
 * The same removal as {@link removeEnvKeys}, without the disk.
 *
 * Split out because one caller has a file's contents and not a path it can
 * write: `verify.ts` moves the credential file aside and stands a copy without
 * the credential in its place. The shape a dotenv assignment can take —
 * `export`, leading space, a carriage return the file may or may not have — has
 * to be the one this module already uses, because two readings of it would
 * drift, and the direction they would drift in is leaving a live key in a file
 * this tool has promised does not hold one.
 *
 * Everything that is not a removed assignment survives as it was: comments,
 * blank lines, ordering, CRLF endings, and a final newline or its absence.
 */
export function removeEnvContent(
  existing: string,
  keys: readonly string[],
): { content: string; removed: string[] } {
  const wanted = new Set(keys);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of existing.split("\n")) {
    const key = line.match(LINE)?.[1];
    if (key !== undefined && wanted.has(key)) {
      removed.push(key);
      continue;
    }
    kept.push(line);
  }
  return { content: kept.join("\n"), removed };
}

/** Removes keys from a dotenv file, leaving every other line untouched. */
export function removeEnvKeys(path: string, keys: readonly string[]): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const { content, removed } = removeEnvContent(readFileSync(path, "utf8"), keys);
  if (removed.length === 0) {
    return [];
  }
  writeFileSync(path, content, { mode: 0o600 });
  return removed;
}
