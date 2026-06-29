import type { Command } from "commander";
import { registerSqlQuery } from "./sql/query.js";

export function registerSql(program: Command): void {
  const sql = program
    .command("sql")
    .description("Run read-only SQL against your TraceRoot analytical export")
    .helpCommand(false);
  // NOTE: registerSqlSchema(sql) will be inserted here by the schema task,
  // immediately above registerSqlQuery, so `traceroot sql schema` resolves
  // as a subcommand before the default query action is evaluated.
  registerSqlQuery(sql);
}
