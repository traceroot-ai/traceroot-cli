import type { Command } from "commander";
import type { TraceList } from "../../api/client.js";
import { type Writers, colorizeError } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatDuration, formatTimestamp, parseBackendTime } from "../../util/index.js";
import {
  type ListState,
  addListTimeFlags,
  logListFooter,
  rejectListExtras,
  resolveListArgs,
  writeListJson,
} from "./list-shared.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

type ListItem = TraceList["data"][number];

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
    // trace_start_time is zone-less UTC, so parse it as UTC (not host-local) or
    // the elapsed math goes negative west of UTC and inflates east of it.
    const start = parseBackendTime(item.trace_start_time);
    const ms = start ? Date.now() - start.getTime() : Number.NaN;
    return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : "";
  }
  return formatDuration(item.duration_ms);
}

/** Options for the testable, network-free rendering core of `traces list`. */
export interface RenderListOptions {
  json: boolean;
  writers: Writers;
  limit?: number;
  /** ISO 8601 lower bound (inclusive) forwarded as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) forwarded as `end_before`. */
  endBefore?: string;
  /** Original `--since` string for the footer label (e.g. `"2m"`). */
  sinceLabel?: string;
  /**
   * IANA timezone override for the footer's human-local time display.
   * Defaults to the system local zone. Tests inject `"America/Denver"` etc.
   * for deterministic output.
   */
  timeZone?: string;
}

/**
 * Core, network-free rendering logic for `traces list`. The trace list itself
 * is fetched by the factory before `render` runs, so this operates on an
 * already-fetched response.
 */
export function renderList(res: TraceList, opts: RenderListOptions): void {
  const { json, writers, limit, startAfter, endBefore, sinceLabel, timeZone } = opts;
  const state: ListState = { limit, startAfter, endBefore, sinceLabel };

  if (json) {
    writeListJson(res, state, writers);
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

  // Compact one-line footer. Copy/paste guidance lives in `--help`, the README,
  // and the bad-timestamp errors — not in normal success output, where a
  // repeated tip is just noise. `meta.page` is intentionally NOT surfaced:
  // the CLI has no pagination controls today (it would gain a `--page`/
  // `--cursor` flag as future work).
  logListFooter(res, state, "trace", writers, timeZone);
}

export const tracesList: Enhancer = {
  description: "List traces",
  flags(cmd: Command): void {
    addListTimeFlags(cmd, {
      noun: "traces",
      sinceSubject: "traces",
      boundSubject: "traces started",
      column: "STARTED",
    });
  },
  resolveArgs(input: ResolveInput): Resolved {
    // Reject stray positional operands FIRST (before any API call) — this
    // catches split local timestamps, e.g.: --from 2026-06-23 14:29:54 MDT
    rejectListExtras("traces list", input);
    return resolveListArgs(input);
  },
  render(payload: unknown, ctx: RenderContext): void {
    const state = ctx.state as ListState;
    renderList(payload as TraceList, {
      json: ctx.json,
      writers: ctx.writers,
      limit: state.limit,
      startAfter: state.startAfter,
      endBefore: state.endBefore,
      sinceLabel: state.sinceLabel,
    });
  },
};
