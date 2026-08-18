import { describe, expect, it } from "vitest";
import type { ApiClient, SessionDetail, SessionList } from "../../src/api/client.js";
import { runSessionGet } from "../../src/commands/sessions/get.js";
import { runSessionsList } from "../../src/commands/sessions/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const LIST: SessionList = {
  data: [
    {
      session_id: "sess-abc",
      trace_count: 3,
      user_ids: ["u-1"],
      first_trace_time: "2026-08-01T10:00:00Z",
      last_trace_time: "2026-08-01T10:05:00Z",
      duration_ms: 300000,
      total_input_tokens: 100,
      total_output_tokens: 50,
      input: "hello",
      output: "world",
      total_cost: null,
    },
  ],
  meta: { total: 1, limit: 50, page: 1 },
} as unknown as SessionList;

const DETAIL: SessionDetail = {
  session_id: "sess-abc",
  trace_count: 2,
  user_ids: ["u-1"],
  first_trace_time: "2026-08-01T10:00:00Z",
  last_trace_time: "2026-08-01T10:05:00Z",
  duration_ms: 300000,
  total_input_tokens: 100,
  total_output_tokens: 50,
  total_cost: null,
  traces: [
    { trace_id: "t-1", name: "run-a" },
    { trace_id: "t-2", name: "run-b" },
  ],
} as unknown as SessionDetail;

function client(recorded: Record<string, unknown[]>): ApiClient {
  return {
    listSessions: (...args: unknown[]) => {
      recorded.listSessions = args;
      return Promise.resolve(LIST);
    },
    getSession: (...args: unknown[]) => {
      recorded.getSession = args;
      return Promise.resolve(DETAIL);
    },
  } as unknown as ApiClient;
}

describe("sessions list", () => {
  it("forwards limit, search, range, and project params", async () => {
    const recorded: Record<string, unknown[]> = {};
    const { writers } = makeWriters();
    await runSessionsList({
      client: client(recorded),
      json: true,
      writers,
      limit: 5,
      searchQuery: "sess",
      startAfter: "2026-08-01T00:00:00.000Z",
      endBefore: "2026-08-02T00:00:00.000Z",
      projectId: "p-1",
    });
    expect(recorded.listSessions?.[0]).toEqual({
      limit: 5,
      searchQuery: "sess",
      startAfter: "2026-08-01T00:00:00.000Z",
      endBefore: "2026-08-02T00:00:00.000Z",
      projectId: "p-1",
    });
  });

  it("renders a table with the session id and trace count", async () => {
    const recorded: Record<string, unknown[]> = {};
    const { writers, out } = makeWriters();
    await runSessionsList({ client: client(recorded), json: false, writers });
    expect(out.data).toContain("sess-abc");
    expect(out.data).toContain("3");
  });

  it("emits one JSON document with a count", async () => {
    const recorded: Record<string, unknown[]> = {};
    const { writers, out } = makeWriters();
    await runSessionsList({ client: client(recorded), json: true, writers });
    const parsed = JSON.parse(out.data) as { count: number };
    expect(parsed.count).toBe(1);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("sessions get", () => {
  it("forwards the session id and projectId", async () => {
    const recorded: Record<string, unknown[]> = {};
    const { writers } = makeWriters();
    await runSessionGet({
      client: client(recorded),
      json: true,
      writers,
      sessionId: "sess-abc",
      projectId: "p-1",
    });
    expect(recorded.getSession?.[0]).toBe("sess-abc");
    expect(recorded.getSession?.[1]).toEqual({ projectId: "p-1" });
  });

  it("renders the session summary with its traces", async () => {
    const recorded: Record<string, unknown[]> = {};
    const { writers, out } = makeWriters();
    await runSessionGet({
      client: client(recorded),
      json: false,
      writers,
      sessionId: "sess-abc",
    });
    expect(out.data).toContain("sess-abc");
    expect(out.data).toContain("t-1");
    expect(out.data).toContain("run-b");
  });

  it("emits the bare backend object under --json", async () => {
    const recorded: Record<string, unknown[]> = {};
    const { writers, out } = makeWriters();
    await runSessionGet({
      client: client(recorded),
      json: true,
      writers,
      sessionId: "sess-abc",
    });
    const parsed = JSON.parse(out.data) as { session_id: string };
    expect(parsed.session_id).toBe("sess-abc");
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });
});
