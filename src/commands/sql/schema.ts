import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { type Writers, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

// Human preamble (default output). Mentions blobs excluded + neutral future opt-in (NO flag name).
const SCHEMA_PREAMBLE =
  "Analytical export schema. input/output/metadata blobs excluded from MVP.\n" +
  "Raw blob export may be offered as an opt-in in the future.";
// JSON note (exact string required by spec).
const SCHEMA_NOTE = "Analytical export schema. input/output/metadata blobs excluded from MVP.";

export interface RunSqlSchemaDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
}

/** Core logic for `sql schema`. Tests inject a fake client. */
export async function runSqlSchema(deps: RunSqlSchemaDeps): Promise<void> {
  const schema = await deps.client.sqlSchema();

  if (deps.json) {
    // Build explicitly — NOT typed as SqlSchemaResponse — to include the note field.
    const out = { tables: schema.tables, note: SCHEMA_NOTE };
    writeJson(out, deps.writers);
    return;
  }

  // Default: preamble then a 3-column table.
  deps.writers.out.write(`${SCHEMA_PREAMBLE}\n\n`);
  const rows = schema.tables.flatMap((t) => t.columns.map((c) => [t.name, c.name, c.type]));
  const rendered = renderTable(["TABLE", "COLUMN", "TYPE"], rows, {
    headerStyle: createStyler(deps.writers.out).bold,
  });
  deps.writers.out.write(`${rendered}\n`);
}

export function registerSqlSchema(sql: Command): void {
  sql
    .command("schema")
    .description("Show the curated analytical export schema (tables, columns, types)")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      await runSqlSchema({ client, json: ctx.json, writers: defaultWriters });
    });
}
