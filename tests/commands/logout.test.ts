import { describe, expect, it } from "vitest";
import type { CredentialEntry } from "../../src/auth/credentials.js";
import { type LogoutDeps, runLogout } from "../../src/commands/logout.js";
import type { Config } from "../../src/config/schema.js";
import type { Writers } from "../../src/output.js";
import { type FetchCall, createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
import { StringSink } from "../helpers/stringSink.js";

const SESSION = "sess_secret_LEAK";

interface HarnessOptions {
  entry?: CredentialEntry | null;
  config?: Config | null;
  responder?: (call: FetchCall) => Response | Promise<Response>;
  json?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const out = new StringSink();
  const err = new StringSink();
  const writers: Writers = { out, err };
  const deleted: string[] = [];
  const writeConfigCalls: Config[] = [];
  const fake = createFakeFetch(opts.responder ?? (() => jsonResponse({ revoked: true })));
  const deps: LogoutDeps = {
    host: "https://api.example.com",
    authHost: "https://ui.example.com",
    json: opts.json ?? false,
    readCredentialEntry: () => opts.entry ?? null,
    deleteCredentialEntry: (host) => {
      deleted.push(host);
      return (opts.entry ?? null) !== null;
    },
    readConfig: () => opts.config ?? null,
    writeConfig: (config) => {
      writeConfigCalls.push(config);
    },
    fetchImpl: fake.fetchImpl,
    writers,
  };
  return { deps, out, err, deleted, writeConfigCalls, calls: fake.calls };
}

describe("runLogout with a stored session", () => {
  it("revokes server-side and deletes the local entry", async () => {
    const h = harness({ entry: { session_token: SESSION } });
    await runLogout(h.deps);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe("https://ui.example.com/api/cli/logout");
    expect(h.calls[0]?.init.method).toBe("POST");
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${SESSION}`);
    expect(h.deleted).toEqual(["https://api.example.com"]);
    expect(h.out.data).toContain("Logged out");
    // Offline JWT verification: never advertise instant access-token death.
    expect(h.out.data).toContain("10 minutes");
  });

  it("sends the revoke to the resolved auth host, not the API host", async () => {
    // deps.authHost is the RESOLVED auth host (flag > env > the entry's
    // recorded auth_host > API host) — an explicit --auth-host must win over
    // the stored entry, so runLogout uses the resolved value as-is.
    const h = harness({
      entry: { session_token: SESSION, auth_host: "https://ui.stored" },
    });
    await runLogout(h.deps);
    expect(h.calls[0]?.url).toBe("https://ui.example.com/api/cli/logout");
  });

  it("reports an already-revoked session without the caveat", async () => {
    const h = harness({
      entry: { session_token: SESSION },
      responder: () => jsonResponse({ revoked: false }),
    });
    await runLogout(h.deps);
    expect(h.deleted).toHaveLength(1);
    expect(h.out.data).toContain("already");
  });

  it("still logs out locally with a warning when the route is not deployed (404)", async () => {
    const h = harness({
      entry: { session_token: SESSION },
      responder: () => jsonResponse({ error: "not found" }, 404),
    });
    await runLogout(h.deps);
    expect(h.deleted).toEqual(["https://api.example.com"]);
    expect(h.out.data).toContain("Logged out");
    expect(h.err.data).toContain("still active");
    expect(h.err.data).toContain("Active sessions");
  });

  it("still logs out locally with a warning on a network failure", async () => {
    const h = harness({
      entry: { session_token: SESSION },
      responder: () => {
        throw new Error(`boom ${SESSION}`);
      },
    });
    await runLogout(h.deps);
    expect(h.deleted).toHaveLength(1);
    expect(h.err.data).toContain("still active");
    expect(h.err.data).not.toContain(SESSION);
    expect(h.out.data).not.toContain(SESSION);
  });

  it("emits a single JSON document under --json", async () => {
    const h = harness({ entry: { session_token: SESSION }, json: true });
    await runLogout(h.deps);
    const parsed = JSON.parse(h.out.data) as Record<string, unknown>;
    expect(parsed.status).toBe("logged_out");
    expect(parsed.revoked).toBe(true);
    expect(parsed.host).toBe("https://api.example.com");
    expect(h.out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(h.out.data).not.toContain(SESSION);
  });
});

describe("runLogout without a session", () => {
  it("removes a persisted api key from the config instead", async () => {
    const h = harness({
      config: { api_key: "tr_x", host_url: "https://h", project_id: "p-1" },
    });
    await runLogout(h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.writeConfigCalls).toEqual([{ host_url: "https://h", project_id: "p-1" }]);
    expect(h.out.data).toContain("API key");
  });

  it("is a friendly no-op when nothing is stored", async () => {
    const h = harness();
    await runLogout(h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.writeConfigCalls).toHaveLength(0);
    expect(h.out.data.toLowerCase()).toContain("not logged in");
  });

  it("reports the no-op in JSON mode", async () => {
    const h = harness({ json: true });
    await runLogout(h.deps);
    const parsed = JSON.parse(h.out.data) as Record<string, unknown>;
    expect(parsed.status).toBe("not_logged_in");
  });
});
