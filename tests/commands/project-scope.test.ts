import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client.js";
import { runDetectors } from "../../src/commands/detectors/list.js";
import { runGet as runFindingGet } from "../../src/commands/findings/get.js";
import { runFindings } from "../../src/commands/findings/list.js";
import { runGet as runTraceGet } from "../../src/commands/traces/get.js";
import { runList as runTracesList } from "../../src/commands/traces/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): Writers {
  return { out: new StringSink(), err: new StringSink() };
}

/**
 * A recording client: every method resolves a minimal-but-valid body and
 * records its (args) so threading assertions stay call-shaped, not rendered.
 */
function recordingClient(recorded: Record<string, unknown[]>): ApiClient {
  const record =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      recorded[name] = args;
      return Promise.resolve(result);
    };
  return {
    whoami: record("whoami", {}),
    listTraces: record("listTraces", { data: [], meta: { total: 0, limit: 50 } }),
    getTrace: record("getTrace", { trace_id: "t-1", spans: [] }),
    exportTrace: record("exportTrace", {}),
    traceFilterValues: record("traceFilterValues", { field: "name", values: [] }),
    listDetectors: record("listDetectors", { data: [], meta: { total: 0, limit: 50 } }),
    listFindings: record("listFindings", { data: [], meta: { total: 0, limit: 50 } }),
    getFinding: record("getFinding", { finding_id: "f-1" }),
    getFindingByTrace: record("getFindingByTrace", { finding_id: "f-1" }),
    findFindingByTrace: record("findFindingByTrace", null),
    listWorkspaces: record("listWorkspaces", { data: [] }),
    listProjects: record("listProjects", { data: [] }),
    listSessions: record("listSessions", { data: [], meta: { total: 0, limit: 50 } }),
    getSession: record("getSession", { session_id: "s-1", trace_count: 0 }),
  } as unknown as ApiClient;
}

describe("project scope threading", () => {
  it("traces list forwards projectId and the new filter params", async () => {
    const recorded: Record<string, unknown[]> = {};
    await runTracesList({
      client: recordingClient(recorded),
      json: true,
      writers: makeWriters(),
      projectId: "p-1",
      name: "checkout",
      userId: "u-9",
      searchQuery: "abc",
      filters: "[]",
      includeEvaluations: true,
    });
    expect(recorded.listTraces?.[0]).toEqual({
      projectId: "p-1",
      name: "checkout",
      userId: "u-9",
      searchQuery: "abc",
      filters: "[]",
      includeEvaluations: true,
    });
  });

  it("traces get forwards projectId on the trace and finding lookups", async () => {
    const recorded: Record<string, unknown[]> = {};
    await runTraceGet({
      client: recordingClient(recorded),
      json: true,
      writers: makeWriters(),
      traceId: "t-1",
      projectId: "p-1",
    });
    expect(recorded.getTrace?.[1]).toMatchObject({ projectId: "p-1" });
  });

  it("detectors list forwards projectId", async () => {
    const recorded: Record<string, unknown[]> = {};
    await runDetectors({
      client: recordingClient(recorded),
      json: true,
      writers: makeWriters(),
      projectId: "p-1",
    });
    expect(recorded.listDetectors?.[0]).toEqual({ projectId: "p-1" });
  });

  it("findings list forwards projectId", async () => {
    const recorded: Record<string, unknown[]> = {};
    await runFindings({
      client: recordingClient(recorded),
      json: true,
      writers: makeWriters(),
      projectId: "p-1",
    });
    expect(recorded.listFindings?.[0]).toEqual({ projectId: "p-1" });
  });

  it("findings get forwards projectId on both lookup shapes", async () => {
    const byId: Record<string, unknown[]> = {};
    await runFindingGet({
      client: recordingClient(byId),
      json: true,
      writers: makeWriters(),
      findingId: "f-1",
      projectId: "p-1",
    });
    expect(byId.getFinding?.[1]).toEqual({ projectId: "p-1" });

    const byTrace: Record<string, unknown[]> = {};
    await runFindingGet({
      client: recordingClient(byTrace),
      json: true,
      writers: makeWriters(),
      traceId: "t-1",
      projectId: "p-1",
    });
    expect(byTrace.getFindingByTrace?.[1]).toEqual({ projectId: "p-1" });
  });
});
