import { describe, expect, it } from "vitest";
import type { ApiClientOptions, Whoami, WorkspaceList } from "../../src/api/client.js";
import type { CredentialEntry } from "../../src/auth/credentials.js";
import type { DeviceFlowResult } from "../../src/auth/deviceFlow.js";
import { DEFAULT_HOST } from "../../src/commands/constants.js";
import { type LoginDeps, WHOAMI_WARNING_TIMEOUT_MS, runLogin } from "../../src/commands/login.js";
import type { ResolvedCredential } from "../../src/config/resolve.js";
import type { Config } from "../../src/config/schema.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

const FULL_TOKEN = "tr_secret_LEAK1234";
const NEW_TOKEN = "tr_new_secret_5678";
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

function noCredential(): ResolvedCredential {
  return { kind: "none", value: undefined, source: "none" };
}

function keyCredential(source: ResolvedCredential["source"] = "env"): ResolvedCredential {
  return { kind: "api-key", value: FULL_TOKEN, source };
}

interface Harness {
  writers: Writers;
  out: StringSink;
  err: StringSink;
  writeConfigCalls: Config[];
  createClientCalls: ApiClientOptions[];
  credentialWrites: Array<{ host: string; entry: CredentialEntry }>;
  deviceFlowRuns: Array<{ authHost: string }>;
  mintCalls: Array<{ authHost: string; sessionToken: string }>;
}

function makeHarness(): Harness {
  const out = new StringSink();
  const err = new StringSink();
  return {
    writers: { out, err },
    out,
    err,
    writeConfigCalls: [],
    createClientCalls: [],
    credentialWrites: [],
    deviceFlowRuns: [],
    mintCalls: [],
  };
}

interface DepsOverrides extends Partial<LoginDeps> {
  whoami?: () => Promise<Whoami>;
  listWorkspaces?: () => Promise<WorkspaceList>;
}

function baseDeps(h: Harness, overrides: DepsOverrides = {}): LoginDeps {
  const {
    whoami = () => Promise.resolve(makeWhoami()),
    listWorkspaces = () =>
      Promise.resolve({ data: [{ id: "ws-1", name: "Alpha", role: "admin" }] } as WorkspaceList),
    ...rest
  } = overrides;
  return {
    credential: noCredential(),
    hostSource: "default",
    json: false,
    isInteractive: false,
    promptConfirm: () => Promise.reject(new Error("promptConfirm should not be called")),
    createClient: (o) => {
      h.createClientCalls.push(o);
      return { whoami, listWorkspaces } as unknown as ReturnType<LoginDeps["createClient"]>;
    },
    readConfig: () => null,
    writeConfig: (c) => {
      h.writeConfigCalls.push(c);
    },
    readCredentialEntry: () => null,
    writeCredentialEntry: (host, entry) => {
      h.credentialWrites.push({ host, entry });
    },
    deviceFlow: (deps): Promise<DeviceFlowResult> => {
      h.deviceFlowRuns.push({ authHost: deps.authHost });
      return Promise.resolve({ sessionToken: SESSION });
    },
    mintAccessToken: (args) => {
      h.mintCalls.push(args);
      return Promise.resolve(jwtWith({ email: "kai@example.com" }));
    },
    nowIso: () => "2026-08-17T00:00:00.000Z",
    writers: h.writers,
    ...rest,
  };
}

describe("runLogin key mode (explicit api key)", () => {
  it("validates then persists, printing identity (key_hint only) with a Next hint", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, { credential: keyCredential(), resolvedHost: "https://h", hostSource: "env" }),
    );

    expect(h.writeConfigCalls).toHaveLength(1);
    expect(h.writeConfigCalls[0]).toEqual({ api_key: FULL_TOKEN, host_url: "https://h" });
    expect(h.deviceFlowRuns).toHaveLength(0);
    expect(h.out.data).toContain("tr_***1234");
    expect(h.out.data).not.toContain(FULL_TOKEN);
    expect(h.err.data).not.toContain(FULL_TOKEN);
    expect(h.err.data).toContain("Next:");
  });

  it("authenticates the client with the resolved key", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, { credential: keyCredential(), resolvedHost: "https://h", hostSource: "env" }),
    );
    expect(h.createClientCalls[0]).toEqual({
      host: "https://h",
      auth: { kind: "api-key", key: FULL_TOKEN },
    });
  });

  it("bounds credential validation with the request timeout", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: keyCredential(),
        resolvedHost: "https://h",
        hostSource: "env",
        timeoutMs: 1234,
      }),
    );
    expect(h.createClientCalls[0]?.timeoutMs).toBe(1234);
  });

  it("uses DEFAULT_HOST when no host resolves", async () => {
    const h = makeHarness();
    await runLogin(baseDeps(h, { credential: keyCredential() }));
    expect(h.createClientCalls[0]?.host).toBe(DEFAULT_HOST);
    expect(h.writeConfigCalls[0]?.host_url).toBe(DEFAULT_HOST);
  });

  it("does not write config when whoami fails, and writes nothing to stdout", async () => {
    const h = makeHarness();
    const deps = baseDeps(h, {
      credential: keyCredential(),
      resolvedHost: "https://h",
      hostSource: "env",
      whoami: () => Promise.reject(new CliError("invalid api key")),
    });

    await expect(runLogin(deps)).rejects.toBeInstanceOf(CliError);
    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.out.data).toBe("");
  });

  it("emits one JSON document on stdout with no full token under --json", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: keyCredential(),
        resolvedHost: "https://h",
        hostSource: "env",
        json: true,
      }),
    );

    const parsed = JSON.parse(h.out.data) as Record<string, unknown>;
    expect(parsed.project_id).toBe("proj_123");
    expect(parsed.key_hint).toBe("tr_***1234");
    expect(h.out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(h.out.data).not.toContain(FULL_TOKEN);
  });
});

describe("runLogin device flow (default)", () => {
  it("runs the device flow and stores the session keyed by host", async () => {
    const h = makeHarness();
    await runLogin(baseDeps(h, { resolvedHost: "https://h", hostSource: "config" }));

    expect(h.deviceFlowRuns).toEqual([{ authHost: "https://h" }]);
    expect(h.credentialWrites).toHaveLength(1);
    expect(h.credentialWrites[0]?.host).toBe("https://h");
    expect(h.credentialWrites[0]?.entry).toEqual({
      session_token: SESSION,
      email: "kai@example.com",
      created_at: "2026-08-17T00:00:00.000Z",
    });
    expect(h.out.data).toContain("kai@example.com");
    expect(h.out.data).toContain("Alpha");
    expect(h.err.data).toContain("Next:");
    expect(h.out.data).not.toContain(SESSION);
    expect(h.err.data).not.toContain(SESSION);
  });

  it("records a distinct auth host in the entry and uses it for the flow", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        resolvedHost: "https://api.example.com",
        hostSource: "flag",
        authHost: "https://ui.example.com",
      }),
    );

    expect(h.deviceFlowRuns).toEqual([{ authHost: "https://ui.example.com" }]);
    expect(h.mintCalls[0]?.authHost).toBe("https://ui.example.com");
    expect(h.credentialWrites[0]?.entry.auth_host).toBe("https://ui.example.com");
  });

  it("defaults to production and does not touch the project config", async () => {
    const h = makeHarness();
    await runLogin(baseDeps(h));
    expect(h.deviceFlowRuns).toEqual([{ authHost: DEFAULT_HOST }]);
    expect(h.credentialWrites[0]?.host).toBe(DEFAULT_HOST);
    expect(h.writeConfigCalls).toHaveLength(0);
  });

  it("persists an explicitly overridden host to the config, preserving other fields", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        resolvedHost: "https://custom",
        hostSource: "flag",
        readConfig: () => ({ project_id: "p-1" }),
      }),
    );
    expect(h.writeConfigCalls).toEqual([{ project_id: "p-1", host_url: "https://custom" }]);
  });

  it("still stores the session and succeeds when the identity mint fails", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        resolvedHost: "https://h",
        hostSource: "config",
        mintAccessToken: () => Promise.reject(new CliError("rate limited")),
      }),
    );

    expect(h.credentialWrites).toHaveLength(1);
    expect(h.credentialWrites[0]?.entry.email).toBeUndefined();
    expect(h.err.data).toContain("Signed in");
    expect(h.out.data).not.toContain(SESSION);
  });

  it("emits one JSON result document under --json, instructions on stderr only", async () => {
    const h = makeHarness();
    await runLogin(baseDeps(h, { resolvedHost: "https://h", hostSource: "config", json: true }));

    const parsed = JSON.parse(h.out.data) as Record<string, unknown>;
    expect(parsed.status).toBe("logged_in");
    expect(parsed.host).toBe("https://h");
    expect(parsed.email).toBe("kai@example.com");
    expect(h.out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(h.out.data).not.toContain(SESSION);
  });
});

describe("runLogin already logged in", () => {
  it("api-key from config: warns via whoami and persists nothing (no TTY)", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: keyCredential("config"),
        resolvedHost: "https://h",
        hostSource: "config",
      }),
    );

    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.deviceFlowRuns).toHaveLength(0);
    expect(h.createClientCalls).toHaveLength(1);
    expect(h.createClientCalls[0]).toEqual({
      host: "https://h",
      auth: { kind: "api-key", key: FULL_TOKEN },
      timeoutMs: WHOAMI_WARNING_TIMEOUT_MS,
    });
    expect(h.err.data).toContain("WARNING:");
    expect(h.err.data).toContain("Already logged in");
    expect(h.err.data).toContain("My Project");
    expect(h.out.data).not.toContain(FULL_TOKEN);
    expect(h.err.data).not.toContain(FULL_TOKEN);
  });

  it("falls back to a host-only warning when the saved key can't be verified", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: keyCredential("config"),
        resolvedHost: "https://h",
        hostSource: "config",
        whoami: () => Promise.reject(new Error("expired key")),
      }),
    );

    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.err.data).toContain("WARNING:");
    expect(h.err.data).toContain("https://h");
  });

  it("an explicit host override bypasses the warning and logs in fresh", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: keyCredential("config"),
        resolvedHost: "https://new-host",
        hostSource: "flag",
      }),
    );

    // Key still resolved from config, but the host override signals intent:
    // treat as a fresh key login against the new host.
    expect(h.writeConfigCalls).toEqual([{ api_key: FULL_TOKEN, host_url: "https://new-host" }]);
    expect(h.err.data).not.toContain("Already logged in");
  });

  it("stored session: warns with the stored identity and runs nothing (no TTY)", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: { kind: "session", value: SESSION, source: "credentials-file" },
        resolvedHost: "https://h",
        hostSource: "config",
        readCredentialEntry: () => ({ session_token: SESSION, email: "kai@example.com" }),
      }),
    );

    expect(h.deviceFlowRuns).toHaveLength(0);
    expect(h.credentialWrites).toHaveLength(0);
    expect(h.err.data).toContain("Already logged in");
    expect(h.err.data).toContain("kai@example.com");
    expect(h.err.data).not.toContain(SESSION);
  });

  it("stored session: reports already_logged_in under --json", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: { kind: "session", value: SESSION, source: "credentials-file" },
        resolvedHost: "https://h",
        hostSource: "config",
        json: true,
        readCredentialEntry: () => ({ session_token: SESSION, email: "kai@example.com" }),
      }),
    );

    const parsed = JSON.parse(h.out.data) as Record<string, unknown>;
    expect(parsed.status).toBe("already_logged_in");
    expect(parsed.credential).toBe("session");
    expect(h.deviceFlowRuns).toHaveLength(0);
    expect(h.out.data).not.toContain(SESSION);
  });

  it("stored session: an interactive yes re-runs the device flow", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: { kind: "session", value: SESSION, source: "credentials-file" },
        resolvedHost: "https://h",
        hostSource: "config",
        isInteractive: true,
        promptConfirm: () => Promise.resolve(true),
        readCredentialEntry: () => ({ session_token: SESSION }),
      }),
    );

    expect(h.deviceFlowRuns).toHaveLength(1);
    expect(h.credentialWrites).toHaveLength(1);
  });

  it("stored session: a declined prompt keeps the current session", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: { kind: "session", value: SESSION, source: "credentials-file" },
        resolvedHost: "https://h",
        hostSource: "config",
        isInteractive: true,
        promptConfirm: () => Promise.resolve(false),
        readCredentialEntry: () => ({ session_token: SESSION }),
      }),
    );

    expect(h.deviceFlowRuns).toHaveLength(0);
    expect(h.credentialWrites).toHaveLength(0);
    expect(h.err.data).toContain("Keeping current session");
  });

  it("api-key from config: an interactive yes switches to the device flow", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        credential: keyCredential("config"),
        resolvedHost: "https://h",
        hostSource: "config",
        isInteractive: true,
        promptConfirm: () => Promise.resolve(true),
      }),
    );

    expect(h.deviceFlowRuns).toHaveLength(1);
    expect(h.credentialWrites).toHaveLength(1);
    expect(h.writeConfigCalls).toHaveLength(0);
  });
});
