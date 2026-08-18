import type { Command } from "commander";
import type { ApiClient, ListSessionsParams } from "../../api/client.js";
import { type Writers, defaultWriters, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";
import { onceOption, parseLimit, renderRangeSummary, resolveTimeRange } from "../traces/list.js";

/** The no-filter range label for sessions (vs. traces' "all traces"). */
const ALL_SESSIONS = "all sessions";

/** Dependencies for the testable core of `sessions list`. */
export interface RunSessionsListDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  limit?: number;
  /** Search by session id, forwarded as `search_query`. */
  searchQuery?: string;
  /** ISO 8601 lower bound (inclusive) forwarded as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) forwarded as `end_before`. */
  endBefore?: string;
  /** Original `--since` string for the footer label (e.g. `"7d"`). */
  sinceLabel?: string;
  /** IANA timezone override for the human-local time display. */
  timeZone?: string;
  /** Target project (required by the server under user credentials). */
  projectId?: string;
}

/** Compact duration for the table, e.g. `5m0s` / `1.2s`; empty when unknown. */
function durationLabel(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return "";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/** Core, network-free logic for `sessions list`. Tests inject a fake client. */
export async function runSessionsList(deps: RunSessionsListDeps): Promise<void> {
  const { client, json, writers, limit, searchQuery, startAfter, endBefore, sinceLabel } = deps;
  const params: ListSessionsParams = {};
  if (limit !== undefined) {
    params.limit = limit;
  }
  if (searchQuery !== undefined) {
    params.searchQuery = searchQuery;
  }
  if (startAfter !== undefined) {
    params.startAfter = startAfter;
  }
  if (endBefore !== undefined) {
    params.endBefore = endBefore;
  }
  if (deps.projectId !== undefined) {
    params.projectId = deps.projectId;
  }
  const res = await client.listSessions(Object.keys(params).length > 0 ? params : undefined);

  if (json) {
    writeJson({ ...res, count: res.data.length }, writers);
    return;
  }

  // SESSION ID is last: it's the value to copy into `sessions get <id>`.
  const headers = ["STARTED", "DURATION", "TRACES", "USERS", "SESSION ID"];
  const rows = res.data.map((item) => [
    item.first_trace_time !== null ? formatTimestamp(item.first_trace_time, deps.timeZone) : "",
    durationLabel(item.duration_ms),
    String(item.trace_count),
    item.user_ids.join(", "),
    item.session_id,
  ]);

  const styler = createStyler(writers.out);
  writers.out.write(`${renderTable(headers, rows, { headerStyle: styler.bold })}\n`);

  const returned = res.data.length;
  const total = res.meta?.total;
  const countText =
    typeof total === "number" && total > returned
      ? `${returned} of ${total} session(s)`
      : `${returned} session(s)`;
  const effectiveLimit = res.meta?.limit ?? limit ?? 50;
  const rangeText = renderRangeSummary(
    { startAfter, endBefore, sinceLabel },
    deps.timeZone,
    ALL_SESSIONS,
  );
  logProgress(`${countText} | limit ${effectiveLimit} | ${rangeText}`, writers);
}

export function registerSessionsList(sessions: Command): void {
  sessions
    .command("list")
    .description("List sessions")
    .option("--limit <n>", "maximum number of sessions to return", onceOption("--limit"))
    .option("--search <query>", "search by session id", onceOption("--search"))
    .option(
      "--since <duration>",
      "only sessions with traces within a window ending now, e.g. 30m, 6h, 7d, 2w",
      onceOption("--since"),
    )
    .option(
      "--from <timestamp>",
      "include sessions with traces at or after this time (ISO 8601)",
      onceOption("--from"),
    )
    .option(
      "--to <timestamp>",
      "include sessions with traces before this time (exclusive, ISO 8601)",
      onceOption("--to"),
    )
    .action(async (_opts, command: Command) => {
      const opts = command.opts();
      const limit = parseLimit(opts.limit as string | undefined);
      const range = resolveTimeRange({
        since: opts.since as string | undefined,
        from: opts.from as string | undefined,
        to: opts.to as string | undefined,
      });
      const ctx = contextFromCommand(command);
      await runSessionsList({
        client: requireApiClient(ctx),
        json: ctx.json,
        writers: defaultWriters,
        limit,
        searchQuery: opts.search as string | undefined,
        startAfter: range.startAfter,
        endBefore: range.endBefore,
        sinceLabel: range.sinceLabel,
        projectId: ctx.auth.projectId.value,
      });
    });
}
