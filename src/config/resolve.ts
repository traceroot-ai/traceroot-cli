import type { Config } from "./schema.js";

/** Where a resolved value came from, in precedence order (high → low). */
export type AuthSource = "flag" | "env-file" | "env" | "config" | "auto-env-file" | "none";

export interface ResolvedField {
  value: string | undefined;
  source: AuthSource;
}

export interface ResolvedAuth {
  apiKey: ResolvedField;
  hostUrl: ResolvedField;
}

export interface AuthFlags {
  apiKey?: string;
  host?: string;
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

/**
 * Resolves authentication fields from (high → low) flags, an explicit env file,
 * the process environment, the config file, and finally a `.env`
 * auto-discovered in the working directory. Each field is resolved
 * independently. Never throws on missing values; only an env-file load error
 * (e.g. {@link EnvFileNotFoundError}) is allowed to propagate.
 */
export function resolveAuth(options: ResolveAuthOptions = {}): ResolvedAuth {
  const flags = options.flags ?? {};
  const env = options.env ?? {};
  const readConfig = options.readConfig ?? (() => null);
  const loadEnvFile = options.loadEnvFile ?? (() => ({}));
  const autoEnv = options.autoEnvFile ?? {};

  const fileMap: Record<string, string> = present(flags.envFile) ? loadEnvFile(flags.envFile) : {};
  const config = readConfig() ?? ({} as Partial<Config>);

  const apiKey = firstPresent(
    [
      { value: flags.apiKey, source: "flag" },
      { value: fileMap.TRACEROOT_API_KEY, source: "env-file" },
      { value: env.TRACEROOT_API_KEY, source: "env" },
      { value: config.api_key, source: "config" },
      { value: autoEnv.TRACEROOT_API_KEY, source: "auto-env-file" },
    ],
    normalizeApiKey,
  );

  const hostUrl = firstPresent(
    [
      { value: flags.host, source: "flag" },
      { value: fileMap.TRACEROOT_HOST_URL, source: "env-file" },
      { value: env.TRACEROOT_HOST_URL, source: "env" },
      { value: config.host_url, source: "config" },
      { value: autoEnv.TRACEROOT_HOST_URL, source: "auto-env-file" },
    ],
    normalizeHostUrl,
  );

  return { apiKey, hostUrl };
}
