import { chmodSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSecure } from "../util/secureFile.js";

/**
 * One stored session credential. The session token is the CLI's long-lived
 * refresh credential (device-flow login result) — it is exchanged for a
 * short-lived access JWT and never sent on API reads directly.
 */
export interface CredentialEntry {
  session_token: string;
  /**
   * The host that issued the session (the Next.js app), recorded only when it
   * differs from the API host key — a split dev setup. Mint/logout calls go
   * here, reads go to the API host.
   */
  auth_host?: string;
  /** Identity hint from login (JWT `email` claim); display only. */
  email?: string;
  /** ISO 8601 timestamp of the login that stored this entry. */
  created_at?: string;
}

interface CredentialsFile {
  version: 1;
  hosts: Record<string, CredentialEntry>;
}

/**
 * Resolves the credentials file path: `TRACEROOT_CREDENTIALS_PATH`, then
 * `$XDG_CONFIG_HOME/traceroot/credentials.json`, then
 * `~/.config/traceroot/credentials.json`. Unlike the project-local config file
 * (which carries per-project defaults), the session credential identifies the
 * user and lives in the home config directory.
 */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TRACEROOT_CREDENTIALS_PATH;
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config");
  return join(configHome, "traceroot", "credentials.json");
}

/** Trim and strip trailing slashes so all callers key the same host the same way. */
function hostKey(host: string): string {
  return host.trim().replace(/\/+$/, "");
}

function isEntry(value: unknown): value is CredentialEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  // The optional fields must be strings when present: a malformed auth_host
  // would otherwise flow to the mint/logout path as a non-URL.
  return (
    typeof entry.session_token === "string" &&
    ["auth_host", "email", "created_at"].every(
      (field) => entry[field] === undefined || typeof entry[field] === "string",
    )
  );
}

/**
 * Loads the credentials file, treating every failure mode (missing, unreadable,
 * invalid JSON, wrong shape) as an empty store — a corrupt file must never
 * block login or leak its bytes into an error message.
 */
function loadFile(path: string): CredentialsFile {
  const empty: CredentialsFile = { version: 1, hosts: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isStoreShape(parsed)) {
    return empty;
  }
  // isStoreShape validated every entry, so the map can be taken as-is.
  return { version: 1, hosts: parsed.hosts };
}

/**
 * The store shape this version reads and writes: a plain object with
 * `version: 1` and a plain-object `hosts` map. Anything else (an array, a
 * future/unknown version) is NOT usable — and, importantly, is treated as
 * corrupt by the write path so it gets preserved as a `.corrupt` sidecar
 * instead of being silently rewritten as v1 (which would drop whatever the
 * incompatible file carried).
 */
function isStoreShape(
  parsed: unknown,
): parsed is { version: 1; hosts: Record<string, CredentialEntry> } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const store = parsed as Record<string, unknown>;
  if (
    store.version !== 1 ||
    typeof store.hosts !== "object" ||
    store.hosts === null ||
    Array.isArray(store.hosts)
  ) {
    return false;
  }
  // EVERY entry must be valid: a store with one malformed entry is corrupt, not
  // "the good entries" — silently dropping the bad one here would let the next
  // rewrite (writeCredential/deleteCredential) discard its token for good.
  return Object.values(store.hosts).every(isEntry);
}

/**
 * True when the file exists but does not parse as a credentials store — a
 * corrupt or partially-written file. A missing file is not corrupt.
 */
function isCorrupt(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // A file that EXISTS but cannot be read (EACCES, EISDIR, …) must be
    // sidelined like a corrupt one: treating it as missing would let the next
    // write replace it with a fresh snapshot, erasing every stored host.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  try {
    return !isStoreShape(JSON.parse(raw) as unknown);
  } catch {
    return true;
  }
}

/**
 * Before a write, preserve a corrupt/unparseable store by renaming it to a
 * `.corrupt` sidecar instead of silently overwriting it — otherwise one bad
 * byte would wipe every other host's credential (load reads it as empty, and
 * the next write persists that empty store). Best-effort: never blocks the write.
 */
function backupIfCorrupt(path: string): void {
  if (!isCorrupt(path)) {
    return;
  }
  try {
    renameSync(path, `${path}.corrupt`);
    // The sidecar may still hold session tokens; clamp it to 0600 in case the
    // corrupt file arrived with looser permissions.
    chmodSync(`${path}.corrupt`, 0o600);
  } catch {
    // best-effort — a failed backup must not block login/logout
  }
}

/** The stored credential for `host`, or `null` when none is stored. */
export function readCredential(host: string, path?: string): CredentialEntry | null {
  const file = loadFile(path ?? credentialsPath());
  return file.hosts[hostKey(host)] ?? null;
}

/**
 * Stores (or replaces) the credential for `host`, preserving other hosts.
 * Atomic write with 0600 permissions; a failure throws the underlying fs error
 * (which only ever references paths, never the token).
 */
export function writeCredential(host: string, entry: CredentialEntry, path?: string): void {
  const target = path ?? credentialsPath();
  backupIfCorrupt(target);
  const file = loadFile(target);
  file.hosts[hostKey(host)] = entry;
  writeFileSecure(target, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Removes the credential for `host` (other hosts untouched). Returns whether an
 * entry was actually removed.
 */
export function deleteCredential(host: string, path?: string): boolean {
  const target = path ?? credentialsPath();
  const file = loadFile(target);
  const key = hostKey(host);
  if (!(key in file.hosts)) {
    return false;
  }
  delete file.hosts[key];
  writeFileSecure(target, `${JSON.stringify(file, null, 2)}\n`);
  return true;
}
