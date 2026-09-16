import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import type { Enhancer, RenderContext } from "./types.js";

interface ProjectListResponse {
  data: { id: string; name: string; workspace_id: string; workspace_name: string }[];
}

export interface RenderProjectsListOptions {
  json: boolean;
  writers: Writers;
}

/**
 * Preserves the columns the curated command shipped in 0.3.0: PROJECT ID last
 * as the copy target for --project, and workspace_id deliberately omitted —
 * nothing consumes a workspace id now that --workspace is gone.
 */
export function renderProjectsList(
  res: ProjectListResponse,
  opts: RenderProjectsListOptions,
): void {
  const { json, writers } = opts;
  if (json) {
    writeJson({ ...res, count: res.data.length }, writers);
    return;
  }
  const headers = ["NAME", "WORKSPACE", "PROJECT ID"];
  const rows = res.data.map((item) => [item.name, item.workspace_name, item.id]);
  const styler = createStyler(writers.out);
  writers.out.write(`${renderTable(headers, rows, { headerStyle: styler.bold })}\n`);
  logProgress(`${res.data.length} project(s)`, writers);
}

export const projectsList: Enhancer = {
  description:
    "List the projects you can access (browser login required); pass a PROJECT ID to --project to scope reads",
  render(payload: unknown, ctx: RenderContext): void {
    renderProjectsList(payload as ProjectListResponse, { json: ctx.json, writers: ctx.writers });
  },
};
