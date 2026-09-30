import { describe, expect, it } from "vitest";
import { BackendUnavailableError, SetupApiError, createSetupApi } from "../../src/api/setup.js";
import { pollForTrace } from "../../src/setup/trace.js";
import { fakeApiClient, traceRow } from "./helpers.js";

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
      { project_id: "p_1", project_name: "demo", workspace_id: "w_1", workspace_name: "acme" },
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
      { project_id: "p_1", project_name: "demo", workspace_id: "w_1", workspace_name: null },
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

    expect(workspaces).toEqual([{ id: "w_1", name: "acme", role: "owner" }]);
    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/public/workspaces");
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
    const client = fakeApiClient({
      traces: () => {
        calls += 1;
        return calls < 2 ? [] : [traceRow()];
      },
    });
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
    const client = fakeApiClient({
      traces: [traceRow({ trace_start_time: "2020-01-01T00:00:00.000000" })],
    });
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
      client: fakeApiClient({ traces: [] }),
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
    const client = {
      ...fakeApiClient(),
      listTraces: async () =>
        ({ data: [traceRow()], meta: { limit: 1 } }) as unknown as Awaited<
          ReturnType<typeof fakeApiClient>["listTraces"]
        >,
    } as ReturnType<typeof fakeApiClient>;
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
      client: fakeApiClient({ traces: [traceRow({ trace_start_time: justAfterStart })] }),
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
      client: fakeApiClient({
        traces: [
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
        ],
      }),
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
      client: fakeApiClient({
        traces: [traceRow({ trace_id: "unreadable", trace_start_time: "not a date" })],
      }),
      startedAt,
      timeoutMs: 1000,
      sleep: async () => undefined,
    });
    expect(result.found && result.trace.traceId).toBe("unreadable");
  });

  it("stops immediately on an auth failure", async () => {
    let calls = 0;
    const client = fakeApiClient({
      traces: () => {
        calls += 1;
        throw new Error("401 unauthorized");
      },
    });
    const result = await pollForTrace({
      client,
      startedAt,
      timeoutMs: 10_000,
      sleep: async () => undefined,
    });
    expect(result.found).toBe(false);
    expect(calls).toBe(1);
  });

  it("keeps polling through a transient error", async () => {
    let calls = 0;
    const client = fakeApiClient({
      traces: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("request to host failed: fetch failed");
        }
        return [traceRow()];
      },
    });
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
