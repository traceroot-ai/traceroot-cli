import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./api/client.js";
import type { CredentialEntry } from "./auth/credentials.js";
import { loadEnvFileFromDisk, loadOptionalEnvFileFromDisk } from "./config/envFile.js";
import { loadConfigOrThrow } from "./config/manager.js";
import { type ResolvedAuth, resolveAuth } from "./config/resolve.js";
import type { Config } from "./config/schema.js";
import { CliError, ExitCode } from "./output.js";

/** Global flags parsed by the root program. */
export interface GlobalOptions {
  apiKey?: string;
  host?: string;
  authHost?: string;
  project?: string;
  envFile?: string;
  json?: boolean;
  timeout?: string;
}

/** Injectable sources; defaults wire the production implementations. */
export interface ContextDeps {
  env?: NodeJS.ProcessEnv;
  readConfig?: () => Config | null;
  loadEnvFile?: (path: string) => Record<string, string>;
  /** Loads the auto-discovered working-directory `.env` (empty map if absent). */
  loadAutoEnvFile?: () => Record<string, string>;
  /** Session-store lookup; defaults to the real credentials file. */
  readCredential?: (host: string) => CredentialEntry | null;
}

/** Shared per-invocation context. */
export interface Context {
  auth: ResolvedAuth;
  json: boolean;
  /** Per-request network timeout in milliseconds. */
  timeoutMs: number;
}

/** Node's max timer delay (2^31−1 ms, ~24.8 days) — the ceiling for --timeout. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolves the per-request timeout (ms) with precedence: `--timeout` flag >
 * `TRACEROOT_TIMEOUT_MS` env > {@link DEFAULT_TIMEOUT_MS}. Throws a CliError on
 * a value that isn't a positive integer number of milliseconds within Node's
 * timer range.
 */
function resolveTimeoutMs(flag: string | undefined, env: NodeJS.ProcessEnv): number {
  const raw = flag ?? env.TRACEROOT_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  // Require a plain positive integer of milliseconds. A bare `Number()` would
  // silently accept hex (`0x10`), scientific (`1e2`), and padded/decimal forms,
  // so match the same digits-only rule `--limit` uses. Bound it to Node's
  // 32-bit timer range too: past 2^31-1 ms, `AbortSignal.timeout`/`setTimeout`
  // either clamp to ~1ms (instant timeouts on every request) or throw a raw
  // RangeError — both must surface here as a usage error instead.
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!(parsed > 0 && parsed <= MAX_TIMEOUT_MS)) {
    throw new CliError(
      `invalid timeout: ${raw} (expected a positive integer of milliseconds, at most ${MAX_TIMEOUT_MS})`,
      ExitCode.usage,
    );
  }
  return parsed;
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
  const readConfigAdapter = deps.readConfig ?? (() => loadConfigOrThrow());

  const auth = resolveAuth({
    flags: {
      apiKey: globalOpts.apiKey,
      host: globalOpts.host,
      authHost: globalOpts.authHost,
      project: globalOpts.project,
      envFile: globalOpts.envFile,
    },
    env,
    readConfig: readConfigAdapter,
    loadEnvFile,
    autoEnvFile: loadAutoEnvFile(),
    readCredential: deps.readCredential,
  });

  const timeoutMs = resolveTimeoutMs(globalOpts.timeout, env);

  return { auth, json: globalOpts.json ?? false, timeoutMs };
}
