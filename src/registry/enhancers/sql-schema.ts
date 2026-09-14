import type { Command } from "commander";
import type { SqlSchema } from "../../api/client.js";
import { type Writers, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import type { Enhancer, RenderContext } from "./types.js";

/** Shown above the table, so nobody goes looking for payload columns. */
const PREAMBLE =
  "Analytical schema: the tables and columns a query may reference.\n" +
  "Span and trace input and output payloads are not queryable; exporting them may be offered separately later.";

/** Carried in `--json`, where the preamble would otherwise be lost. */
export const SCHEMA_NOTE =
  "Analytical schema. Span and trace input and output payloads are not queryable.";

export interface RenderSqlSchemaOptions {
  json: boolean;
  writers: Writers;
}

/** Network-free output core for `sql schema`: the schema is already fetched. */
export function renderSqlSchema(schema: SqlSchema, opts: RenderSqlSchemaOptions): void {
  const { writers } = opts;
  if (opts.json) {
    // Built as a plain object rather than typed as the response: `note` is the
    // CLI's addition, not a field the server sends.
    writeJson({ tables: schema.tables, note: SCHEMA_NOTE }, writers);
    return;
  }
  writers.out.write(`${PREAMBLE}\n\n`);
  const rows = schema.tables.flatMap((table) =>
    table.columns.map((column) => [table.name, column.name, column.type]),
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
