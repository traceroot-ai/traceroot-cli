import { describe, expect, it } from "vitest";
import type { ApiClient, ProjectList, WorkspaceList } from "../../src/api/client.js";
import { runProjectsList } from "../../src/commands/projects/list.js";
import { runWorkspacesList } from "../../src/commands/workspaces/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const WORKSPACES: WorkspaceList = {
  data: [
    { id: "ws-1", name: "Alpha", role: "admin" },
    { id: "ws-2", name: "Beta", role: "member" },
  ],
} as WorkspaceList;

const PROJECTS: ProjectList = {
  data: [
    { id: "p-1", name: "Checkout", workspace_id: "ws-1", workspace_name: "Alpha" },
    { id: "p-2", name: "Search", workspace_id: "ws-2", workspace_name: "Beta" },
  ],
} as ProjectList;

function client(hooks: Partial<Record<"listWorkspaces" | "listProjects", unknown>>): ApiClient {
  return {
    listWorkspaces: () => Promise.resolve(hooks.listWorkspaces ?? WORKSPACES),
    listProjects: (params?: unknown) => {
      (hooks as Record<string, unknown>).lastProjectsParams = params;
      return Promise.resolve(hooks.listProjects ?? PROJECTS);
    },
  } as unknown as ApiClient;
}

describe("workspaces list", () => {
  it("renders a table with name, role, and id", async () => {
    const { writers, out } = makeWriters();
    await runWorkspacesList({ client: client({}), json: false, writers });
    expect(out.data).toContain("Alpha");
    expect(out.data).toContain("admin");
    expect(out.data).toContain("ws-1");
    expect(out.data).toContain("Beta");
  });

  it("emits one JSON document with a count", async () => {
    const { writers, out } = makeWriters();
    await runWorkspacesList({ client: client({}), json: true, writers });
    const parsed = JSON.parse(out.data) as { data: unknown[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.data).toHaveLength(2);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("projects list", () => {
  it("renders a table with project, workspace, and id, plus a count-only footer", async () => {
    const { writers, out, err } = makeWriters();
    await runProjectsList({ client: client({}), json: false, writers });
    expect(out.data).toContain("Checkout");
    expect(out.data).toContain("Alpha");
    expect(out.data).toContain("p-1");
    // Success output stays tip-free (guidance lives in --help and the
    // missing-project_id 400 hint), so the footer is just the count.
    expect(err.data).toContain("2 project(s)");
    expect(err.data).not.toContain("--project");
  });

  it("forwards the workspace filter", async () => {
    const hooks: Record<string, unknown> = {};
    const { writers } = makeWriters();
    await runProjectsList({
      client: client(hooks),
      json: true,
      writers,
      workspaceId: "ws-1",
    });
    expect(hooks.lastProjectsParams).toEqual({ workspaceId: "ws-1" });
  });

  it("emits one JSON document with a count", async () => {
    const { writers, out } = makeWriters();
    await runProjectsList({ client: client({}), json: true, writers });
    const parsed = JSON.parse(out.data) as { data: unknown[]; count: number };
    expect(parsed.count).toBe(2);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });
});
