import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./api/client.js";
import { loadEnvFileFromDisk, loadOptionalEnvFileFromDisk } from "./config/envFile.js";
import { readConfig, readGlobalConfig } from "./config/manager.js";
import { type ResolvedAuth, resolveAuth } from "./config/resolve.js";
import type { Config } from "./config/schema.js";
import { CliError } from "./output.js";

/** Global flags parsed by the root program. */
export interface GlobalOptions {
  apiKey?: string;
  host?: string;
  envFile?: string;
  json?: boolean;
  timeout?: string;
}

/** Injectable sources; defaults wire the production implementations. */
export interface ContextDeps {
  env?: NodeJS.ProcessEnv;
  readConfig?: () => Config | null;
  /** Reads the global (per-user) fallback config; defaults to the real global reader. */
  readGlobalConfig?: () => Config | null;
  loadEnvFile?: (path: string) => Record<string, string>;
  /** Loads the auto-discovered working-directory `.env` (empty map if absent). */
  loadAutoEnvFile?: () => Record<string, string>;
}

/** Shared per-invocation context. */
export interface Context {
  auth: ResolvedAuth;
  json: boolean;
  /** Per-request network timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Resolves the per-request timeout (ms) with precedence: `--timeout` flag >
 * `TRACEROOT_TIMEOUT_MS` env > {@link DEFAULT_TIMEOUT_MS}. Throws a CliError on
 * a value that isn't a positive integer number of milliseconds.
 */
function resolveTimeoutMs(flag: string | undefined, env: NodeJS.ProcessEnv): number {
  const raw = flag ?? env.TRACEROOT_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  // Require a plain positive integer of milliseconds. A bare `Number()` would
  // silently accept hex (`0x10`), scientific (`1e2`), and padded/decimal forms,
  // so match the same digits-only rule `--limit` uses.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) <= 0) {
    throw new CliError(`invalid timeout: ${raw} (expected a positive integer of milliseconds)`);
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * Builds the shared context from the parsed global options. Commands obtain
 * theirs once via, e.g., `buildContext(command.optsWithGlobals())`.
 */
export function buildContext(globalOpts: GlobalOptions, deps: ContextDeps = {}): Context {
  const env = deps.env ?? process.env;
  const loadEnvFile = deps.loadEnvFile ?? loadEnvFileFromDisk;
  // Auto-discover a `.env` in the working directory (lowest-precedence source).
  const loadAutoEnvFile =
    deps.loadAutoEnvFile ?? (() => loadOptionalEnvFileFromDisk(join(process.cwd(), ".env")));
  const readConfigAdapter =
    deps.readConfig ??
    (() => {
      const result = readConfig();
      return result.ok ? result.config : null;
    });
  const readGlobalConfigAdapter =
    deps.readGlobalConfig ??
    (() => {
      const result = readGlobalConfig();
      return result.ok ? result.config : null;
    });

  const auth = resolveAuth({
    flags: { apiKey: globalOpts.apiKey, host: globalOpts.host, envFile: globalOpts.envFile },
    env,
    readConfig: readConfigAdapter,
    readGlobalConfig: readGlobalConfigAdapter,
    loadEnvFile,
    autoEnvFile: loadAutoEnvFile(),
  });

  const timeoutMs = resolveTimeoutMs(globalOpts.timeout, env);

  return { auth, json: globalOpts.json ?? false, timeoutMs };
}
