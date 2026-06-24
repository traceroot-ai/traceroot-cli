import { describe, expect, it } from "vitest";
import type { ApiClient, Whoami } from "../../src/api/client.js";
import { DEFAULT_HOST } from "../../src/commands/constants.js";
import { type LoginDeps, runLogin } from "../../src/commands/login.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

const FULL_TOKEN = "tr_secret_LEAK";

function makeWhoami(overrides: Partial<Whoami> = {}): Whoami {
  return {
    host: "https://h",
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

function fakeClient(whoami: () => Promise<Whoami>): ApiClient {
  return {
    whoami,
    listTraces: () => Promise.reject(new Error("not used")),
    getTrace: () => Promise.reject(new Error("not used")),
    exportTrace: () => Promise.reject(new Error("not used")),
  };
}

interface Harness {
  writers: Writers;
  out: StringSink;
  err: StringSink;
  writeConfigCalls: Array<{ api_key: string; host_url: string }>;
  createClientCalls: Array<{ host: string; apiKey: string }>;
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
  };
}

function baseDeps(
  h: Harness,
  overrides: Partial<LoginDeps>,
  whoami: () => Promise<Whoami> = () => Promise.resolve(makeWhoami()),
): LoginDeps {
  return {
    json: false,
    isInteractive: false,
    apiKeySource: "env",
    promptConfirm: () => Promise.reject(new Error("promptConfirm should not be called")),
    promptHidden: () => Promise.reject(new Error("promptHidden should not be called")),
    promptVisible: () => Promise.reject(new Error("promptVisible should not be called")),
    createClient: (o) => {
      h.createClientCalls.push(o);
      return fakeClient(whoami);
    },
    writeConfig: (c) => {
      h.writeConfigCalls.push(c);
    },
    writers: h.writers,
    ...overrides,
  };
}

describe("runLogin non-interactive", () => {
  it("writes config once and prints identity (key_hint only) with a Next hint", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        resolvedApiKey: FULL_TOKEN,
        resolvedHost: "https://h",
      }),
    );

    expect(h.writeConfigCalls).toHaveLength(1);
    expect(h.writeConfigCalls[0]).toEqual({ api_key: FULL_TOKEN, host_url: "https://h" });
    expect(h.out.data).toContain("tr_***1234");
    expect(h.out.data).not.toContain(FULL_TOKEN);
    expect(h.err.data).not.toContain(FULL_TOKEN);
    expect(h.err.data).toContain("Next:");
  });

  it("uses a resolved key (e.g. from env / a .env) without prompting", async () => {
    const h = makeHarness();
    // promptHidden rejects in baseDeps, so reaching it would fail the test.
    await runLogin(baseDeps(h, { resolvedApiKey: FULL_TOKEN, resolvedHost: "https://h" }));

    expect(h.createClientCalls[0]).toEqual({ host: "https://h", apiKey: FULL_TOKEN });
    expect(h.writeConfigCalls).toHaveLength(1);
  });

  it("throws a CliError when no api key resolves and not interactive", async () => {
    const h = makeHarness();
    await expect(runLogin(baseDeps(h, { resolvedHost: "https://h" }))).rejects.toBeInstanceOf(
      CliError,
    );
    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.out.data).toBe("");
  });

  it("uses DEFAULT_HOST when no host resolves and not interactive", async () => {
    const h = makeHarness();
    await runLogin(baseDeps(h, { resolvedApiKey: FULL_TOKEN }));

    expect(h.createClientCalls[0]?.host).toBe(DEFAULT_HOST);
    expect(h.writeConfigCalls[0]?.host_url).toBe(DEFAULT_HOST);
  });
});

describe("runLogin validation failure", () => {
  it("does not write config when whoami fails, and writes nothing to stdout", async () => {
    const h = makeHarness();
    const deps = baseDeps(h, { resolvedApiKey: FULL_TOKEN, resolvedHost: "https://h" }, () =>
      Promise.reject(new CliError("invalid api key")),
    );

    await expect(runLogin(deps)).rejects.toBeInstanceOf(CliError);
    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.out.data).toBe("");
  });
});

describe("runLogin interactive", () => {
  it("prompts (masked key, host with default) and writes config without echoing the token", async () => {
    const h = makeHarness();
    let hiddenAsked = 0;
    let visibleAsked = 0;
    const deps = baseDeps(h, {
      isInteractive: true,
      promptHidden: () => {
        hiddenAsked += 1;
        return Promise.resolve(FULL_TOKEN);
      },
      promptVisible: () => {
        visibleAsked += 1;
        return Promise.resolve("https://prompted-host");
      },
    });

    await runLogin(deps);

    expect(hiddenAsked).toBe(1);
    expect(visibleAsked).toBe(1);
    expect(h.writeConfigCalls[0]).toEqual({
      api_key: FULL_TOKEN,
      host_url: "https://prompted-host",
    });
    expect(h.out.data).not.toContain(FULL_TOKEN);
    expect(h.err.data).not.toContain(FULL_TOKEN);
  });
});

describe("runLogin --json", () => {
  it("emits one JSON document on stdout with no full token", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        resolvedApiKey: FULL_TOKEN,
        resolvedHost: "https://h",
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

describe("runLogin already logged in (non-interactive)", () => {
  it("warns and does not rewrite config when source is config and no TTY", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        apiKeySource: "config",
        resolvedApiKey: FULL_TOKEN,
        resolvedHost: "https://h",
        isInteractive: false,
      }),
    );

    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.createClientCalls).toHaveLength(0);
    expect(h.err.data).toContain("Already logged in");
    expect(h.err.data).toContain("https://h");
    expect(h.out.data).not.toContain(FULL_TOKEN);
    expect(h.err.data).not.toContain(FULL_TOKEN);
  });

  it("emits an already_logged_in JSON document and does not rewrite config", async () => {
    const h = makeHarness();
    await runLogin(
      baseDeps(h, {
        apiKeySource: "config",
        resolvedApiKey: FULL_TOKEN,
        resolvedHost: "https://h",
        isInteractive: false,
        json: true,
      }),
    );

    const parsed = JSON.parse(h.out.data) as Record<string, unknown>;
    expect(parsed.status).toBe("already_logged_in");
    expect(parsed.host).toBe("https://h");
    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.out.data).not.toContain(FULL_TOKEN);
  });
});

describe("runLogin already logged in (interactive)", () => {
  it("aborts and keeps the session when the user declines re-login", async () => {
    const h = makeHarness();
    let confirmAsked = 0;
    await runLogin(
      baseDeps(h, {
        apiKeySource: "config",
        resolvedApiKey: FULL_TOKEN,
        resolvedHost: "https://h",
        isInteractive: true,
        promptConfirm: () => {
          confirmAsked += 1;
          return Promise.resolve(false);
        },
      }),
    );

    expect(confirmAsked).toBe(1);
    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.createClientCalls).toHaveLength(0);
    expect(h.err.data).toContain("Already logged in");
  });

  it("re-prompts for fresh credentials and writes the new account on accept", async () => {
    const h = makeHarness();
    const NEW_TOKEN = "tr_new_TOKEN";
    await runLogin(
      baseDeps(h, {
        apiKeySource: "config",
        resolvedApiKey: FULL_TOKEN, // persisted creds — must be ignored on accept
        resolvedHost: "https://old-host",
        isInteractive: true,
        promptConfirm: () => Promise.resolve(true),
        promptHidden: () => Promise.resolve(NEW_TOKEN),
        promptVisible: () => Promise.resolve("https://new-host"),
      }),
    );

    expect(h.createClientCalls[0]).toEqual({ host: "https://new-host", apiKey: NEW_TOKEN });
    expect(h.writeConfigCalls).toHaveLength(1);
    expect(h.writeConfigCalls[0]).toEqual({ api_key: NEW_TOKEN, host_url: "https://new-host" });
    expect(h.out.data).not.toContain(FULL_TOKEN);
    expect(h.out.data).not.toContain(NEW_TOKEN);
  });
});
