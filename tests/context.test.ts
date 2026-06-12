import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context.js";

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
