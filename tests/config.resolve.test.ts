import { describe, expect, it, vi } from "vitest";
import { EnvFileNotFoundError } from "../src/config/envFile.js";
import { resolveAuth } from "../src/config/resolve.js";
import type { Config } from "../src/config/schema.js";

const config = (over: Partial<Config>): (() => Config) => {
  return () => ({ api_key: "cfg-key", host_url: "https://cfg", ...over });
};

const globalConfig = (over: Partial<Config>): (() => Config) => {
  return () => ({ api_key: "global-cfg-key", host_url: "https://global-cfg", ...over });
};

describe("resolveAuth api_key normalization", () => {
  it("strips a pasted TRACEROOT_API_KEY= prefix from a flag", () => {
    const result = resolveAuth({ flags: { apiKey: "TRACEROOT_API_KEY=tr_abc123" } });
    expect(result.apiKey).toEqual({ value: "tr_abc123", source: "flag" });
  });

  it("strips an `export ` prefix and surrounding quotes", () => {
    const result = resolveAuth({ flags: { apiKey: 'export TRACEROOT_API_KEY="tr_abc123"' } });
    expect(result.apiKey.value).toBe("tr_abc123");
  });

  it("leaves a bare key untouched", () => {
    const result = resolveAuth({ flags: { apiKey: "tr_abc123" } });
    expect(result.apiKey.value).toBe("tr_abc123");
  });
});

describe("resolveAuth precedence (api_key)", () => {
  it("flag beats env-file beats env beats config", () => {
    const result = resolveAuth({
      flags: { apiKey: "flag-key", envFile: "/x" },
      env: { TRACEROOT_API_KEY: "env-key" },
      readConfig: config({}),
      loadEnvFile: () => ({ TRACEROOT_API_KEY: "file-key" }),
    });
    expect(result.apiKey).toEqual({ value: "flag-key", source: "flag" });
  });

  it("env-file beats env beats config", () => {
    const result = resolveAuth({
      flags: { envFile: "/x" },
      env: { TRACEROOT_API_KEY: "env-key" },
      readConfig: config({}),
      loadEnvFile: () => ({ TRACEROOT_API_KEY: "file-key" }),
    });
    expect(result.apiKey).toEqual({ value: "file-key", source: "env-file" });
  });

  it("env beats config", () => {
    const result = resolveAuth({
      env: { TRACEROOT_API_KEY: "env-key" },
      readConfig: config({}),
    });
    expect(result.apiKey).toEqual({ value: "env-key", source: "env" });
  });

  it("falls back to config", () => {
    const result = resolveAuth({ readConfig: config({}) });
    expect(result.apiKey).toEqual({ value: "cfg-key", source: "config" });
  });

  it("config beats the auto-discovered .env", () => {
    const result = resolveAuth({
      readConfig: config({}),
      autoEnvFile: { TRACEROOT_API_KEY: "auto-key" },
    });
    expect(result.apiKey).toEqual({ value: "cfg-key", source: "config" });
  });

  it("falls back to the auto-discovered .env when nothing else is set", () => {
    const result = resolveAuth({
      readConfig: () => null,
      autoEnvFile: { TRACEROOT_API_KEY: "auto-key", TRACEROOT_HOST_URL: "https://auto" },
    });
    expect(result.apiKey).toEqual({ value: "auto-key", source: "auto-env-file" });
    expect(result.hostUrl).toEqual({ value: "https://auto", source: "auto-env-file" });
  });
});

describe("resolveAuth precedence (global config fallback)", () => {
  it("project config beats global config", () => {
    const result = resolveAuth({
      readConfig: config({}),
      readGlobalConfig: globalConfig({}),
    });
    expect(result.apiKey).toEqual({ value: "cfg-key", source: "config" });
    expect(result.hostUrl).toEqual({ value: "https://cfg", source: "config" });
  });

  it("global config beats the auto-discovered .env", () => {
    const result = resolveAuth({
      readConfig: () => null,
      readGlobalConfig: globalConfig({}),
      autoEnvFile: { TRACEROOT_API_KEY: "auto-key", TRACEROOT_HOST_URL: "https://auto" },
    });
    expect(result.apiKey).toEqual({ value: "global-cfg-key", source: "global-config" });
    expect(result.hostUrl).toEqual({ value: "https://global-cfg", source: "global-config" });
  });

  it("falls back to global config when the project config is absent", () => {
    const result = resolveAuth({
      readConfig: () => null,
      readGlobalConfig: globalConfig({}),
    });
    expect(result.apiKey).toEqual({ value: "global-cfg-key", source: "global-config" });
    expect(result.hostUrl).toEqual({ value: "https://global-cfg", source: "global-config" });
  });

  it("env beats global config", () => {
    const result = resolveAuth({
      env: { TRACEROOT_API_KEY: "env-key" },
      readConfig: () => null,
      readGlobalConfig: globalConfig({}),
    });
    expect(result.apiKey).toEqual({ value: "env-key", source: "env" });
  });

  it("defaults readGlobalConfig to a no-op returning null", () => {
    const result = resolveAuth({ readConfig: () => null });
    expect(result.apiKey).toEqual({ value: undefined, source: "none" });
  });

  it("resolves each field independently across project and global config", () => {
    const result = resolveAuth({
      readConfig: (): Config => ({ api_key: "cfg-key", host_url: "" }),
      readGlobalConfig: globalConfig({}),
    });
    expect(result.apiKey).toEqual({ value: "cfg-key", source: "config" });
    expect(result.hostUrl).toEqual({ value: "https://global-cfg", source: "global-config" });
  });
});

describe("resolveAuth lazy global config read", () => {
  const throwingGlobal = (): Config => {
    throw new Error("EACCES: permission denied");
  };

  it("resolves flag credentials even when the global config is unreadable", () => {
    const result = resolveAuth({
      flags: { apiKey: "flag-key", host: "https://flag" },
      readGlobalConfig: throwingGlobal,
    });
    expect(result.apiKey).toEqual({ value: "flag-key", source: "flag" });
    expect(result.hostUrl).toEqual({ value: "https://flag", source: "flag" });
  });

  it("resolves env credentials even when the global config is unreadable", () => {
    const result = resolveAuth({
      env: { TRACEROOT_API_KEY: "env-key", TRACEROOT_HOST_URL: "https://env" },
      readGlobalConfig: throwingGlobal,
    });
    expect(result.apiKey).toEqual({ value: "env-key", source: "env" });
    expect(result.hostUrl).toEqual({ value: "https://env", source: "env" });
  });

  it("resolves project-config credentials even when the global config is unreadable", () => {
    const result = resolveAuth({
      readConfig: config({}),
      readGlobalConfig: throwingGlobal,
    });
    expect(result.apiKey).toEqual({ value: "cfg-key", source: "config" });
    expect(result.hostUrl).toEqual({ value: "https://cfg", source: "config" });
  });

  it("never reads the global config when the project config supplies both fields", () => {
    const readGlobalConfig = vi.fn(globalConfig({}));
    resolveAuth({ readConfig: config({}), readGlobalConfig });
    expect(readGlobalConfig).not.toHaveBeenCalled();
  });

  it("reads the global config at most once when both fields fall through to it", () => {
    const readGlobalConfig = vi.fn(globalConfig({}));
    const result = resolveAuth({ readConfig: () => null, readGlobalConfig });
    expect(result.apiKey).toEqual({ value: "global-cfg-key", source: "global-config" });
    expect(result.hostUrl).toEqual({ value: "https://global-cfg", source: "global-config" });
    expect(readGlobalConfig).toHaveBeenCalledTimes(1);
  });

  it("reads the global config when only one field falls through to it", () => {
    const readGlobalConfig = vi.fn(globalConfig({}));
    const result = resolveAuth({
      readConfig: (): Config => ({ api_key: "cfg-key", host_url: "" }),
      readGlobalConfig,
    });
    expect(result.apiKey).toEqual({ value: "cfg-key", source: "config" });
    expect(result.hostUrl).toEqual({ value: "https://global-cfg", source: "global-config" });
    expect(readGlobalConfig).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAuth when nothing is set", () => {
  it("reports none for both fields", () => {
    const result = resolveAuth();
    expect(result.apiKey).toEqual({ value: undefined, source: "none" });
    expect(result.hostUrl).toEqual({ value: undefined, source: "none" });
  });
});

describe("resolveAuth per-field independence", () => {
  it("api_key from flag while host_url from config", () => {
    const result = resolveAuth({
      flags: { apiKey: "flag-key" },
      readConfig: config({}),
    });
    expect(result.apiKey.source).toBe("flag");
    expect(result.hostUrl).toEqual({ value: "https://cfg", source: "config" });
  });

  it("host_url from env-file while api_key from env", () => {
    const result = resolveAuth({
      flags: { envFile: "/x" },
      env: { TRACEROOT_API_KEY: "env-key" },
      readConfig: () => null,
      loadEnvFile: () => ({ TRACEROOT_HOST_URL: "https://file-host" }),
    });
    expect(result.apiKey).toEqual({ value: "env-key", source: "env" });
    expect(result.hostUrl).toEqual({ value: "https://file-host", source: "env-file" });
  });
});

describe("resolveAuth host_url normalization", () => {
  it("strips trailing slashes but preserves the protocol //", () => {
    const result = resolveAuth({
      flags: { host: "https://api.example.com///" },
    });
    expect(result.hostUrl).toEqual({ value: "https://api.example.com", source: "flag" });
  });

  it("falls through when normalization empties a slashes-only host", () => {
    const result = resolveAuth({
      flags: { host: "///" },
      readConfig: config({ host_url: "https://cfg" }),
    });
    expect(result.hostUrl).toEqual({ value: "https://cfg", source: "config" });
  });

  it("reports none when the only host candidate normalizes to empty", () => {
    const result = resolveAuth({ flags: { host: "/" } });
    expect(result.hostUrl).toEqual({ value: undefined, source: "none" });
  });
});

describe("resolveAuth present() guard", () => {
  it("treats an empty/whitespace flag as absent and falls through to config", () => {
    const result = resolveAuth({
      flags: { apiKey: "   " },
      readConfig: config({}),
    });
    expect(result.apiKey).toEqual({ value: "cfg-key", source: "config" });
  });
});

describe("resolveAuth env-file loading", () => {
  it("only calls loadEnvFile when --env-file is given", () => {
    const loadEnvFile = vi.fn(() => ({}));
    resolveAuth({ loadEnvFile });
    expect(loadEnvFile).not.toHaveBeenCalled();
  });

  it("does not throw when --env-file is omitted", () => {
    expect(() => resolveAuth({})).not.toThrow();
  });

  it("propagates EnvFileNotFoundError from a missing --env-file", () => {
    expect(() =>
      resolveAuth({
        flags: { envFile: "/missing" },
        loadEnvFile: () => {
          throw new EnvFileNotFoundError("/missing");
        },
      }),
    ).toThrow(EnvFileNotFoundError);
  });

  it("never includes a token in EnvFileNotFoundError.message", () => {
    const err = new EnvFileNotFoundError("/some/path");
    expect(err.message).not.toContain("tr_secret");
  });
});
