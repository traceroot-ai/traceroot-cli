/**
 * Shape of the persisted CLI configuration. `traceroot login` writes the
 * project-local `./.traceroot/config.json` (relative to the current working
 * directory); when no project-local config is found, the CLI also checks a
 * global fallback at `~/.config/traceroot/config.json` (or
 * `$XDG_CONFIG_HOME/traceroot/config.json` when set), which `login` never
 * writes to. Both fields are required.
 */
export interface Config {
  api_key: string;
  host_url: string;
}

/**
 * Result of attempting to read the config file. Never thrown — each of the
 * documented failure modes is represented as a discriminated variant.
 */
export type ConfigReadResult =
  | { ok: true; config: Config }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid-json"; error: ConfigError }
  | { ok: false; reason: "invalid-shape"; error: ConfigError };

/**
 * Error carrying a machine-readable code and the offending file path.
 * The `path` and `message` only ever reference a file path — never a secret.
 */
export class ConfigError extends Error {
  readonly code: "INVALID_JSON" | "INVALID_SHAPE" | "WRITE_FAILED";
  readonly path: string;

  constructor(code: ConfigError["code"], message: string, path: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.path = path;
  }
}
