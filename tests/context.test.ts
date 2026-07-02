import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS } from "../src/api/client.js";
import { buildContext } from "../src/context.js";
import { CliError } from "../src/output.js";

const hermetic = {
  env: {},
  readConfig: () => null,
  loadEnvFile: () => ({}),
  loadAutoEnvFile: () => ({}),
};

describe("buildContext", () => {
  it("carries the json flag through", () => {
    const ctx = buildContext({ json: true }, hermetic);
    expect(ctx.json).toBe(true);
  });

  it("defaults json to false when omitted", () => {
    const ctx = buildContext({}, hermetic);
    expect(ctx.json).toBe(false);
  });

  it("routes injected flags into auth resolution", () => {
    const ctx = buildContext({ apiKey: "X" }, hermetic);
    expect(ctx.auth.apiKey.source).toBe("flag");
    expect(ctx.auth.apiKey.value).toBe("X");
  });

  it("falls back to the auto-discovered .env at the lowest precedence", () => {
    const ctx = buildContext(
      {},
      {
        env: {},
        readConfig: () => null,
        loadEnvFile: () => ({}),
        loadAutoEnvFile: () => ({
          TRACEROOT_API_KEY: "auto-key",
          TRACEROOT_HOST_URL: "https://auto",
        }),
      },
    );
    expect(ctx.auth.apiKey).toEqual({ value: "auto-key", source: "auto-env-file" });
    expect(ctx.auth.hostUrl).toEqual({ value: "https://auto", source: "auto-env-file" });
  });

  it("defaults timeoutMs to DEFAULT_TIMEOUT_MS", () => {
    const ctx = buildContext({}, hermetic);
    expect(ctx.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("lets TRACEROOT_TIMEOUT_MS override the default", () => {
    const ctx = buildContext({}, { ...hermetic, env: { TRACEROOT_TIMEOUT_MS: "5000" } });
    expect(ctx.timeoutMs).toBe(5000);
  });

  it("lets the --timeout flag override the env", () => {
    const ctx = buildContext(
      { timeout: "1000" },
      { ...hermetic, env: { TRACEROOT_TIMEOUT_MS: "5000" } },
    );
    expect(ctx.timeoutMs).toBe(1000);
  });

  it("throws a CliError on an invalid timeout value", () => {
    expect(() => buildContext({ timeout: "nope" }, hermetic)).toThrow(CliError);
    expect(() => buildContext({ timeout: "0" }, hermetic)).toThrow(CliError);
    expect(() => buildContext({ timeout: "-5" }, hermetic)).toThrow(CliError);
  });

  it("rejects non-integer timeout forms a bare Number() would accept", () => {
    // hex, scientific, and decimal strings must not slip through as valid ms.
    expect(() => buildContext({ timeout: "0x10" }, hermetic)).toThrow(CliError);
    expect(() => buildContext({ timeout: "1e2" }, hermetic)).toThrow(CliError);
    expect(() => buildContext({ timeout: "5.5" }, hermetic)).toThrow(CliError);
  });

  it("lets the config file win over the auto-discovered .env", () => {
    const ctx = buildContext(
      {},
      {
        env: {},
        readConfig: () => ({ api_key: "cfg-key", host_url: "https://cfg" }),
        loadEnvFile: () => ({}),
        loadAutoEnvFile: () => ({ TRACEROOT_API_KEY: "auto-key" }),
      },
    );
    expect(ctx.auth.apiKey).toEqual({ value: "cfg-key", source: "config" });
  });
});
