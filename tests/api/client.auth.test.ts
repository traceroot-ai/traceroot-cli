import { describe, expect, it } from "vitest";
import { type ApiClientOptions, createApiClient } from "../../src/api/client.js";
import { CliError, ExitCode } from "../../src/output.js";
import { getVersion } from "../../src/version.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";

const API_KEY = "tr_secret_LEAK";

function clientWith(
  responder: Parameters<typeof createFakeFetch>[0],
  auth: ApiClientOptions["auth"] = { kind: "api-key", key: API_KEY },
) {
  const fake = createFakeFetch(responder);
  const client = createApiClient({ host: "https://h", auth, fetchImpl: fake.fetchImpl });
  return { client, calls: fake.calls };
}

describe("createApiClient auth modes", () => {
  it("api-key auth sends the key as the bearer", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ ok: true }));
    await client.whoami();
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("token-provider auth asks the provider for a bearer on every request", async () => {
    let minted = 0;
    const { client, calls } = clientWith(() => jsonResponse({ data: [] }), {
      kind: "token-provider",
      getAccessToken: async () => {
        minted += 1;
        return `jwt-${minted}`;
      },
      invalidate: () => {},
    });
    await client.listWorkspaces();
    await client.listWorkspaces();
    expect(minted).toBe(2);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer jwt-1");
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer jwt-2");
  });

  it("propagates a provider failure without touching the network", async () => {
    const failure = new CliError(
      "session expired or revoked — run `traceroot login`",
      ExitCode.auth,
    );
    const { client, calls } = clientWith(() => jsonResponse({}), {
      kind: "token-provider",
      getAccessToken: async () => {
        throw failure;
      },
      invalidate: () => {},
    });
    await expect(client.whoami()).rejects.toBe(failure);
    expect(calls).toHaveLength(0);
  });

  it("re-mints and retries once on a 401, then succeeds", async () => {
    let minted = 0;
    let calls = 0;
    let staleRes: Response | undefined;
    const fake = createFakeFetch(() => {
      calls += 1;
      // First request 401s (stale token); the retry with a fresh token succeeds.
      if (calls === 1) {
        staleRes = jsonResponse({ detail: "expired" }, 401);
        return staleRes;
      }
      return jsonResponse({ ok: true });
    });
    let invalidated = 0;
    const client = createApiClient({
      host: "https://h",
      fetchImpl: fake.fetchImpl,
      auth: {
        kind: "token-provider",
        getAccessToken: async () => {
          minted += 1;
          return `jwt-${minted}`;
        },
        invalidate: () => {
          invalidated += 1;
        },
      },
    });
    await client.whoami();
    expect(calls).toBe(2);
    expect(invalidated).toBe(1);
    expect(minted).toBe(2); // fresh token minted for the retry
    expect(new Headers(fake.calls[1]?.init.headers).get("authorization")).toBe("Bearer jwt-2");
    // The abandoned 401 body was cancelled, not left holding its stream open.
    expect(staleRes?.bodyUsed).toBe(true);
  });

  it("does not retry a second time — a persistent 401 surfaces", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ detail: "nope" }, 401), {
      kind: "token-provider",
      getAccessToken: async () => "jwt",
      invalidate: () => {},
    });
    await expect(client.whoami()).rejects.toThrow();
    expect(calls).toHaveLength(2); // original + one retry, no more
  });

  it("does not retry a 401 in api-key mode", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ detail: "nope" }, 401));
    await expect(client.whoami()).rejects.toThrow();
    expect(calls).toHaveLength(1); // no invalidate/retry path for a static key
  });

  it("sends a traceroot-cli user-agent on every request", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ ok: true }));
    await client.whoami();
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("user-agent")).toBe(`traceroot-cli/${getVersion()}`);
  });

  it("redacts the provider-minted bearer from network error messages", async () => {
    const { client } = clientWith(
      () => {
        throw new Error("boom jwt-secret boom");
      },
      { kind: "token-provider", getAccessToken: async () => "jwt-secret", invalidate: () => {} },
    );
    await expect(client.whoami()).rejects.toThrow(/<redacted>/);
    await expect(client.whoami()).rejects.not.toThrow(/jwt-secret/);
  });
});

describe("createApiClient account-scope discovery", () => {
  it("lists workspaces", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ data: [] }));
    await client.listWorkspaces();
    expect(calls[0]?.url).toBe("https://h/api/v1/public/workspaces");
  });

  it("lists projects without a workspace filter", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ data: [] }));
    await client.listProjects();
    expect(calls[0]?.url).toBe("https://h/api/v1/public/projects");
  });

  it("lists projects filtered to one workspace", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ data: [] }));
    await client.listProjects({ workspaceId: "ws 1" });
    expect(calls[0]?.url).toBe("https://h/api/v1/public/projects?workspace_id=ws+1");
  });
});
