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
    const { client, calls } = clientWith(() => jsonResponse({ traces: [] }), {
      kind: "token-provider",
      getAccessToken: async () => {
        minted += 1;
        return `jwt-${minted}`;
      },
    });
    await client.listTraces();
    await client.listTraces();
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
    });
    await expect(client.whoami()).rejects.toBe(failure);
    expect(calls).toHaveLength(0);
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
      { kind: "token-provider", getAccessToken: async () => "jwt-secret" },
    );
    await expect(client.whoami()).rejects.toThrow(/<redacted>/);
    await expect(client.whoami()).rejects.not.toThrow(/jwt-secret/);
  });
});

describe("createApiClient new endpoints and params", () => {
  it("sends project_id on project-scoped reads when provided", async () => {
    const { client, calls } = clientWith(() => jsonResponse({}));
    await client.listTraces({ projectId: "p-1" });
    await client.getTrace("t-1", { projectId: "p-1" });
    await client.exportTrace("t-1", { projectId: "p-1" });
    await client.listDetectors({ projectId: "p-1" });
    await client.listFindings({ projectId: "p-1" });
    await client.getFinding("f-1", { projectId: "p-1" });
    await client.getFindingByTrace("t-1", { projectId: "p-1" });
    await client.findFindingByTrace("t-1", { projectId: "p-1" });
    for (const call of calls) {
      expect(new URL(call.url).searchParams.get("project_id")).toBe("p-1");
    }
  });

  it("omits project_id when not provided", async () => {
    const { client, calls } = clientWith(() => jsonResponse({}));
    await client.listTraces();
    await client.getFinding("f-1");
    for (const call of calls) {
      expect(new URL(call.url).searchParams.has("project_id")).toBe(false);
    }
  });

  it("serializes the new trace list filters", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ traces: [] }));
    await client.listTraces({
      name: "checkout",
      userId: "u-9",
      searchQuery: "abc",
      filters: '[{"field":"trace_id","op":"eq","value":"t"}]',
      includeEvaluations: true,
    });
    const url = new URL(calls[0]?.url as string);
    expect(url.searchParams.get("name")).toBe("checkout");
    expect(url.searchParams.get("user_id")).toBe("u-9");
    expect(url.searchParams.get("search_query")).toBe("abc");
    expect(url.searchParams.get("filters")).toBe('[{"field":"trace_id","op":"eq","value":"t"}]');
    expect(url.searchParams.get("include_evaluations")).toBe("true");
  });

  it("lists workspaces", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ workspaces: [] }));
    await client.listWorkspaces();
    expect(calls[0]?.url).toBe("https://h/api/v1/public/workspaces");
  });

  it("lists projects with an optional workspace filter", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ projects: [] }));
    await client.listProjects();
    expect(calls[0]?.url).toBe("https://h/api/v1/public/projects");
    await client.listProjects({ workspaceId: "w-1" });
    expect(new URL(calls[1]?.url as string).searchParams.get("workspace_id")).toBe("w-1");
  });

  it("lists sessions with search and range params", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ sessions: [] }));
    await client.listSessions({
      limit: 5,
      searchQuery: "sess",
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
      projectId: "p-1",
    });
    const url = new URL(calls[0]?.url as string);
    expect(url.pathname).toBe("/api/v1/public/sessions");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("search_query")).toBe("sess");
    expect(url.searchParams.get("start_after")).toBe("2024-01-01T00:00:00.000Z");
    expect(url.searchParams.get("end_before")).toBe("2024-02-01T00:00:00.000Z");
    expect(url.searchParams.get("project_id")).toBe("p-1");
  });

  it("gets a session by url-encoded id", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ session: {} }));
    await client.getSession("a/b c", { projectId: "p-1" });
    expect(calls[0]?.url).toContain("/api/v1/public/sessions/a%2Fb%20c");
    expect(new URL(calls[0]?.url as string).searchParams.get("project_id")).toBe("p-1");
  });

  it("appends a projects-list hint to the missing-project_id 400", async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        {
          detail:
            "project_id query parameter is required for user credentials; call list_projects to find one.",
        },
        400,
      ),
    );
    const err = await client.listTraces().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain("project_id query parameter is required");
    expect((err as CliError).message).toContain("traceroot projects list");
    expect((err as CliError).message).toContain("--project");
  });

  it("fetches trace filter values for a field", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ values: [] }));
    await client.traceFilterValues("span name", {
      startAfter: "2024-01-01T00:00:00.000Z",
      projectId: "p-1",
    });
    const url = new URL(calls[0]?.url as string);
    expect(url.pathname).toBe("/api/v1/public/traces/filter-values/span%20name");
    expect(url.searchParams.get("start_after")).toBe("2024-01-01T00:00:00.000Z");
    expect(url.searchParams.get("project_id")).toBe("p-1");
  });
});
