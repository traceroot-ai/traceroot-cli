import type { Command } from "commander";
import { registerSqlQuery } from "./sql/query.js";
import { registerSqlSchema } from "./sql/schema.js";

export function registerSql(program: Command): void {
  const sql = program
    .command("sql")
    .description("Run read-only SQL against your TraceRoot analytical export")
    .helpCommand(false);
  registerSqlSchema(sql);
  registerSqlQuery(sql);
}
