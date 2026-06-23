import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import {
  CliError,
  type Writers,
  colorizeError,
  defaultWriters,
  logProgress,
  writeJson,
} from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatDuration, formatTimestamp, parseDuration } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

/** Dependencies for the testable core of `traces list`. */
export interface RunListDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  limit?: number;
  /** ISO 8601 lower bound (inclusive) forwarded as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) forwarded as `end_before`. */
  endBefore?: string;
}

/** Resolved, backend-ready ISO time bounds derived from the CLI time flags. */
export interface TimeRange {
  startAfter?: string;
  endBefore?: string;
}

/**
 * Treats a CLI-supplied timestamp as ISO 8601 and normalizes it to a UTC instant
 * string. A bare date (`2026-06-01`) becomes midnight UTC; a zone-less datetime
 * is interpreted as UTC. Throws a {@link CliError} when the value is not a
 * parseable timestamp.
 */
function normalizeTimestamp(raw: string, flag: string): string {
  const trimmed = raw.trim();
  let candidate: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    candidate = `${trimmed}T00:00:00Z`;
  } else if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    candidate = trimmed;
  } else {
    candidate = `${trimmed}Z`;
  }
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw new CliError(
      `${flag} must be an ISO 8601 timestamp, e.g. 2026-06-01 or 2026-06-01T13:00:00Z`,
    );
  }
  return date.toISOString();
}

/**
 * Resolves `--since`, `--from`, and `--to` into absolute ISO bounds. `--since
 * <dur>` is a window ending now, so it sets only `startAfter`; `--from`/`--to`
 * set the bounds directly. `--since` cannot be combined with `--from`/`--to`.
 * Returns an empty range when no flag is given. `now` is injectable for tests.
 */
export function resolveTimeRange(
  opts: { since?: string; from?: string; to?: string },
  now: () => number = Date.now,
): TimeRange {
  const { since, from, to } = opts;
  if (since !== undefined && (from !== undefined || to !== undefined)) {
    throw new CliError("--since cannot be combined with --from/--to");
  }
  if (since !== undefined) {
    const startAfter = new Date(now() - parseDuration(since));
    if (Number.isNaN(startAfter.getTime())) {
      throw new CliError(`--since ${since} is too large`);
    }
    return { startAfter: startAfter.toISOString() };
  }
  const range: TimeRange = {};
  if (from !== undefined) {
    range.startAfter = normalizeTimestamp(from, "--from");
  }
  if (to !== undefined) {
    range.endBefore = normalizeTimestamp(to, "--to");
  }
  if (
    range.startAfter !== undefined &&
    range.endBefore !== undefined &&
    range.startAfter >= range.endBefore
  ) {
    // Both are normalized ISO-8601 UTC strings, so lexical >= is chronological >=.
    throw new CliError("--from must be before --to");
  }
  return range;
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
  const { client, json, writers, limit, startAfter, endBefore } = deps;
  const params: { limit?: number; startAfter?: string; endBefore?: string } = {};
  if (limit !== undefined) {
    params.limit = limit;
  }
  if (startAfter !== undefined) {
    params.startAfter = startAfter;
  }
  if (endBefore !== undefined) {
    params.endBefore = endBefore;
  }
  const res = await client.listTraces(Object.keys(params).length > 0 ? params : undefined);

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
  // Whole-row bright red for errored traces, via the shared error-color helper.
  const rendered = renderTable(headers, rows, {
    headerStyle: styler.bold,
    rowStyle: (line, i) =>
      (res.data[i]?.error_count ?? 0) > 0 ? colorizeError(line, writers.out) : line,
  });
  writers.out.write(`${rendered}\n`);
  logProgress(`${res.data.length} trace(s)`, writers);

  // Effective-range footer (stderr only, keeps stdout clean for | jq).
  let rangeMsg: string;
  if (startAfter !== undefined && endBefore !== undefined) {
    rangeMsg = `Range: ${startAfter} <= started_at < ${endBefore}`;
  } else if (startAfter !== undefined) {
    rangeMsg = `Range: started_at >= ${startAfter}`;
  } else if (endBefore !== undefined) {
    rangeMsg = `Range: started_at < ${endBefore}`;
  } else {
    rangeMsg = "Range: all traces";
  }
  logProgress(rangeMsg, writers);

  // ISO copy-paste tip shown only when no time filter was applied.
  if (startAfter === undefined && endBefore === undefined) {
    logProgress(
      "Tip: displayed times are local; filter with --since 24h or --from/--to using ISO 8601, e.g. --from 2026-06-23T14:29:54Z",
      writers,
    );
  }
}

export function registerTracesList(traces: Command): void {
  traces
    .command("list")
    .description("List traces")
    .option("--limit <n>", "maximum number of traces to return")
    .option("--since <duration>", "only traces within a window ending now, e.g. 30m, 6h, 7d, 2w")
    .option(
      "--from <timestamp>",
      "only traces at or after this ISO 8601 time, e.g. 2026-06-23T14:29:54Z (inclusive)",
    )
    .option(
      "--to <timestamp>",
      "only traces before this ISO 8601 time, e.g. 2026-06-23T14:29:54-06:00 (exclusive)",
    )
    .action(async (_opts, command: Command) => {
      // 1. Reject stray positional operands FIRST (before any API call).
      //    This catches split local timestamps, e.g.: --from 2026-06-23 14:29:54 MDT
      if (command.args.length > 0) {
        const joined = command.args.join(" ");
        throw new CliError(
          `unexpected argument(s): ${joined}. 'traces list' takes no positional arguments. If you meant a time filter, --from/--to take a single ISO 8601 timestamp with no spaces, e.g. --from 2026-06-23T14:29:54Z (or with an offset, 2026-06-23T14:29:54-06:00).`,
        );
      }
      const opts = command.opts();
      // 2. Validate --limit.
      const limit = parseLimit(opts.limit as string | undefined);
      // 3. Resolve time range.
      const range = resolveTimeRange({
        since: opts.since as string | undefined,
        from: opts.from as string | undefined,
        to: opts.to as string | undefined,
      });
      // 4. Require auth context and API client.
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      // 5. Run the list.
      await runList({
        client,
        json: ctx.json,
        writers: defaultWriters,
        limit,
        startAfter: range.startAfter,
        endBefore: range.endBefore,
      });
    });
}
