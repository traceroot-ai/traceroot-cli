import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { ApiClient, SqlQueryRequest } from "../../api/client.js";
import { CliError, type Writers, defaultWriters, logProgress, logWarn } from "../../output.js";
import { renderCsv } from "../../render/csv.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

export type SqlFormat = "table" | "json" | "csv";

const SQL_HELP_EXAMPLES = `
Examples:
  # count spans in the last 24h
  traceroot sql "SELECT count() AS spans_24h FROM spans WHERE span_start_time >= now() - INTERVAL 24 HOUR"

  # p95 latency by model
  traceroot sql "SELECT model_name, quantile(0.95)(duration_ms) AS p95_ms FROM spans WHERE model_name IS NOT NULL GROUP BY model_name ORDER BY p95_ms DESC"

  # cost by model
  traceroot sql "SELECT model_name, sum(cost) AS total_cost FROM spans GROUP BY model_name ORDER BY total_cost DESC"

  # export spans to CSV
  traceroot sql "SELECT * FROM spans WHERE span_start_time >= now() - INTERVAL 7 DAY" --csv --output spans.csv

  # find error spans
  traceroot sql "SELECT span_id, name, status_message FROM spans WHERE status = 'ERROR' ORDER BY span_start_time DESC LIMIT 100"

  # show the analytical export schema
  traceroot sql schema

Output modes: default table | --json (one JSON line) | --csv (RFC-4180). --output writes any mode to a file.`;

/**
 * Exactly one of positional/file. Reads the file (utf8) when given.
 * Throws CliError otherwise.
 */
export function resolveQuery(input: { positional?: string; file?: string }): string {
  const { positional, file } = input;
  if (positional === undefined && file === undefined) {
    throw new CliError("provide a query argument or --file");
  }
  if (positional !== undefined && file !== undefined) {
    throw new CliError("provide either a query argument or --file, not both");
  }
  let query: string;
  if (file !== undefined) {
    try {
      query = readFileSync(file, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(`could not read query file ${file}: ${message}`);
    }
  } else {
    query = positional as string;
  }
  if (query.trim().length === 0) {
    throw new CliError("the query is empty");
  }
  return query;
}

/** --json and --csv are mutually exclusive. Default is table. */
export function resolveFormat(opts: { json: boolean; csv: boolean }): SqlFormat {
  if (opts.json && opts.csv) {
    throw new CliError("--json and --csv cannot be combined");
  }
  if (opts.csv) {
    return "csv";
  }
  if (opts.json) {
    return "json";
  }
  return "table";
}

/**
 * Positive-integer parse for --max-rows; undefined when absent. Mirror
 * parseLimit in traces/list.ts.
 */
export function parseMaxRows(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new CliError("--max-rows must be a positive integer");
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError("--max-rows must be a positive integer");
  }
  return value;
}

export interface RunSqlQueryDeps {
  client: ApiClient;
  query: string;
  format: SqlFormat;
  maxRows?: number;
  outputPath?: string;
  writers: Writers;
}

/** Converts a single cell value to a string for table rendering. */
function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) {
    return "";
  }
  if (typeof cell === "string") {
    return cell;
  }
  if (typeof cell === "object") {
    return JSON.stringify(cell);
  }
  return String(cell);
}

/** Core logic for `sql` query. Tests inject a fake client. */
export async function runSqlQuery(deps: RunSqlQueryDeps): Promise<void> {
  const { client, query, format, maxRows, outputPath, writers } = deps;

  // 1. Build request body.
  const body: SqlQueryRequest = { query };
  if (maxRows !== undefined) {
    body.max_rows = maxRows;
  }

  // 2. Execute the query.
  const res = await client.sqlQuery(body);

  // 3. Build output string by format.
  let payload: string;
  if (format === "json") {
    payload = `${JSON.stringify(res)}\n`;
  } else if (format === "csv") {
    payload = renderCsv(
      res.columns.map((c) => c.name),
      res.rows,
    );
  } else {
    // table
    const rendered = renderTable(
      res.columns.map((c) => c.name),
      res.rows.map((row) => row.map(cellToString)),
      { headerStyle: createStyler(writers.out).bold },
    );
    payload = `${rendered}\n`;
  }

  // 4. Truncation warning (table and csv modes only; json is self-describing).
  if (format !== "json" && res.truncated) {
    logWarn(
      `result truncated to ${res.row_count} row(s); add a LIMIT to the query or raise --max-rows to see more`,
      writers,
    );
  }

  // 5. Output routing.
  if (outputPath !== undefined) {
    writeFileSync(outputPath, payload, "utf8");
    logProgress(`wrote ${format} output to ${outputPath}`, writers);
  } else {
    writers.out.write(payload);
  }
}

export function registerSqlQuery(sql: Command): void {
  sql
    .argument("[query]", "SQL query string (omit when using --file)")
    .option("-f, --file <path>", "read the query from a file instead of the positional arg")
    .option("--csv", "emit CSV output")
    .option("--output <file>", "write output to a file instead of stdout")
    .option("--max-rows <n>", "maximum number of rows to return (positive integer)")
    .addHelpText("after", SQL_HELP_EXAMPLES)
    .action(async (query: string | undefined, _opts, command: Command) => {
      const opts = command.optsWithGlobals();
      // Validate/resolve BEFORE requiring auth so arg errors surface without credentials.
      const queryText = resolveQuery({
        positional: query,
        file: opts.file as string | undefined,
      });
      const format = resolveFormat({ json: opts.json === true, csv: opts.csv === true });
      const maxRows = parseMaxRows(opts.maxRows as string | undefined);
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      await runSqlQuery({
        client,
        query: queryText,
        format,
        maxRows,
        outputPath: opts.output as string | undefined,
        writers: defaultWriters,
      });
    });
}
