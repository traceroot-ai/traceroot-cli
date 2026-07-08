import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { contextFromCommand, requireApiClient } from "../../src/commands/shared.js";
import type { Context } from "../../src/context.js";
import { CliError } from "../../src/output.js";

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
