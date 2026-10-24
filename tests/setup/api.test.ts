import { describe, expect, it } from "vitest";
import type { TraceList } from "../../src/api/client.js";
import { BackendUnavailableError, SetupApiError, createSetupApi } from "../../src/api/setup.js";
import { pollForTrace } from "../../src/setup/trace.js";
import { listTracesFrom, traceRow } from "./helpers.js";

/** A `fetch` stand-in that replies from a queue and records every request. */
function stubFetch(replies: Array<{ status: number; body?: unknown }>): {
  fetchImpl: typeof globalThis.fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...replies];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = queue.shift();
    if (reply === undefined) {
      // A surplus request is the bug worth seeing. Fabricating a 200 here meant a
      // client that made an extra call still passed, with the extra reply empty.
      throw new Error(`unexpected request to ${String(url)}: the reply queue is empty`);
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe("setup API client", () => {
  it("distinguishes a missing endpoint from an error", async () => {
    const { fetchImpl } = stubFetch([{ status: 404, body: { detail: "not found" } }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await expect(api.listProjects()).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it("scopes the key list by credential, not by a project_id parameter", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { keys: [] } }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await api.listApiKeys("p_1");
    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/public/api-keys");
    expect(calls[0]?.url).not.toContain("project_id");
  });

  it("treats 501 as a missing endpoint too", async () => {
    const { fetchImpl } = stubFetch([{ status: 501, body: {} }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await expect(api.listApiKeys("p_1")).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it("reports a 404 that says what was missing as that failure, not as an undeployed feature", async () => {
    // Regression: the 404 branch ran before the one that reads the body, so a
    // project id that does not resolve was reported as a route this deployment
    // does not have — sending the reader after a server-side gap that is not
    // there, with the server's own explanation discarded unread.
    const { fetchImpl } = stubFetch([{ status: 404, body: { detail: "Project not found" } }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });

    await expect(
      api.createProjectApiKey({ projectId: "p_gone", name: "n", expiresInDays: null }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SetupApiError);
      expect(err).not.toBeInstanceOf(BackendUnavailableError);
      expect((err as SetupApiError).status).toBe(404);
      expect((err as Error).message).toBe("Project not found");
      return true;
    });
  });

  it("still calls a bodyless 404 an absent endpoint", async () => {
    // Nothing to read means nothing to go on, and the callers degrade to a
    // documented manual path on this error — so an unreadable body has to keep
    // reaching it rather than becoming a bare "request failed with status 404".
    const { fetchImpl } = stubFetch([{ status: 404 }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await expect(api.listProjects()).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it("still calls the router's own bare 'Not Found' an absent endpoint", async () => {
    // What a framework answers for a path it cannot route. It names no
    // resource, so it is the one 404 body that really does mean the route is
    // missing.
    const { fetchImpl } = stubFetch([{ status: 404, body: { detail: "Not Found" } }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await expect(api.listProjects()).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it("surfaces the backend's error detail for other failures", async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { detail: "forbidden here" } }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await expect(api.listProjects()).rejects.toThrow(/forbidden here/);
  });

  it("never echoes the api key in a transport error", async () => {
    const key = "tr-super-secret-key-value";
    const fetchImpl = (async () => {
      throw new Error(`connect failed for Bearer ${key}`);
    }) as unknown as typeof globalThis.fetch;
    const api = createSetupApi({ host: "https://api.example.test", apiKey: key, fetchImpl });

    await expect(api.listProjects()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SetupApiError);
      expect((err as Error).message).not.toContain(key);
      expect((err as Error).message).toContain("<redacted>");
      return true;
    });
  });

  it("maps the server's {data:[{id,name,...}]} project shape to the CLI's project_id/project_name fields", async () => {
    // `list_projects` answers with the server's own column names (`id`, `name`),
    // not the `project_id`/`project_name` pair the rest of the wizard speaks in
    // — the translation happens once inside the client rather than at every
    // call site, so this locks the mapping down.
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: {
          data: [{ id: "p_1", name: "demo", workspace_id: "w_1", workspace_name: "acme" }],
        },
      },
    ]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    const projects = await api.listProjects();

    expect(projects).toEqual([
      {
        project_id: "p_1",
        project_name: "demo",
        workspace_id: "w_1",
        workspace_name: "acme",
        workspace_is_demo: false,
      },
    ]);
    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/public/projects");
  });

  it("also accepts a bare array in place of the {data:...} envelope", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: [{ id: "p_1", name: "demo", workspace_id: "w_1" }] },
    ]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    const projects = await api.listProjects();

    expect(projects).toEqual([
      {
        project_id: "p_1",
        project_name: "demo",
        workspace_id: "w_1",
        workspace_name: null,
        workspace_is_demo: false,
      },
    ]);
  });

  it("narrows the projects request to a workspace when one is given", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { data: [] } }]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await api.listProjects("w_1");
    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/public/projects?workspace_id=w_1");
  });

  it("lists the workspaces this user belongs to", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: { data: [{ id: "w_1", name: "acme", role: "owner" }] },
      },
    ]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    const workspaces = await api.listWorkspaces();

    expect(workspaces).toEqual([{ id: "w_1", name: "acme", role: "owner", is_demo: false }]);
    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/public/workspaces");
  });

  it("carries the flags that mark the TraceRoot demo workspace and its projects", async () => {
    // Read strictly: only `true` marks the demo, so a server that predates it,
    // or sends something else, leaves both lists as they were.
    const { fetchImpl } = stubFetch([
      {
        status: 200,
        body: {
          data: [
            { id: "w_1", name: "acme", role: "owner" },
            { id: "w_demo", name: "TraceRoot Demo", role: "viewer", is_demo: true },
          ],
        },
      },
      {
        status: 200,
        body: {
          data: [
            { id: "p_1", name: "web", workspace_id: "w_1", workspace_is_demo: "true" },
            { id: "p_demo", name: "demo", workspace_id: "w_demo", workspace_is_demo: true },
          ],
        },
      },
    ]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });

    const workspaces = await api.listWorkspaces();
    const projects = await api.listProjects();

    expect(workspaces.map((w) => w.is_demo)).toEqual([false, true]);
    expect(projects.map((p) => p.workspace_is_demo)).toEqual([false, true]);
  });

  it("sends the documented key-creation body", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 201,
        body: {
          id: "ak_1",
          name: "n",
          hint: "tr-…1234",
          project_id: "p_1",
          scope: "ingest",
          expires_at: null,
          key: "secret",
        },
      },
    ]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    await api.createApiKey({ name: "n", projectId: "p_1", expiresInDays: null });

    // The server scopes the new key to the authenticating credential's project,
    // so no `project_id` is sent — one could only ever disagree with it. No
    // `scope` either: the key store has no scope column, and asking for a
    // narrowing the server cannot enforce would be theatre.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "n",
      expires_in_days: null,
    });
  });
});

describe("trace polling", () => {
  const startedAt = new Date("2026-07-26T12:00:00.000Z");

  it("returns the first trace created after the run began", async () => {
    let calls = 0;
    const client = {
      listTraces: listTracesFrom(() => {
        calls += 1;
        return calls < 2 ? [] : [traceRow()];
      }),
    };
    const result = await pollForTrace({
      client,
      startedAt,
      timeoutMs: 10_000,
      sleep: async () => undefined,
    });
    expect(result.found).toBe(true);
    expect(result.found && result.trace.traceId).toBe("t_1");
  });

  it("ignores traces that predate the run even if the server returns them", async () => {
    const client = {
      listTraces: listTracesFrom([traceRow({ trace_start_time: "2020-01-01T00:00:00.000000" })]),
    };
    let clock = 0;
    const result = await pollForTrace({
      client,
      startedAt,
      timeoutMs: 5,
      sleep: async () => undefined,
      now: () => {
        clock += 10;
        return clock;
      },
    });
    expect(result.found).toBe(false);
  });

  it("gives up after the timeout instead of polling forever", async () => {
    let clock = 0;
    const result = await pollForTrace({
      client: { listTraces: listTracesFrom([]) },
      startedAt,
      timeoutMs: 100,
      sleep: async () => undefined,
      now: () => {
        clock += 60;
        return clock;
      },
    });
    expect(result.found).toBe(false);
    expect(result.found === false && result.attempts).toBeGreaterThan(0);
  });

  it("reads the published {data, meta} envelope, not a bare array", async () => {
    // Regression: the poller originally understood only a bare array / {traces},
    // so against the real API it saw zero rows forever and reported a timeout
    // for traces that had already arrived.
    //
    // Spelled out rather than taken from `listTracesFrom`, which answers the
    // same way, because the envelope is what this test is about. Cast because
    // the row carries only the fields the poll reads.
    const client = {
      listTraces: async () => ({ data: [traceRow()], meta: { limit: 1 } }) as unknown as TraceList,
    };
    const result = await pollForTrace({
      client,
      startedAt,
      timeoutMs: 1000,
      sleep: async () => undefined,
    });
    expect(result.found).toBe(true);
  });

  it("treats a zone-less backend timestamp as UTC, not local time", async () => {
    // The backend emits `2026-07-26T12:00:30.000000` (UTC, no Z). Parsed as
    // local time, a machine east of UTC would place the trace BEFORE the run
    // started and discard it — a false timeout for a trace that did arrive.
    const justAfterStart = "2026-07-26T12:00:01.000000";
    const result = await pollForTrace({
      client: { listTraces: listTracesFrom([traceRow({ trace_start_time: justAfterStart })]) },
      startedAt,
      timeoutMs: 1000,
      sleep: async () => undefined,
    });
    expect(result.found).toBe(true);
  });

  it("reports the first trace of the run, not the most recent one", async () => {
    // The backend orders `trace_start_time DESC` and offers no ascending mode,
    // so row zero is the newest. Both this and the browser wizard call what
    // they show "your first trace", and an app that emits two traces per run
    // made that a race — whichever surface polled after the second one landed
    // linked to the second one, and the two disagreed. Sorting makes the
    // answer the same whenever anyone looks.
    const result = await pollForTrace({
      client: {
        listTraces: listTracesFrom([
          traceRow({
            trace_id: "second",
            trace_url: "https://app.example.test/trace/second",
            trace_start_time: "2026-07-26T12:00:45.000000",
          }),
          traceRow({
            trace_id: "first",
            trace_url: "https://app.example.test/trace/first",
            trace_start_time: "2026-07-26T12:00:15.000000",
          }),
        ]),
      },
      startedAt,
      timeoutMs: 1000,
      sleep: async () => undefined,
    });

    expect(result.found).toBe(true);
    expect(result.found && result.trace.traceId).toBe("first");
    expect(result.found && result.trace.traceUrl).toBe("https://app.example.test/trace/first");
  });

  it("still reports a trace whose start time it cannot read", async () => {
    // Unparseable sorts last rather than out: it is a real trace, it just
    // cannot win an ordering contest against one that can be read.
    const result = await pollForTrace({
      client: {
        listTraces: listTracesFrom([
          traceRow({ trace_id: "unreadable", trace_start_time: "not a date" }),
        ]),
      },
      startedAt,
      timeoutMs: 1000,
      sleep: async () => undefined,
    });
    expect(result.found && result.trace.traceId).toBe("unreadable");
  });

  it("stops immediately on an auth failure with no detail", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401 }]);
    const client = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });
    const result = await pollForTrace({
      client,
      startedAt,
      timeoutMs: 10_000,
      sleep: async () => undefined,
    });
    expect(result.found).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("keeps polling an unreachable host whose port contains 403", async () => {
    // The transport failure's message names the host, and the auth check used
    // to match "403" in `localhost:4030` and give up on the first attempt.
    let calls = 0;
    const client = createSetupApi({
      host: "http://localhost:4030",
      apiKey: "k",
      fetchImpl: (async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch,
    });
    let clock = 0;
    const result = await pollForTrace({
      client,
      startedAt,
      timeoutMs: 10_000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(result.found).toBe(false);
    expect(calls).toBeGreaterThan(1);
    expect(result.found === false && result.lastError).toContain("localhost:4030");
  });

  it("keeps polling through a transient error", async () => {
    let calls = 0;
    const client = {
      listTraces: listTracesFrom(() => {
        calls += 1;
        if (calls === 1) {
          throw new Error("request to host failed: fetch failed");
        }
        return [traceRow()];
      }),
    };
    const result = await pollForTrace({
      client,
      startedAt,
      timeoutMs: 10_000,
      sleep: async () => undefined,
    });
    expect(result.found).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("what credential the client sends", () => {
  it("sends the project key as a bearer token on every authenticated read", async () => {
    // Nothing asserted this: the client could have sent no credential, or the
    // wrong one, and every other test in this file would still pass because the
    // stub replies regardless of what it is handed.
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { keys: [] } }]);
    const api = createSetupApi({
      host: "https://api.example.test",
      apiKey: "tr-the-key",
      fetchImpl,
    });

    await api.listApiKeys("p_1");

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer tr-the-key");
  });

  it("refuses a host that is not an http(s) URL before any request is built", async () => {
    // The shared validator's job: a mistyped `--host` should fail as a usage
    // error, not as an opaque fetch rejection partway through a run.
    const { fetchImpl, calls } = stubFetch([]);
    expect(() => createSetupApi({ host: "notaurl", fetchImpl })).toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("creating a project", () => {
  it("maps the server's shape into the vocabulary every caller reads", async () => {
    // The server answers `{id, name, workspace_id}`; the wizard reads
    // `project_id`/`project_name` throughout. Returning the raw shape typed as
    // `ProjectSummary` carried undefined identifiers into the key mint and the
    // checkpoint on the brand-new-account path, which is the headline scenario.
    const { fetchImpl } = stubFetch([
      { status: 201, body: { id: "p_1", name: "demo", workspace_id: "w_1" } },
    ]);
    const api = createSetupApi({ host: "https://api.example.test", apiKey: "k", fetchImpl });

    const created = await api.createProject("demo", "w_1");

    expect(created.project_id).toBe("p_1");
    expect(created.project_name).toBe("demo");
    expect(created.workspace_id).toBe("w_1");
  });
});

describe("revoking a key on the user's own credential", () => {
  const tokenProvider = { getAccessToken: async () => "access-jwt-value" };

  it("deletes it from the project it names, with the user's token", async () => {
    // The key-authenticated route accepts only an admin API key, so a key
    // minted on a sign-in can only go back through the route that names its
    // project, on the same credential that minted it.
    const { fetchImpl, calls } = stubFetch([{ status: 204 }]);
    const api = createSetupApi({ host: "https://api.example.test", tokenProvider, fetchImpl });

    await expect(api.revokeProjectApiKey("p_1", "ak_1")).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/public/projects/p_1/api-keys/ak_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer access-jwt-value");
  });

  it("calls a deployment without the route unavailable, as for every other setup route", async () => {
    for (const reply of [
      { status: 404 },
      { status: 404, body: { detail: "Not Found" } },
      { status: 501 },
    ]) {
      const { fetchImpl } = stubFetch([reply]);
      const api = createSetupApi({ host: "https://api.example.test", tokenProvider, fetchImpl });
      await expect(api.revokeProjectApiKey("p_1", "ak_1")).rejects.toBeInstanceOf(
        BackendUnavailableError,
      );
    }
  });

  it("reports a refusal, and a key the project does not have, with the server's status", async () => {
    for (const [status, detail] of [
      [403, "Your role cannot revoke this project's keys"],
      [404, "API key not found"],
      [401, "Not authenticated"],
    ] as const) {
      const { fetchImpl } = stubFetch([{ status, body: { detail } }]);
      const api = createSetupApi({ host: "https://api.example.test", tokenProvider, fetchImpl });
      await expect(api.revokeProjectApiKey("p_1", "ak_1")).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(SetupApiError);
        expect(err).not.toBeInstanceOf(BackendUnavailableError);
        expect((err as SetupApiError).status).toBe(status);
        expect((err as Error).message).toBe(detail);
        return true;
      });
    }
  });
});
