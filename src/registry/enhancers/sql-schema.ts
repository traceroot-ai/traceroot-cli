import type { Command } from "commander";
import type { SqlSchema } from "../../api/client.js";
import { type Writers, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { sanitize } from "./sql.js";
import type { Enhancer, RenderContext } from "./types.js";

export interface RenderSqlSchemaOptions {
  json: boolean;
  writers: Writers;
}

/** Network-free output core for `sql schema`: the schema is already fetched. */
export function renderSqlSchema(schema: SqlSchema, opts: RenderSqlSchemaOptions): void {
  const { writers } = opts;
  // Data only, like every other command: the table on stdout starts at its
  // header, and --json is the server's response unchanged. The schema itself
  // shows the payload columns are absent, so there is nothing to explain first.
  if (opts.json) {
    writeJson(schema, writers);
    return;
  }
  // Sanitized like the query's own output: these names are written to a
  // terminal, and nothing that reaches it is trusted to be free of escapes.
  const rows = schema.tables.flatMap((table) =>
    table.columns.map((column) => [table.name, column.name, column.type].map(sanitize)),
  );
  const rendered = renderTable(["TABLE", "COLUMN", "TYPE"], rows, {
    headerStyle: createStyler(writers.out).bold,
  });
  writers.out.write(`${rendered}\n`);
}

export const sqlSchema: Enhancer = {
  description: "List the tables and columns a SQL query may reference",
  // No flags: the project comes from the global --project, as for every other
  // command, rather than a second --project-id derived from the schema.
  flags(_cmd: Command): void {},
  render(payload: unknown, ctx: RenderContext): void {
    renderSqlSchema(payload as SqlSchema, { json: ctx.json, writers: ctx.writers });
  },
};
