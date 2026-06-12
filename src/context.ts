import { join } from "node:path";
import { loadEnvFileFromDisk, loadOptionalEnvFileFromDisk } from "./config/envFile.js";
import { readConfig } from "./config/manager.js";
import { type ResolvedAuth, resolveAuth } from "./config/resolve.js";
import type { Config } from "./config/schema.js";

/** Global flags parsed by the root program. */
export interface GlobalOptions {
  apiKey?: string;
  host?: string;
  envFile?: string;
  json?: boolean;
}

/** Injectable sources; defaults wire the production implementations. */
export interface ContextDeps {
  env?: NodeJS.ProcessEnv;
  readConfig?: () => Config | null;
  loadEnvFile?: (path: string) => Record<string, string>;
  /** Loads the auto-discovered working-directory `.env` (empty map if absent). */
  loadAutoEnvFile?: () => Record<string, string>;
}

/** Shared per-invocation context. */
export interface Context {
  auth: ResolvedAuth;
  json: boolean;
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

  const auth = resolveAuth({
    flags: { apiKey: globalOpts.apiKey, host: globalOpts.host, envFile: globalOpts.envFile },
    env,
    readConfig: readConfigAdapter,
    loadEnvFile,
    autoEnvFile: loadAutoEnvFile(),
  });

  return { auth, json: globalOpts.json ?? false };
}
