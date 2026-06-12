import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Config, ConfigError, type ConfigReadResult } from "./schema.js";

/**
 * Resolves the config file path. Precedence: explicit `path` argument, then a
 * non-empty `TRACEROOT_CONFIG_PATH`, then a project-local
 * `./.traceroot/config.json` in the current working directory. The config lives
 * in the project directory (mirroring the `.env` the CLI already auto-discovers
 * there), not the user's home folder.
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

function isValidShape(value: unknown): value is Config {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.api_key === "string" && typeof obj.host_url === "string";
}

/**
 * Reads and validates the config file. Never throws for the four documented
 * cases (valid, missing, invalid JSON, invalid shape); any other fs error
 * (EACCES, EISDIR, …) is rethrown as a genuine fault.
 */
export function readConfig(path?: string): ConfigReadResult {
  const target = configPath(path);
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
