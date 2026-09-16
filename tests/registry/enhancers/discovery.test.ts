import { describe, expect, it } from "vitest";
import type { Writers } from "../../../src/output.js";
import { renderProjectsList } from "../../../src/registry/enhancers/projects-list.js";
import { renderWorkspacesList } from "../../../src/registry/enhancers/workspaces-list.js";
import { StringSink } from "../../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

describe("workspaces list rendering", () => {
  const RES = { data: [{ id: "ws-1", name: "Alpha", role: "ADMIN" }] };

  it("keeps the columns 0.3.0 shipped, with the id last", () => {
    const { writers, out } = makeWriters();
    renderWorkspacesList(RES, { json: false, writers });
    // Exact order, not presence: a reorder of columns must fail this guard.
    const header = out.data
      .split("\n")[0]
      .trim()
      .split(/\s{2,}/);
    expect(header).toEqual(["NAME", "ROLE", "WORKSPACE ID"]);
  });

  it("renders the row's name, role, and id", () => {
    const { writers, out } = makeWriters();
    renderWorkspacesList(RES, { json: false, writers });
    expect(out.data).toContain("Alpha");
    expect(out.data).toContain("ADMIN");
    expect(out.data).toContain("ws-1");
  });

  it("counts in the footer", () => {
    const { writers, err } = makeWriters();
    renderWorkspacesList(RES, { json: false, writers });
    expect(err.data).toContain("1 workspace(s)");
  });

  it("emits one JSON document with a count", () => {
    const { writers, out } = makeWriters();
    renderWorkspacesList(RES, { json: true, writers });
    const parsed = JSON.parse(out.data) as { data: unknown[]; count: number };
    expect(parsed.count).toBe(1);
    expect(parsed.data).toHaveLength(1);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("projects list rendering", () => {
  const RES = {
    data: [{ id: "p-1", name: "Checkout", workspace_id: "ws-1", workspace_name: "Alpha" }],
  };

  it("keeps the columns 0.3.0 shipped, with the id last", () => {
    const { writers, out } = makeWriters();
    renderProjectsList(RES, { json: false, writers });
    const header = out.data
      .split("\n")[0]
      .trim()
      .split(/\s{2,}/);
    expect(header).toEqual(["NAME", "WORKSPACE", "PROJECT ID"]);
  });

  it("shows the workspace name and never the workspace id", () => {
    const { writers, out } = makeWriters();
    renderProjectsList(RES, { json: false, writers });
    expect(out.data).toContain("Alpha");
    expect(out.data).not.toContain("ws-1");
    expect(out.data).toContain("p-1");
  });

  it("counts in the footer", () => {
    const { writers, err } = makeWriters();
    renderProjectsList(RES, { json: false, writers });
    expect(err.data).toContain("1 project(s)");
    // Success output stays tip-free (guidance lives in --help and the
    // missing-project_id 400 hint), so the footer is just the count.
    expect(err.data).not.toContain("--project");
  });

  it("emits one JSON document with a count", () => {
    const { writers, out } = makeWriters();
    renderProjectsList(RES, { json: true, writers });
    const parsed = JSON.parse(out.data) as { data: unknown[]; count: number };
    expect(parsed.count).toBe(1);
    expect(parsed.data).toHaveLength(1);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });
});
