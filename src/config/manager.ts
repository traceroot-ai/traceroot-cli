import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Config, ConfigError, type ConfigReadResult } from "./schema.js";

/**
 * Resolves the config file path. Precedence: explicit `path` argument, then a
 * non-empty `TRACEROOT_CONFIG_PATH`, then a project-local
 * `./.traceroot/config.json` in the current working directory. The config lives
 * in the project directory (mirroring the `.env` the CLI already auto-discovers
 * there), not the user's home folder. See {@link globalConfigPath} for the
 * global fallback location `login` never writes to.
 */
export function configPath(path?: string): string {
  if (path !== undefined && path !== "") {
    return path;
  }
  const fromEnv = process.env.TRACEROOT_CONFIG_PATH;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return join(process.cwd(), ".traceroot", "config.json");
}

/** Directory that holds the config file. */
export function configDir(path?: string): string {
  return dirname(configPath(path));
}

/**
 * Resolves the global (per-user) config fallback path. Precedence: explicit
 * `path` argument, then `$XDG_CONFIG_HOME/traceroot/config.json` when
 * `XDG_CONFIG_HOME` is set, else `~/.config/traceroot/config.json`. This is a
 * read-only fallback consulted when no project-local config is found; `login`
 * never writes here (see {@link configPath}).
 */
export function globalConfigPath(path?: string): string {
  if (path !== undefined && path !== "") {
    return path;
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome !== undefined && xdgConfigHome !== "") {
    return join(xdgConfigHome, "traceroot", "config.json");
  }
  return join(homedir(), ".config", "traceroot", "config.json");
}

function isValidShape(value: unknown): value is Config {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.api_key === "string" && typeof obj.host_url === "string";
}

/**
 * Reads and validates the config file at `target`. Never throws for the four
 * documented cases (valid, missing, invalid JSON, invalid shape); any other fs
 * error (EACCES, EISDIR, …) is rethrown as a genuine fault. Shared by
 * {@link readConfig} (project-local) and {@link readGlobalConfig} (the global
 * fallback) so both paths parse identically.
 */
function parseConfigFile(target: string): ConfigReadResult {
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Discard the raw SyntaxError text and the file contents so no file bytes
    // (which may include a secret) end up in the error message.
    return {
      ok: false,
      reason: "invalid-json",
      error: new ConfigError("INVALID_JSON", `Config file is not valid JSON: ${target}`, target),
    };
  }

  if (!isValidShape(parsed)) {
    return {
      ok: false,
      reason: "invalid-shape",
      error: new ConfigError(
        "INVALID_SHAPE",
        `Config file is missing required fields: ${target}`,
        target,
      ),
    };
  }

  return { ok: true, config: { api_key: parsed.api_key, host_url: parsed.host_url } };
}

/** Reads and validates the project-local config file (see {@link configPath}). */
export function readConfig(path?: string): ConfigReadResult {
  return parseConfigFile(configPath(path));
}

/**
 * Reads and validates the global (per-user) fallback config file (see
 * {@link globalConfigPath}). Consulted only when no project-local config is
 * found.
 */
export function readGlobalConfig(path?: string): ConfigReadResult {
  return parseConfigFile(globalConfigPath(path));
}

const SWALLOWED_CHMOD_CODES = new Set(["EPERM", "ENOSYS", "ENOTSUP"]);

/**
 * Best-effort safety net: drop a `.gitignore` (`*`) into our own `.traceroot`
 * config directory so a project-local config never accidentally commits the API
 * key. Only acts on a directory named `.traceroot` (one the CLI owns) so it can
 * never clobber an unrelated directory's tracking, and never on an existing
 * file. Never throws — it is a convenience, not a correctness requirement.
 */
function ensureGitignore(dir: string): void {
  if (basename(dir) !== ".traceroot") {
    return;
  }
  try {
    const gitignore = join(dir, ".gitignore");
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, "*\n");
    }
  } catch {
    // best-effort only
  }
}

/**
 * Atomically writes the config with restrictive (0600) permissions where the
 * platform supports it. Never embeds the token in an error.
 */
export function writeConfig(config: Config, path?: string): void {
  const target = configPath(path);
  const dir = configDir(path);
  const tmp = join(dir, `.config.${process.pid}.tmp`);
  const payload = `${JSON.stringify(config, null, 2)}\n`;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensureGitignore(dir);
    writeFileSync(tmp, payload, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch (chmodErr) {
      const code = (chmodErr as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" && code !== undefined && !SWALLOWED_CHMOD_CODES.has(code)) {
        throw chmodErr;
      }
      // Best-effort on win32 / unsupported chmod: keep the written file.
    }
    renameSync(tmp, target);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    // Message references only the path — never the token.
    throw new ConfigError("WRITE_FAILED", `Failed to write config to ${target}`, target);
  }
}
