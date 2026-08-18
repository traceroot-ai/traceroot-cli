import { readFileSync } from "node:fs";
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
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).session_token === "string"
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
  if (typeof parsed !== "object" || parsed === null) {
    return empty;
  }
  const hosts = (parsed as Record<string, unknown>).hosts;
  if (typeof hosts !== "object" || hosts === null) {
    return empty;
  }
  const valid: Record<string, CredentialEntry> = {};
  for (const [host, entry] of Object.entries(hosts)) {
    if (isEntry(entry)) {
      valid[host] = entry;
    }
  }
  return { version: 1, hosts: valid };
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
