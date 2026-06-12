import { readFileSync } from "node:fs";

/**
 * Thrown when an explicitly requested env file does not exist on disk.
 * Carries only the file path — never a secret value.
 */
export class EnvFileNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`env file not found: ${path}`);
    this.name = "EnvFileNotFoundError";
  }
}

/**
 * Parses the textual content of a .env file into a key/value map.
 *
 * Pure (no I/O). Rules, applied per line:
 * - split on `\n`, strip a trailing `\r`, then trim the line
 * - skip empty lines and lines starting with `#`
 * - skip lines without an `=`; the key is everything before the FIRST `=`
 * - `export KEY=...` is supported; the `export ` prefix is dropped
 * - if the resulting key is empty, skip the line
 * - the value is everything after the first `=`, trimmed
 * - if the value is at least 2 chars and wrapped in matching `"` or `'`,
 *   the outer quotes are stripped (inner content kept verbatim)
 * - on duplicate keys, the last occurrence wins
 */
export function parseEnvFile(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    let key = line.slice(0, eq).trim();
    const exportMatch = key.match(/^export\s+(.+)$/);
    if (exportMatch?.[1] !== undefined) {
      key = exportMatch[1].trim();
    }
    if (key === "") {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if (first === last && (first === '"' || first === "'")) {
        value = value.slice(1, -1);
      }
    }
    map[key] = value;
  }
  return map;
}

/**
 * Loads and parses an env file from disk.
 *
 * Used by production wiring (not by the pure parser path). On ENOENT throws
 * {@link EnvFileNotFoundError}; any other fs error propagates unchanged.
 */
export function loadEnvFileFromDisk(path: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EnvFileNotFoundError(path);
    }
    throw err;
  }
  return parseEnvFile(content);
}

/**
 * Loads and parses an env file from disk, returning an empty map when the file
 * does not exist instead of throwing. Used for the auto-discovered working
 * directory `.env` (lowest-precedence, optional source) where "no file" is the
 * normal case, not an error. Any non-ENOENT fs error still propagates.
 */
export function loadOptionalEnvFileFromDisk(path: string): Record<string, string> {
  try {
    return loadEnvFileFromDisk(path);
  } catch (err) {
    if (err instanceof EnvFileNotFoundError) {
      return {};
    }
    throw err;
  }
}
