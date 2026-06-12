import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, readConfig, writeConfig } from "../src/config/manager.js";
import { ConfigError } from "../src/config/schema.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("reads a valid config", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ api_key: "k", host_url: "https://h" }));
    const result = readConfig(p);
    expect(result).toEqual({
      ok: true,
      config: { api_key: "k", host_url: "https://h" },
    });
  });

  it("returns missing (and does not throw) when the file is absent", () => {
    const p = join(dir, "nope.json");
    expect(() => readConfig(p)).not.toThrow();
    expect(readConfig(p)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects an invalid shape when api_key is not a string", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ api_key: 123, host_url: "https://h" }));
    const result = readConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid-shape");
    if (result.reason !== "invalid-shape") throw new Error("unreachable");
    expect(result.error.code).toBe("INVALID_SHAPE");
  });

  it("rejects an invalid shape when host_url is missing", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ api_key: "k" }));
    const result = readConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid-shape");
    if (result.reason !== "invalid-shape") throw new Error("unreachable");
    expect(result.error.code).toBe("INVALID_SHAPE");
  });

  it("rejects invalid JSON without leaking the raw file bytes", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, '{ api_key: "tr_secret_LEAK", oops');
    const result = readConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid-json");
    if (result.reason !== "invalid-json") throw new Error("unreachable");
    expect(result.error.code).toBe("INVALID_JSON");
    expect(result.error.message).not.toContain("tr_secret_LEAK");
  });
});

describe("writeConfig", () => {
  it("writes the expected shape, pretty-printed, creating parent dirs", () => {
    const p = join(dir, "nested", "deeper", "config.json");
    writeConfig({ api_key: "k", host_url: "https://h" }, p);
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual(["api_key", "host_url"]);
    expect(parsed).toEqual({ api_key: "k", host_url: "https://h" });
    // pretty-printed with a trailing newline
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it("applies 0600 permissions where supported", () => {
    const p = join(dir, "config.json");
    writeConfig({ api_key: "k", host_url: "https://h" }, p);
    if (process.platform !== "win32") {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } else {
      expect(statSync(p).isFile()).toBe(true);
    }
  });

  it("drops a .gitignore in a .traceroot dir so the key cannot be committed", () => {
    const p = join(dir, ".traceroot", "config.json");
    writeConfig({ api_key: "k", host_url: "https://h" }, p);
    expect(readFileSync(join(dir, ".traceroot", ".gitignore"), "utf8")).toContain("*");
  });

  it("does not create a .gitignore for a non-.traceroot config dir", () => {
    const p = join(dir, "plain", "config.json");
    writeConfig({ api_key: "k", host_url: "https://h" }, p);
    expect(existsSync(join(dir, "plain", ".gitignore"))).toBe(false);
  });

  it("does not clobber an existing .gitignore in the .traceroot dir", () => {
    const traceDir = join(dir, ".traceroot");
    writeConfig({ api_key: "k", host_url: "https://h" }, join(traceDir, "config.json"));
    // Overwrite, then write again: the existing .gitignore is preserved.
    writeFileSync(join(traceDir, ".gitignore"), "custom\n");
    writeConfig({ api_key: "k2", host_url: "https://h2" }, join(traceDir, "config.json"));
    expect(readFileSync(join(traceDir, ".gitignore"), "utf8")).toBe("custom\n");
  });

  it("never leaks the token when a write fails", () => {
    // Point the config's parent dir at an existing FILE so mkdir/write fails.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const p = join(blocker, "config.json");
    let thrown: unknown;
    try {
      writeConfig({ api_key: "tr_secret_LEAK", host_url: "https://h" }, p);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const e = thrown as ConfigError;
    expect(e.code).toBe("WRITE_FAILED");
    expect(e.message).not.toContain("tr_secret");
    expect(e.path).not.toContain("tr_secret");
  });
});

describe("configPath", () => {
  it("defaults to ./.traceroot/config.json in the working directory", () => {
    const previous = process.env.TRACEROOT_CONFIG_PATH;
    try {
      Reflect.deleteProperty(process.env, "TRACEROOT_CONFIG_PATH");
      expect(configPath()).toBe(join(process.cwd(), ".traceroot", "config.json"));
    } finally {
      if (previous !== undefined) {
        process.env.TRACEROOT_CONFIG_PATH = previous;
      }
    }
  });

  it("honors the TRACEROOT_CONFIG_PATH environment variable", () => {
    const previous = process.env.TRACEROOT_CONFIG_PATH;
    try {
      process.env.TRACEROOT_CONFIG_PATH = join(dir, "from-env.json");
      expect(configPath()).toBe(join(dir, "from-env.json"));
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "TRACEROOT_CONFIG_PATH");
      } else {
        process.env.TRACEROOT_CONFIG_PATH = previous;
      }
    }
  });

  it("prefers an explicit path argument over the environment", () => {
    const previous = process.env.TRACEROOT_CONFIG_PATH;
    try {
      process.env.TRACEROOT_CONFIG_PATH = join(dir, "from-env.json");
      expect(configPath(join(dir, "explicit.json"))).toBe(join(dir, "explicit.json"));
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "TRACEROOT_CONFIG_PATH");
      } else {
        process.env.TRACEROOT_CONFIG_PATH = previous;
      }
    }
  });
});
