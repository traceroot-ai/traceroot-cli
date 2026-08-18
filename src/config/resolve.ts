import {
  type CredentialEntry,
  readCredential as readCredentialFromDisk,
} from "../auth/credentials.js";
import { DEFAULT_HOST } from "../commands/constants.js";
import type { Config } from "./schema.js";

/**
 * Where a resolved value came from, in precedence order (high → low).
 * `credentials-file` is the home-directory session store written by device-flow
 * login; `default` marks a built-in fallback (e.g. the production host).
 */
export type AuthSource =
  | "flag"
  | "env-file"
  | "env"
  | "credentials-file"
  | "config"
  | "auto-env-file"
  | "default"
  | "none";

export interface ResolvedField {
  value: string | undefined;
  source: AuthSource;
}

/**
 * The one credential the CLI will authenticate with. `api-key` is a project
 * API key sent verbatim as the bearer; `session` is a long-lived session token
 * (device-flow login) that is exchanged for a short-lived access JWT before any
 * API call; `none` means nothing resolved.
 */
export interface ResolvedCredential {
  kind: "api-key" | "session" | "none";
  value: string | undefined;
  source: AuthSource;
}

export interface ResolvedAuth {
  credential: ResolvedCredential;
  /** The public API host. Always resolved — falls back to the production host. */
  hostUrl: ResolvedField;
  /**
   * The host running device login + token mint (the Next.js app). Defaults to
   * the API host; split dev setups override it via flag/env or the stored entry.
   */
  authHost: ResolvedField;
  /** Default project for user-credential reads; absent unless configured. */
  projectId: ResolvedField;
}

export interface AuthFlags {
  apiKey?: string;
  host?: string;
  authHost?: string;
  project?: string;
  envFile?: string;
}

export interface ResolveAuthOptions {
  flags?: AuthFlags;
  env?: NodeJS.ProcessEnv;
  readConfig?: () => Config | null;
  loadEnvFile?: (path: string) => Record<string, string>;
  /**
   * Variables auto-discovered from a `.env` in the working directory. This is
   * the LOWEST-precedence source (below the config file); explicit sources
   * (flags, `--env-file`, process env, config) always win over it.
   */
  autoEnvFile?: Record<string, string>;
  /** Session-store lookup for a host; injectable for tests. */
  readCredential?: (host: string) => CredentialEntry | null;
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Trim and strip trailing slashes; the protocol `//` is never at the end. */
function normalizeHostUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Tolerates an API key pasted in its env-assignment form. Copying the key from
 * the UI yields `TRACEROOT_API_KEY=tr_...`; if a user pastes that whole string
 * (e.g. into `--api-key`), strip the `TRACEROOT_API_KEY=` (optionally
 * `export `-prefixed) and any surrounding quotes so the bare key is used.
 */
function normalizeApiKey(value: string): string {
  let key = value.trim();
  const assignment = key.match(/^(?:export\s+)?TRACEROOT_API_KEY\s*=\s*(.*)$/i);
  if (assignment?.[1] !== undefined) {
    key = assignment[1].trim();
  }
  if (key.length >= 2) {
    const first = key[0];
    const last = key[key.length - 1];
    if (first === last && (first === '"' || first === "'")) {
      key = key.slice(1, -1);
    }
  }
  return key;
}

interface Candidate {
  value: string | undefined;
  source: Exclude<AuthSource, "none">;
}

function firstPresent(
  candidates: Candidate[],
  normalize?: (value: string) => string,
): ResolvedField {
  for (const candidate of candidates) {
    if (!present(candidate.value)) {
      continue;
    }
    const value = normalize ? normalize(candidate.value) : candidate.value;
    // Normalization can empty a value (e.g. a slashes-only host); if so, fall
    // through to the next candidate rather than reporting an empty value with a
    // concrete source.
    if (value === "") {
      continue;
    }
    return { value, source: candidate.source };
  }
  return { value: undefined, source: "none" };
}

interface CredentialCandidate extends Candidate {
  kind: "api-key" | "session";
  normalize?: (value: string) => string;
}

function firstCredential(candidates: CredentialCandidate[]): ResolvedCredential {
  for (const candidate of candidates) {
    if (!present(candidate.value)) {
      continue;
    }
    const value = candidate.normalize
      ? candidate.normalize(candidate.value)
      : candidate.value.trim();
    if (value === "") {
      continue;
    }
    return { kind: candidate.kind, value, source: candidate.source };
  }
  return { kind: "none", value: undefined, source: "none" };
}

/**
 * Resolves the credential, hosts, and default project from (high → low) flags,
 * an explicit env file, the process environment, the home-directory session
 * store, the config file, and finally a `.env` auto-discovered in the working
 * directory. Session sources (`TRACEROOT_TOKEN`, the credentials file) outrank
 * ambient API-key sources — a logged-in user beats a lingering project key —
 * but an explicit `--api-key` flag outranks everything. Each field resolves
 * independently. Never throws on missing values; only an env-file load error
 * (e.g. {@link EnvFileNotFoundError}) is allowed to propagate.
 */
export function resolveAuth(options: ResolveAuthOptions = {}): ResolvedAuth {
  const flags = options.flags ?? {};
  const env = options.env ?? {};
  const readConfig = options.readConfig ?? (() => null);
  const loadEnvFile = options.loadEnvFile ?? (() => ({}));
  const autoEnv = options.autoEnvFile ?? {};
  const readCredential = options.readCredential ?? readCredentialFromDisk;

  const fileMap: Record<string, string> = present(flags.envFile) ? loadEnvFile(flags.envFile) : {};
  const config = readConfig() ?? ({} as Partial<Config>);

  // The host resolves first: the session-store lookup is keyed by it.
  const hostUrl = firstPresent(
    [
      { value: flags.host, source: "flag" },
      { value: fileMap.TRACEROOT_HOST_URL, source: "env-file" },
      { value: env.TRACEROOT_HOST_URL, source: "env" },
      { value: config.host_url, source: "config" },
      { value: autoEnv.TRACEROOT_HOST_URL, source: "auto-env-file" },
      { value: DEFAULT_HOST, source: "default" },
    ],
    normalizeHostUrl,
  );

  const storedEntry = hostUrl.value !== undefined ? readCredential(hostUrl.value) : null;

  const credential = firstCredential([
    { kind: "api-key", value: flags.apiKey, source: "flag", normalize: normalizeApiKey },
    { kind: "session", value: fileMap.TRACEROOT_TOKEN, source: "env-file" },
    {
      kind: "api-key",
      value: fileMap.TRACEROOT_API_KEY,
      source: "env-file",
      normalize: normalizeApiKey,
    },
    { kind: "session", value: env.TRACEROOT_TOKEN, source: "env" },
    { kind: "session", value: storedEntry?.session_token, source: "credentials-file" },
    { kind: "api-key", value: env.TRACEROOT_API_KEY, source: "env", normalize: normalizeApiKey },
    { kind: "api-key", value: config.api_key, source: "config", normalize: normalizeApiKey },
    // The auto-discovered .env deliberately contributes only an API key, never
    // TRACEROOT_TOKEN: a personal session credential does not belong in a
    // repo-shared .env, and honoring one there would silently impersonate its
    // committer. An explicit --env-file is a deliberate act and honors both.
    {
      kind: "api-key",
      value: autoEnv.TRACEROOT_API_KEY,
      source: "auto-env-file",
      normalize: normalizeApiKey,
    },
  ]);

  const authHost = firstPresent(
    [
      { value: flags.authHost, source: "flag" },
      { value: fileMap.TRACEROOT_AUTH_URL, source: "env-file" },
      { value: env.TRACEROOT_AUTH_URL, source: "env" },
      { value: storedEntry?.auth_host, source: "credentials-file" },
      { value: hostUrl.value, source: "default" },
    ],
    normalizeHostUrl,
  );

  const projectId = firstPresent([
    { value: flags.project, source: "flag" },
    { value: fileMap.TRACEROOT_PROJECT_ID, source: "env-file" },
    { value: env.TRACEROOT_PROJECT_ID, source: "env" },
    { value: config.project_id, source: "config" },
    { value: autoEnv.TRACEROOT_PROJECT_ID, source: "auto-env-file" },
  ]);

  return { credential, hostUrl, authHost, projectId };
}
