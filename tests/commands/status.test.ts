import { describe, expect, it } from "vitest";
import type { ApiClient, Whoami, WorkspaceList } from "../../src/api/client.js";
import { runStatus } from "../../src/commands/status.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import type { Context } from "../../src/context.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

const FULL_TOKEN = "tr_secret_LEAK";
const SESSION = "sess_secret_LEAK";

function jwtWith(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function makeWhoami(overrides: Partial<Whoami> = {}): Whoami {
  return {
    host: "https://api.example.com",
    project_id: "proj_123",
    project_name: "My Project",
    workspace_id: "ws_456",
    workspace_name: "My Workspace",
    key_name: "ci-key",
    key_hint: "tr_***1234",
    ui_base_url: "https://app.example.com",
    ...overrides,
  };
}

function keyAuth(): ResolvedAuth {
  return {
    credential: { kind: "api-key", value: FULL_TOKEN, source: "config" },
    hostUrl: { value: "https://api.example.com", source: "config" },
    authHost: { value: "https://api.example.com", source: "default" },
    projectId: { value: undefined, source: "none" },
  };
}

function sessionAuth(): ResolvedAuth {
  return {
    credential: { kind: "session", value: SESSION, source: "credentials-file" },
    hostUrl: { value: "https://api.example.com", source: "default" },
    authHost: { value: "https://ui.example.com", source: "credentials-file" },
    projectId: { value: "proj_123", source: "env" },
  };
}

function makeContext(auth: ResolvedAuth, json: boolean): Context {
  return { auth, json, timeoutMs: 30_000 };
}

interface FakeClientHooks {
  whoami?: () => Promise<Whoami>;
  listWorkspaces?: () => Promise<WorkspaceList>;
}

function fakeClient(hooks: FakeClientHooks): ApiClient {
  const unused = () => Promise.reject(new Error("not used"));
  return {
    whoami: hooks.whoami ?? unused,
    listWorkspaces: hooks.listWorkspaces ?? unused,
    listTraces: unused,
    getTrace: unused,
    exportTrace: unused,
    traceFilterValues: unused,
    listDetectors: unused,
    listFindings: unused,
    getFinding: unused,
    getFindingByTrace: unused,
    findFindingByTrace: unused,
    listProjects: unused,
    listSessions: unused,
    getSession: unused,
  } as unknown as ApiClient;
}

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

describe("runStatus with an API key (human)", () => {
  it("writes identity (project/workspace/key_hint/host) to stdout", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami({ key_hint: "tr_***1234" });
    await runStatus({
      ctx: makeContext(keyAuth(), false),
      client: fakeClient({ whoami: () => Promise.resolve(who) }),
      writers,
    });

    expect(out.data).toContain("My Project");
    expect(out.data).toContain("My Workspace");
    expect(out.data).toContain("tr_***1234");
    expect(out.data).toContain("https://api.example.com");
    expect(out.data).toContain("https://app.example.com");
  });

  it("never prints the full api token", async () => {
    const { writers, out, err } = makeWriters();
    await runStatus({
      ctx: makeContext(keyAuth(), false),
      client: fakeClient({ whoami: () => Promise.resolve(makeWhoami()) }),
      writers,
    });

    expect(out.data).not.toContain(FULL_TOKEN);
    expect(err.data).not.toContain(FULL_TOKEN);
  });

  it("shows the resolved config source", async () => {
    const { writers, out } = makeWriters();
    await runStatus({
      ctx: makeContext(keyAuth(), false),
      client: fakeClient({ whoami: () => Promise.resolve(makeWhoami()) }),
      writers,
    });

    expect(out.data).toContain("config");
  });

  it("shows the key name and hint without brackets", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami({ key_name: "ci-key", key_hint: "tr_***1234" });
    await runStatus({
      ctx: makeContext(keyAuth(), false),
      client: fakeClient({ whoami: () => Promise.resolve(who) }),
      writers,
    });

    expect(out.data).toContain("ci-key tr_***1234");
    expect(out.data).not.toContain("[tr_***1234]");
    expect(out.data).not.toContain("(none)");
  });

  it("falls back to the id as primary when a name is null", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami({ workspace_name: null });
    await runStatus({
      ctx: makeContext(keyAuth(), false),
      client: fakeClient({ whoami: () => Promise.resolve(who) }),
      writers,
    });

    expect(out.data).toContain("ws_456");
    expect(out.data).not.toContain("(none)");
  });

  it("renders names first with dimmed ids on a TTY", async () => {
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runStatus({
      ctx: makeContext(keyAuth(), false),
      client: fakeClient({ whoami: () => Promise.resolve(makeWhoami()) }),
      writers: { out, err },
    });

    expect(out.data).toContain("My Project \x1b[2m(proj_123)\x1b[0m");
    expect(out.data).toContain("My Workspace \x1b[2m(ws_456)\x1b[0m");
  });
});

describe("runStatus with a session credential (human)", () => {
  it("derives identity from the JWT email and lists workspaces — no whoami call", async () => {
    const { writers, out } = makeWriters();
    await runStatus({
      ctx: makeContext(sessionAuth(), false),
      client: fakeClient({
        whoami: () => Promise.reject(new Error("whoami must not be called for user credentials")),
        listWorkspaces: () =>
          Promise.resolve({
            data: [
              { id: "ws-1", name: "Alpha", role: "admin" },
              { id: "ws-2", name: "Beta", role: "member" },
            ],
          } as WorkspaceList),
      }),
      writers,
      getAccessToken: () => Promise.resolve(jwtWith({ email: "kai@example.com" })),
    });

    expect(out.data).toContain("kai@example.com");
    expect(out.data).toContain("Alpha");
    expect(out.data).toContain("Beta");
    expect(out.data).toContain("browser login");
    expect(out.data).toContain("https://api.example.com");
    expect(out.data).not.toContain(SESSION);
  });

  it("shows the default project and its source", async () => {
    const { writers, out } = makeWriters();
    await runStatus({
      ctx: makeContext(sessionAuth(), false),
      client: fakeClient({
        listWorkspaces: () => Promise.resolve({ data: [] } as unknown as WorkspaceList),
      }),
      writers,
      getAccessToken: () => Promise.resolve(jwtWith({ email: "kai@example.com" })),
    });

    expect(out.data).toContain("proj_123");
  });

  it("degrades to a workspace-unavailable note when the list call fails", async () => {
    const { writers, out } = makeWriters();
    await runStatus({
      ctx: makeContext(sessionAuth(), false),
      client: fakeClient({
        listWorkspaces: () => Promise.reject(new CliError("boom")),
      }),
      writers,
      getAccessToken: () => Promise.resolve(jwtWith({ email: "kai@example.com" })),
    });

    expect(out.data).toContain("kai@example.com");
    expect(out.data).toContain("unavailable");
  });

  it("propagates a mint failure (revoked session)", async () => {
    const { writers, out } = makeWriters();
    await expect(
      runStatus({
        ctx: makeContext(sessionAuth(), false),
        client: fakeClient({}),
        writers,
        getAccessToken: () => Promise.reject(new CliError("session expired or revoked")),
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(out.data).toBe("");
  });
});

describe("runStatus (--json)", () => {
  it("api-key mode: one JSON document with identity and config_source", async () => {
    const { writers, out, err } = makeWriters();
    await runStatus({
      ctx: makeContext(keyAuth(), true),
      client: fakeClient({ whoami: () => Promise.resolve(makeWhoami()) }),
      writers,
    });

    const parsed = JSON.parse(out.data) as Record<string, unknown>;
    expect(parsed.project_id).toBe("proj_123");
    expect(parsed.workspace_id).toBe("ws_456");
    expect(parsed.key_hint).toBe("tr_***1234");
    expect(parsed.host).toBe("https://api.example.com");
    expect(parsed.credential).toBe("api-key");
    expect(parsed.config_source).toBe("config");
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(err.data).toBe("");
  });

  it("session mode: one JSON document with email, workspaces, and no token", async () => {
    const { writers, out } = makeWriters();
    await runStatus({
      ctx: makeContext(sessionAuth(), true),
      client: fakeClient({
        listWorkspaces: () =>
          Promise.resolve({
            data: [{ id: "ws-1", name: "Alpha", role: "admin" }],
          } as WorkspaceList),
      }),
      writers,
      getAccessToken: () => Promise.resolve(jwtWith({ email: "kai@example.com" })),
    });

    const parsed = JSON.parse(out.data) as Record<string, unknown>;
    expect(parsed.credential).toBe("session");
    expect(parsed.email).toBe("kai@example.com");
    expect(parsed.host).toBe("https://api.example.com");
    expect(parsed.project_id).toBe("proj_123");
    expect(Array.isArray(parsed.workspaces)).toBe(true);
    expect(out.data).not.toContain(SESSION);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("runStatus errors", () => {
  it("propagates a whoami CliError and writes nothing to stdout", async () => {
    const { writers, out } = makeWriters();
    const client = fakeClient({ whoami: () => Promise.reject(new CliError("auth failed")) });

    await expect(
      runStatus({ ctx: makeContext(keyAuth(), false), client, writers }),
    ).rejects.toBeInstanceOf(CliError);
    expect(out.data).toBe("");
  });
});
