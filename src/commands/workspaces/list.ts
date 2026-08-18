import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { type Writers, defaultWriters, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

/** Dependencies for the testable core of `workspaces list`. */
export interface RunWorkspacesListDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
}

/** Core, network-free logic for `workspaces list`. Tests inject a fake client. */
export async function runWorkspacesList(deps: RunWorkspacesListDeps): Promise<void> {
  const { client, json, writers } = deps;
  const res = await client.listWorkspaces();

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

export function registerWorkspacesList(workspaces: Command): void {
  workspaces
    .command("list")
    .description("List the workspaces you can access (browser login required)")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      await runWorkspacesList({
        client: requireApiClient(ctx),
        json: ctx.json,
        writers: defaultWriters,
      });
    });
}
