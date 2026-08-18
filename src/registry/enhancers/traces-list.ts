import type { Command } from "commander";
import type { TraceList } from "../../api/client.js";
import {
  CliError,
  ExitCode,
  type Writers,
  colorizeError,
  logProgress,
  writeJson,
} from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import {
  buildRangeText,
  parseLimit,
  renderRangeSummary,
  resolveTimeRange,
} from "../../time/range.js";
import { formatDuration, formatTimestamp, parseBackendTime } from "../../util/index.js";
import { onceOption } from "../flags.js";
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

  if (json) {
    const rangeInfo = { startAfter, endBefore, sinceLabel };
    writeJson(
      {
        ...res,
        count: res.data.length,
        range: {
          label: buildRangeText(rangeInfo, (iso) => iso),
          startAfter: startAfter ?? null,
          endBefore: endBefore ?? null,
        },
      },
      writers,
    );
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

  // Compact one-line footer: "<count> trace(s) | limit <N> | <range>". Copy/paste
  // guidance lives in `--help`, the README, and the bad-timestamp errors — not in
  // normal success output, where a repeated tip is just noise. `meta.page` is
  // intentionally NOT surfaced here: the CLI has no pagination controls today
  // (it would gain a `--page`/`--cursor` flag as future work).
  const returned = res.data.length;
  const total = res.meta?.total;
  const countText =
    typeof total === "number" && total > returned
      ? `${returned} of ${total} trace(s)`
      : `${returned} trace(s)`;
  const effectiveLimit = res.meta?.limit ?? limit ?? 50;
  const rangeText = renderRangeSummary({ startAfter, endBefore, sinceLabel }, timeZone);
  logProgress(`${countText} | limit ${effectiveLimit} | ${rangeText}`, writers);
}

/** State threaded from `resolveArgs` to `render`. */
interface ListState {
  limit?: number;
  startAfter?: string;
  endBefore?: string;
  sinceLabel?: string;
}

export const tracesList: Enhancer = {
  description: "List traces",
  flags(cmd: Command): void {
    cmd
      .option("--limit <n>", "maximum number of traces to return", onceOption("--limit"))
      .option(
        "--since <duration>",
        "only traces within a window ending now, e.g. 30m, 6h, 7d, 2w",
        onceOption("--since"),
      )
      .option(
        "--from <timestamp>",
        'include traces started at or after this time. Accepts ISO 8601 (e.g. 2026-06-23T14:31:02Z or 2026-06-23T14:31:02-06:00) or a quoted copied STARTED value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.',
        onceOption("--from"),
      )
      .option(
        "--to <timestamp>",
        'include traces started before this time (exclusive). Accepts ISO 8601 (e.g. 2026-06-23T20:31:02Z) or a quoted copied STARTED value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.',
        onceOption("--to"),
      );
  },
  resolveArgs(input: ResolveInput): Resolved {
    // 1. Reject stray positional operands FIRST (before any API call).
    //    This catches split local timestamps, e.g.: --from 2026-06-23 14:29:54 MDT
    if (input.extras.length > 0) {
      const strayJoined = input.extras.join(" ");
      const fromVal = input.opts.from as string | undefined;
      const toVal = input.opts.to as string | undefined;
      const bareDate = /^\d{4}-\d{2}-\d{2}$/;

      if (fromVal !== undefined && bareDate.test(fromVal)) {
        // Looks like the user forgot to quote: --from 2026-06-23 14:31:02 MDT
        const reconstructed = `${fromVal} ${strayJoined}`;
        throw new CliError(
          `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot traces list --from "${reconstructed}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot traces list --from 2026-06-23T20:31:02Z\n  traceroot traces list --from 2026-06-23T14:31:02-06:00`,
          ExitCode.usage,
        );
      }
      if (toVal !== undefined && bareDate.test(toVal)) {
        const reconstructed = `${toVal} ${strayJoined}`;
        throw new CliError(
          `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot traces list --to "${reconstructed}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot traces list --to 2026-06-23T20:31:02Z\n  traceroot traces list --to 2026-06-23T14:31:02-06:00`,
          ExitCode.usage,
        );
      }
      throw new CliError(
        `unexpected argument(s): ${strayJoined}. 'traces list' takes no positional arguments. If you meant a time filter, --from/--to take a single ISO 8601 timestamp with no spaces, e.g. --from 2026-06-23T14:29:54Z (or with an offset, 2026-06-23T14:29:54-06:00).`,
        ExitCode.usage,
      );
    }
    // 2. Validate --limit.
    const limit = parseLimit(input.opts.limit as string | undefined);
    // 3. Resolve time range.
    const range = resolveTimeRange({
      since: input.opts.since as string | undefined,
      from: input.opts.from as string | undefined,
      to: input.opts.to as string | undefined,
    });
    return {
      args: {
        ...(limit !== undefined ? { limit } : {}),
        ...(range.startAfter !== undefined ? { start_after: range.startAfter } : {}),
        ...(range.endBefore !== undefined ? { end_before: range.endBefore } : {}),
      },
      state: { limit, ...range },
    };
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
