import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { type Writers, defaultWriters, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

/** Dependencies for the testable core of `projects list`. */
export interface RunProjectsListDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
}

/** Core, network-free logic for `projects list`. Tests inject a fake client. */
export async function runProjectsList(deps: RunProjectsListDeps): Promise<void> {
  const { client, json, writers } = deps;
  // Deliberately unfiltered: the flow is "list, copy a PROJECT ID, --project it"
  // — the WORKSPACE column disambiguates, and no step needs a workspace id.
  const res = await client.listProjects();

  if (json) {
    writeJson({ ...res, count: res.data.length }, writers);
    return;
  }

  const headers = ["NAME", "WORKSPACE", "PROJECT ID"];
  const rows = res.data.map((item) => [item.name, item.workspace_name, item.id]);

  const styler = createStyler(writers.out);
  writers.out.write(`${renderTable(headers, rows, { headerStyle: styler.bold })}\n`);
  // No --project tip here: guidance lives in --help, the README, and the
  // missing-project_id 400 hint — not in normal success output.
  logProgress(`${res.data.length} project(s)`, writers);
}

export function registerProjectsList(projects: Command): void {
  projects
    .command("list")
    .description(
      "List the projects you can access (browser login required); pass a PROJECT ID to --project to scope reads",
    )
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      await runProjectsList({
        client: requireApiClient(ctx),
        json: ctx.json,
        writers: defaultWriters,
      });
    });
}
