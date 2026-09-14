import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import type { Enhancer, RenderContext } from "./types.js";

interface WorkspaceListResponse {
  data: { id: string; name: string; role: string }[];
}

export interface RenderWorkspacesListOptions {
  json: boolean;
  writers: Writers;
}

/**
 * Preserves the columns the curated command shipped in 0.3.0. The default
 * renderer would emit `ID, NAME, ROLE` in schema order; the id belongs last
 * because it is the value a reader copies.
 */
export function renderWorkspacesList(
  res: WorkspaceListResponse,
  opts: RenderWorkspacesListOptions,
): void {
  const { json, writers } = opts;
  if (json) {
    writeJson({ ...res, count: res.data.length }, writers);
    return;
  }
  const headers = ["NAME", "ROLE", "WORKSPACE ID"];
  const rows = res.data.map((item) => [item.name, item.role, item.id]);
  const styler = createStyler(writers.out);
  writers.out.write(`${renderTable(headers, rows, { headerStyle: styler.bold })}\n`);
  logProgress(`${res.data.length} workspace(s)`, writers);
}

export const workspacesList: Enhancer = {
  description: "List the workspaces you can access (browser login required)",
  render(payload: unknown, ctx: RenderContext): void {
    renderWorkspacesList(payload as WorkspaceListResponse, {
      json: ctx.json,
      writers: ctx.writers,
    });
  },
};
