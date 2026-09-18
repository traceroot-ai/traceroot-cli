import { readFileSync, writeFileSync } from "node:fs";
import { REGISTRY } from "@traceroot-ai/tools";
import type { Command } from "commander";
import type { SqlResult } from "../../api/client.js";
import { CliError, ExitCode, type Writers, logProgress, logWarn } from "../../output.js";
import { renderCsv } from "../../render/csv.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { onceOption } from "../flags.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

const EXAMPLES = `
Examples:
  # spans in the last 24 hours
  traceroot sql "SELECT count() AS spans FROM spans WHERE span_start_time >= now() - INTERVAL 1 DAY"

  # p95 latency by model
  traceroot sql "SELECT model_name, quantile(0.95)(duration_ms) AS p95_ms FROM spans WHERE model_name IS NOT NULL GROUP BY model_name ORDER BY p95_ms DESC"

  # cost by model over the last week
  traceroot sql "SELECT model_name, sum(cost) AS total_cost FROM spans WHERE span_start_time >= now() - INTERVAL 7 DAY GROUP BY model_name ORDER BY total_cost DESC"

  # recent error spans, written to a CSV file
  traceroot sql "SELECT span_id, name, status_message FROM spans WHERE status = 'ERROR' ORDER BY span_start_time DESC LIMIT 100" --csv --output errors.csv

  # list the tables and columns a query may use
  traceroot sql schema

  # a bound parameter, and a query read from a file
  traceroot sql "SELECT name, duration_ms FROM spans WHERE duration_ms > {min_ms:Int64} LIMIT 20" --param min_ms=5000
  traceroot sql --file slow_spans.sql

Output is a table by default, one JSON document with --json, or CSV with --csv.
--output writes any of them to a file instead of stdout.`;

/** What the server accepts as a placeholder name. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// C0 and C1 control characters, ESC included. Trace data is caller-authored, so
// a table cell must not be able to move the cursor or restyle the terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the intent.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const maxRowsSchema = REGISTRY.find((entry) => entry.name === "run_sql")?.inputSchema.properties
  .max_rows;

/** Output choices threaded from `resolveArgs` to `render`. */
interface SqlState {
  csv: boolean;
  output?: string;
}

/** Exactly one of a query argument or `--file`, read and checked for content. */
export function resolveQuery(extras: string[], file: string | undefined): string {
  if (extras.length > 1) {
    throw new CliError(
      `expected one query argument but got ${extras.length}; quote the whole query, e.g. traceroot sql "SELECT count() FROM spans"`,
      ExitCode.usage,
    );
  }
  const positional = extras[0];
  if (positional !== undefined && file !== undefined) {
    throw new CliError("provide either a query argument or --file, not both", ExitCode.usage);
  }
  if (positional === undefined && file === undefined) {
    throw new CliError("provide a query argument or --file <path>", ExitCode.usage);
  }
  let query: string;
  if (file !== undefined) {
    try {
      query = readFileSync(file, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(`could not read query file ${file}: ${message}`, ExitCode.usage);
    }
  } else {
    query = positional as string;
  }
  if (query.trim() === "") {
    throw new CliError("the query is empty", ExitCode.usage);
  }
  return query;
}

/** `--max-rows` as a whole number inside the operation's published bounds. */
export function parseMaxRows(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new CliError("--max-rows must be a positive whole number", ExitCode.usage);
  }
  const value = Number.parseInt(raw, 10);
  const minimum = typeof maxRowsSchema?.minimum === "number" ? maxRowsSchema.minimum : 1;
  if (value < minimum) {
    throw new CliError(`--max-rows must be at least ${minimum}`, ExitCode.usage);
  }
  if (typeof maxRowsSchema?.maximum === "number" && value > maxRowsSchema.maximum) {
    throw new CliError(`--max-rows must be at most ${maxRowsSchema.maximum}`, ExitCode.usage);
  }
  return value;
}

/**
 * Collects repeated `--param name=value` flags. Values stay strings: the server
 * binds each one against the type its `{name:Type}` placeholder declares. A Map
 * keeps a name like `__proto__` an ordinary key.
 */
export function collectParam(
  raw: string,
  previous: Map<string, string> | undefined,
): Map<string, string> {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new CliError(`--param expects name=value, got '${raw}'`, ExitCode.usage);
  }
  const name = raw.slice(0, separator);
  if (!PARAM_NAME.test(name)) {
    throw new CliError(
      `--param name '${name}' must start with a letter or underscore and contain only letters, digits and underscores`,
      ExitCode.usage,
    );
  }
  const params = new Map(previous ?? []);
  if (params.has(name)) {
    throw new CliError(`--param ${name} may only be given once`, ExitCode.usage);
  }
  params.set(name, raw.slice(separator + 1));
  return params;
}

function tableCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(CONTROL_CHARS, (ch) => JSON.stringify(ch).slice(1, -1));
}

export interface RenderSqlOptions {
  json: boolean;
  csv: boolean;
  output?: string;
  writers: Writers;
}

/** Network-free output core for `sql`: the result is already fetched. */
export function renderSqlResult(result: SqlResult, opts: RenderSqlOptions): void {
  const { writers } = opts;
  const names = result.columns.map((column) => column.name);
  let text: string;
  if (opts.json) {
    text = `${JSON.stringify(result)}\n`;
  } else if (opts.csv) {
    text = renderCsv(names, result.rows);
  } else {
    // A file gets no ANSI styling, whatever the terminal supports.
    const headerStyle =
      opts.output === undefined ? createStyler(writers.out).bold : (line: string) => line;
    const rows = result.rows.map((row) => names.map((_, col) => tableCell(row[col])));
    text = `${renderTable(names, rows, { headerStyle })}\n`;
  }

  if (opts.output !== undefined) {
    try {
      writeFileSync(opts.output, text, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(`could not write ${opts.output}: ${message}`);
    }
    logProgress(`wrote ${result.row_count} row(s) to ${opts.output}`, writers);
  } else {
    writers.out.write(text);
    if (!opts.json && !opts.csv) {
      logProgress(`${result.row_count} row(s) in ${result.elapsed_ms} ms`, writers);
    }
  }

  // JSON carries `truncated` itself; the other formats would silently lose it.
  if (!opts.json && result.truncated) {
    logWarn(
      `result truncated to ${result.row_count} row(s); narrow the query or raise --max-rows`,
      writers,
    );
  }
}

export const sql: Enhancer = {
  description: "Run a read-only SQL query over your project's spans and traces",
  flags(cmd: Command): void {
    cmd
      .usage("[options] [query]")
      .option("-f, --file <path>", "read the query from a file", onceOption("--file"))
      .option(
        "--param <name=value>",
        "bind a value to a {name:Type} placeholder in the query (repeatable)",
        collectParam,
      )
      .option(
        "--max-rows <n>",
        "most rows to return; the server lowers it to its own ceiling",
        onceOption("--max-rows"),
      )
      .option("--csv", "emit CSV instead of a table")
      .option(
        "--output <file>",
        "write the result to a file instead of stdout",
        onceOption("--output"),
      )
      .addHelpText("after", EXAMPLES);
  },
  // `traceroot sql` on its own is someone asking what the command does, not a
  // query that forgot its text, so it gets the help every other command gives.
  helpWhenBare: (input: ResolveInput) => input.extras.length === 0 && input.opts.file === undefined,
  resolveArgs(input: ResolveInput): Resolved {
    const csv = input.opts.csv === true;
    if (csv && input.json === true) {
      throw new CliError("--json and --csv cannot be combined", ExitCode.usage);
    }
    const args: Record<string, unknown> = {
      query: resolveQuery(input.extras, input.opts.file as string | undefined),
    };
    const maxRows = parseMaxRows(input.opts.maxRows as string | undefined);
    if (maxRows !== undefined) args.max_rows = maxRows;
    const params = input.opts.param as Map<string, string> | undefined;
    if (params !== undefined) args.parameters = Object.fromEntries(params);
    const state: SqlState = { csv, output: input.opts.output as string | undefined };
    return { args, state };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const state = ctx.state as SqlState;
    renderSqlResult(payload as SqlResult, {
      json: ctx.json,
      csv: state.csv,
      output: state.output,
      writers: ctx.writers,
    });
  },
};
