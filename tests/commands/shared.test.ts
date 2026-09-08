import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  contextFromCommand,
  requireApiClient,
  requireAuthedClient,
} from "../../src/commands/shared.js";
import type { ResolvedCredential } from "../../src/config/resolve.js";
import type { Context } from "../../src/context.js";
import { CliError } from "../../src/output.js";

function makeContext(
  credential: ResolvedCredential,
  host: string | undefined,
  timeoutMs = 30_000,
  authHost?: string,
): Context {
  return {
    auth: {
      credential,
      hostUrl: { value: host, source: host === undefined ? "none" : "flag" },
      authHost:
        authHost === undefined
          ? { value: host, source: "default" }
          : { value: authHost, source: "flag" },
      projectId: { value: undefined, source: "none" },
    },
    json: false,
    timeoutMs,
  };
}

function keyCredential(value: string | undefined): ResolvedCredential {
  return value === undefined
    ? { kind: "none", value: undefined, source: "none" }
    : { kind: "api-key", value, source: "flag" };
}

describe("requireApiClient", () => {
  it("throws a CliError when no credential resolves", () => {
    const ctx = makeContext(keyCredential(undefined), "https://api.example.com");
    expect(() => requireApiClient(ctx)).toThrow(CliError);
  });

  it("throws a CliError when the host is undefined", () => {
    const ctx = makeContext(keyCredential("tr_present"), undefined);
    expect(() => requireApiClient(ctx)).toThrow(CliError);
  });

  it("returns a client exposing the api methods when both are present", () => {
    const ctx = makeContext(keyCredential("tr_present"), "https://api.example.com");
    const client = requireApiClient(ctx);
    expect(typeof client.whoami).toBe("function");
    expect(typeof client.listWorkspaces).toBe("function");
    expect(typeof client.listProjects).toBe("function");
  });

  it("does not perform network activity on construction", () => {
    const ctx = makeContext(keyCredential("tr_present"), "https://api.example.com");
    expect(() => requireApiClient(ctx)).not.toThrow();
  });

  it("builds a client that applies the context timeout to each request", async () => {
    const ctx = makeContext(keyCredential("tr_present"), "https://h", 5000);
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

  it("never includes the credential in the thrown error message", () => {
    const ctx = makeContext(keyCredential("tr_secret_LEAK"), undefined);
    try {
      requireApiClient(ctx);
      throw new Error("expected requireApiClient to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).not.toContain("tr_secret_LEAK");
    }
  });
});

describe("requireAuthedClient (session)", () => {
  function sessionContext(): Context {
    // A SPLIT setup (auth host ≠ API host, as in dev) so the mint-routing
    // assertions can tell the two hosts apart.
    return makeContext(
      { kind: "session", value: "sess_secret_LEAK", source: "credentials-file" },
      "https://api.example.com",
      30_000,
      "https://auth.example.com",
    );
  }

  it("exposes the session kind and a token accessor", () => {
    const authed = requireAuthedClient(sessionContext());
    expect(authed.kind).toBe("session");
    expect(typeof authed.getAccessToken).toBe("function");
  });

  it("mints via the auth host and sends the JWT (not the session token) on reads", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("authorization") });
      if (String(url).endsWith("/api/cli/token")) {
        return new Response(
          JSON.stringify({ accessToken: "jwt-1", tokenType: "Bearer", expiresIn: 600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await requireAuthedClient(sessionContext()).client.listWorkspaces();
    } finally {
      globalThis.fetch = original;
    }

    // The mint goes to the AUTH host; the read goes to the API host.
    expect(calls[0]?.url).toBe("https://auth.example.com/api/cli/token");
    expect(calls[0]?.auth).toBe("Bearer sess_secret_LEAK");
    expect(calls[1]?.url).toBe("https://api.example.com/api/v1/public/workspaces");
    expect(calls[1]?.auth).toBe("Bearer jwt-1");
  });

  it("api-key mode exposes no token accessor", () => {
    const authed = requireAuthedClient(
      makeContext(keyCredential("tr_present"), "https://api.example.com"),
    );
    expect(authed.kind).toBe("api-key");
    expect(authed.getAccessToken).toBeUndefined();
  });
});

describe("contextFromCommand", () => {
  it("builds a Context driven by the merged command options", () => {
    let captured: Context | undefined;
    const program = new Command();
    program
      .option("--api-key <key>")
      .option("--host <url>")
      .option("--project <id>")
      .option("--json");
    program.command("sub").action((_opts, command: Command) => {
      captured = contextFromCommand(command);
    });

    program.parse(["--api-key", "K", "--host", "https://h", "--project", "p-1", "sub"], {
      from: "user",
    });

    expect(captured).toBeDefined();
    expect(captured?.auth.credential).toEqual({ kind: "api-key", value: "K", source: "flag" });
    expect(captured?.auth.hostUrl.value).toBe("https://h");
    expect(captured?.auth.projectId).toEqual({ value: "p-1", source: "flag" });
  });
});
