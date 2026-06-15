/**
 * Shape of the persisted CLI configuration (~/.traceroot/config.json).
 * Both fields are required.
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
