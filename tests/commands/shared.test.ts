import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFromCommand, requireApiClient } from "../../src/commands/shared.js";
import { configPath, globalConfigPath } from "../../src/config/manager.js";
import type { Context } from "../../src/context.js";
import { CliError } from "../../src/output.js";

// Isolate the project-local and global config paths from the real filesystem
// (real cwd `.traceroot/config.json` and real `~/.config/traceroot/config.json`)
// for any test that exercises the real resolution chain (`contextFromCommand`).
let isolationDir: string;
let prevConfigPath: string | undefined;
let prevXdgConfigHome: string | undefined;

beforeEach(() => {
  isolationDir = mkdtempSync(join(tmpdir(), "tr-shared-"));
  prevConfigPath = process.env.TRACEROOT_CONFIG_PATH;
  prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.TRACEROOT_CONFIG_PATH = join(isolationDir, "project", "config.json");
  process.env.XDG_CONFIG_HOME = join(isolationDir, "xdg");
});

afterEach(() => {
  if (prevConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "TRACEROOT_CONFIG_PATH");
  } else {
    process.env.TRACEROOT_CONFIG_PATH = prevConfigPath;
  }
  if (prevXdgConfigHome === undefined) {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
  } else {
    process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
  }
  rmSync(isolationDir, { recursive: true, force: true });
});

function makeContext(
  apiKey: string | undefined,
  host: string | undefined,
  timeoutMs = 30_000,
): Context {
  return {
    auth: {
      apiKey: { value: apiKey, source: apiKey === undefined ? "none" : "flag" },
      hostUrl: { value: host, source: host === undefined ? "none" : "flag" },
    },
    json: false,
    timeoutMs,
  };
}

describe("requireApiClient", () => {
  it("throws a CliError when the api key is undefined", () => {
    const ctx = makeContext(undefined, "https://api.example.com");
    expect(() => requireApiClient(ctx)).toThrow(CliError);
  });

  it("throws a CliError when the host is undefined", () => {
    const ctx = makeContext("tr_present", undefined);
    expect(() => requireApiClient(ctx)).toThrow(CliError);
  });

  it("returns a client exposing the api methods when both are present", () => {
    const ctx = makeContext("tr_present", "https://api.example.com");
    const client = requireApiClient(ctx);
    expect(typeof client.whoami).toBe("function");
    expect(typeof client.listTraces).toBe("function");
    expect(typeof client.getTrace).toBe("function");
    expect(typeof client.exportTrace).toBe("function");
  });

  it("does not perform network activity on construction", () => {
    const ctx = makeContext("tr_present", "https://api.example.com");
    expect(() => requireApiClient(ctx)).not.toThrow();
  });

  it("builds a client that applies the context timeout to each request", async () => {
    const ctx = makeContext("tr_present", "https://h", 5000);
    let captured: RequestInit | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await requireApiClient(ctx).whoami();
    } finally {
      globalThis.fetch = original;
    }
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never includes the api key in the thrown error message", () => {
    const ctx = makeContext("tr_secret_LEAK", undefined);
    try {
      requireApiClient(ctx);
      throw new Error("expected requireApiClient to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).not.toContain("tr_secret_LEAK");
    }
  });

  it("names both checked config paths in the missing-api-key error", () => {
    const ctx = makeContext(undefined, "https://api.example.com");
    try {
      requireApiClient(ctx);
      throw new Error("expected requireApiClient to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const message = (err as CliError).message;
      expect(message).toContain(configPath());
      expect(message).toContain(globalConfigPath());
    }
  });

  it("names both checked config paths in the missing-host error", () => {
    const ctx = makeContext("tr_present", undefined);
    try {
      requireApiClient(ctx);
      throw new Error("expected requireApiClient to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const message = (err as CliError).message;
      expect(message).toContain(configPath());
      expect(message).toContain(globalConfigPath());
    }
  });
});

describe("contextFromCommand", () => {
  it("builds a Context driven by the merged command options", () => {
    let captured: Context | undefined;
    const program = new Command();
    program.option("--api-key <key>").option("--host <url>").option("--json");
    program.command("sub").action((_opts, command: Command) => {
      captured = contextFromCommand(command);
    });

    program.parse(["--api-key", "K", "--host", "https://h", "sub"], { from: "user" });

    expect(captured).toBeDefined();
    expect(captured?.auth.apiKey.value).toBe("K");
    expect(captured?.auth.hostUrl.value).toBe("https://h");
  });
});
