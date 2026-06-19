import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import {
  CliError,
  type Writers,
  colorEnabled,
  defaultWriters,
  logProgress,
  writeJson,
} from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatDuration, formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

// Bright (not dark) red, matching the error-span color in `traces get`.
const ANSI_RED = "\x1b[91m";
const ANSI_RESET = "\x1b[0m";

/** Dependencies for the testable core of `traces list`. */
export interface RunListDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  limit?: number;
}

/**
 * Parses the raw `--limit` option value. Returns `undefined` when absent (so the
 * backend default applies) and throws a {@link CliError} for anything that is
 * not a positive integer.
 */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new CliError("--limit must be a positive integer");
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError("--limit must be a positive integer");
  }
  return value;
}

type ListItem = Awaited<ReturnType<ApiClient["listTraces"]>>["data"][number];

/**
 * A trace whose duration the backend hasn't finalized (`duration_ms` is null) is
 * treated as still running: its `DURATION` shows the elapsed time so far rather
 * than a final value.
 */
function isLiveItem(item: ListItem): boolean {
  return item.duration_ms === null;
}

function durationOf(item: ListItem): string {
  if (isLiveItem(item)) {
    const ms = Date.now() - new Date(item.trace_start_time).getTime();
    return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : "";
  }
  return formatDuration(item.duration_ms);
}

/** Core, network-free logic for `traces list`. Tests inject a fake client. */
export async function runList(deps: RunListDeps): Promise<void> {
  const { client, json, writers, limit } = deps;
  const res = await client.listTraces(limit !== undefined ? { limit } : undefined);

  if (json) {
    writeJson(res, writers);
    return;
  }

  const headers = ["STARTED", "DURATION", "NAME", "ERRORS", "SPANS", "TRACE ID"];
  const rows = res.data.map((item) => [
    formatTimestamp(item.trace_start_time),
    durationOf(item),
    item.name ?? "",
    String(item.error_count),
    String(item.span_count),
    item.trace_id,
  ]);

  const styler = createStyler(writers.out);
  // Whole-row bright red for errored traces (same red as error spans in `get`).
  const color = colorEnabled(writers.out);
  const rendered = renderTable(headers, rows, {
    headerStyle: styler.bold,
    rowStyle: (line, i) =>
      color && (res.data[i]?.error_count ?? 0) > 0 ? `${ANSI_RED}${line}${ANSI_RESET}` : line,
  });
  writers.out.write(`${rendered}\n`);
  logProgress(`${res.data.length} trace(s)`, writers);
}

export function registerTracesList(traces: Command): void {
  traces
    .command("list")
    .description("List traces")
    .option("--limit <n>", "maximum number of traces to return")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      const limit = parseLimit(command.opts().limit as string | undefined);
      await runList({ client, json: ctx.json, writers: defaultWriters, limit });
    });
}
