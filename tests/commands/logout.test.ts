import { describe, expect, it } from "vitest";
import { type LogoutDeps, runLogout } from "../../src/commands/logout.js";
import type { Config } from "../../src/config/schema.js";
import { CliError, ExitCode, type Writers } from "../../src/output.js";
import { type FetchCall, createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
import { StringSink } from "../helpers/stringSink.js";

const SESSION = "sess_secret_LEAK";

interface HarnessOptions {
  sessionToken?: string;
  sessionFromFile?: boolean;
  apiKeyFromEnv?: boolean;
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
    sessionToken: opts.sessionToken,
    sessionFromFile: opts.sessionFromFile ?? true,
    apiKeyFromEnv: opts.apiKeyFromEnv ?? false,
    deleteCredentialEntry: (host) => {
      deleted.push(host);
      return true;
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
  it("revokes at the resolved auth host and deletes the local entry on confirmation", async () => {
    const h = harness({ sessionToken: SESSION });
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

  it("reports an already-revoked session (revoked:false) and still deletes locally", async () => {
    const h = harness({ sessionToken: SESSION, responder: () => jsonResponse({ revoked: false }) });
    await runLogout(h.deps);
    expect(h.deleted).toEqual(["https://api.example.com"]);
    expect(h.out.data).toContain("already");
  });

  it("deletes locally and warns when the logout route is absent (404 — version skew)", async () => {
    let res: Response | undefined;
    const h = harness({
      sessionToken: SESSION,
      responder: () => {
        res = jsonResponse({ detail: "Not Found" }, 404);
        return res;
      },
    });
    await runLogout(h.deps);
    // A CLI-side revoke is impossible here; keeping the credential would
    // strand the user locally forever.
    expect(h.deleted).toEqual(["https://api.example.com"]);
    expect(h.out.data).toContain("no logout route");
    expect(h.out.data).toContain("Active sessions");
    // The never-read body was cancelled, not left holding its stream open.
    expect(res?.bodyUsed).toBe(true);
  });

  it("treats a 401 as an already-dead session and deletes locally", async () => {
    const h = harness({
      sessionToken: SESSION,
      responder: () => jsonResponse({ detail: "unauthorized" }, 401),
    });
    await runLogout(h.deps);
    expect(h.deleted).toEqual(["https://api.example.com"]);
    expect(h.out.data).toContain("already");
  });

  it("does not strand the credential on a 200 whose body is unreadable", async () => {
    const h = harness({
      sessionToken: SESSION,
      responder: () => new Response("", { status: 200 }),
    });
    await runLogout(h.deps);
    expect(h.deleted).toEqual(["https://api.example.com"]);
    expect(h.out.data).toContain("Logged out of");
  });

  it("carries the route-absent warning in the --json document", async () => {
    const h = harness({
      sessionToken: SESSION,
      json: true,
      responder: () => jsonResponse({ detail: "Not Found" }, 404),
    });
    await runLogout(h.deps);
    const doc = JSON.parse(h.out.data) as { revoked: boolean; warning?: string };
    expect(doc.revoked).toBe(false);
    expect(doc.warning).toContain("no logout route");
  });

  it("does not treat a JSON null body on a 200 as a failure (deletes locally)", async () => {
    const h = harness({
      sessionToken: SESSION,
      responder: () => new Response("null", { status: 200 }),
    });
    await runLogout(h.deps);
    expect(h.deleted).toEqual(["https://api.example.com"]);
  });

  it("KEEPS the credential on an off-contract 2xx (202) — only a 200 confirms", async () => {
    const h = harness({
      sessionToken: SESSION,
      responder: () => new Response(null, { status: 202 }),
    });
    const err = await runLogout(h.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(h.deleted).toEqual([]);
  });

  it("rejects a malformed auth host as a usage error before any request", async () => {
    const h = harness({ sessionToken: SESSION });
    h.deps.authHost = "not a url";
    const err = await runLogout(h.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect(h.calls).toHaveLength(0);
    expect(h.deleted).toEqual([]);
  });

  it("KEEPS the credential and fails when the revoke is not confirmed (5xx)", async () => {
    const h = harness({
      sessionToken: SESSION,
      responder: () => jsonResponse({ error: "boom" }, 503),
    });
    const err = await runLogout(h.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    // The row may still be live server-side, so the credential must NOT be
    // deleted — deleting it would strand a session the CLI could never revoke.
    expect(h.deleted).toEqual([]);
    expect((err as CliError).message).toContain("logout");
  });

  it("KEEPS the credential and fails on a network error, never leaking the token", async () => {
    const h = harness({
      sessionToken: SESSION,
      responder: () => {
        throw new Error(`boom ${SESSION}`);
      },
    });
    const err = await runLogout(h.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(h.deleted).toEqual([]);
    expect((err as CliError).message).not.toContain(SESSION);
  });

  it("revokes an env-var session but tells the user to unset it (no local entry to delete)", async () => {
    const h = harness({ sessionToken: SESSION, sessionFromFile: false });
    await runLogout(h.deps);
    expect(h.calls).toHaveLength(1);
    // Nothing to delete — the credential lives in the environment.
    expect(h.deleted).toEqual([]);
    expect(h.out.data).toContain("Logged out");
    expect(h.err.data).toContain("TRACEROOT_TOKEN");
  });

  it("preserves a configured key when an ambient (env/flag) key is the active credential", async () => {
    const h = harness({
      apiKeyFromEnv: true,
      config: { api_key: "tr_config_key", host_url: "https://h" },
    });
    await runLogout(h.deps);
    // The lower-priority stored key the user is not even using stays put; the
    // user is told to unset the ambient credential instead.
    expect(h.writeConfigCalls).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.out.data).toContain("TRACEROOT_API_KEY");
    expect(h.out.data).toContain("left untouched");
  });

  it("emits a single JSON document under --json", async () => {
    const h = harness({ sessionToken: SESSION, json: true });
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
