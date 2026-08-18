import type { Command } from "commander";
import type { FindingList } from "../../api/client.js";
import { CliError, ExitCode, type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import {
  buildRangeText,
  parseLimit,
  renderRangeSummary,
  resolveTimeRange,
} from "../../time/range.js";
import { formatTimestamp } from "../../util/index.js";
import { onceOption } from "../flags.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

/** The no-filter range label for findings (vs. traces' "all traces"). */
const ALL_FINDINGS = "all findings";

/** Options for the testable, network-free rendering core of `findings list`. */
export interface RenderFindingsOptions {
  json: boolean;
  writers: Writers;
  limit?: number;
  /** ISO 8601 lower bound (inclusive) on creation time, forwarded as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) on creation time, forwarded as `end_before`. */
  endBefore?: string;
  /** Original `--since` string for the footer label (e.g. `"24h"`). */
  sinceLabel?: string;
  /** IANA timezone override for the human-local time display. */
  timeZone?: string;
}

/**
 * Core, network-free rendering logic for `findings list`. The finding list
 * itself is fetched by the factory before `render` runs, so this operates on
 * an already-fetched response.
 */
export function renderFindings(res: FindingList, opts: RenderFindingsOptions): void {
  const { json, writers, limit, startAfter, endBefore, sinceLabel, timeZone } = opts;

  if (json) {
    writeJson(
      {
        ...res,
        count: res.data.length,
        range: {
          label: buildRangeText({ startAfter, endBefore, sinceLabel }, (iso) => iso, ALL_FINDINGS),
          startAfter: startAfter ?? null,
          endBefore: endBefore ?? null,
        },
      },
      writers,
    );
    return;
  }

  const headers = ["TIME", "FINDING ID", "TRACE ID", "DETECTOR NAME"];
  const rows = res.data.map((item) => [
    formatTimestamp(item.timestamp, timeZone),
    item.finding_id,
    item.trace_id,
    item.detectors.join(","),
  ]);

  const styler = createStyler(writers.out);
  const rendered = renderTable(headers, rows, { headerStyle: styler.bold });
  writers.out.write(`${rendered}\n`);

  // Footer: "<count> finding(s) | limit <N> | <range>"
  const returned = res.data.length;
  const total = res.meta?.total;
  const countText =
    typeof total === "number" && total > returned
      ? `${returned} of ${total} finding(s)`
      : `${returned} finding(s)`;
  const effectiveLimit = res.meta?.limit ?? limit ?? 50;
  const rangeText = renderRangeSummary(
    { startAfter, endBefore, sinceLabel },
    timeZone,
    ALL_FINDINGS,
  );
  logProgress(`${countText} | limit ${effectiveLimit} | ${rangeText}`, writers);
}

/** State threaded from `resolveArgs` to `render`. */
interface ListState {
  limit?: number;
  startAfter?: string;
  endBefore?: string;
  sinceLabel?: string;
}

export const findingsList: Enhancer = {
  description: "List detector findings",
  flags(cmd: Command): void {
    cmd
      .option("--limit <n>", "maximum number of findings to return", onceOption("--limit"))
      .option(
        "--since <duration>",
        "only findings within a window ending now, e.g. 30m, 6h, 7d, 2w",
        onceOption("--since"),
      )
      .option(
        "--from <timestamp>",
        'include findings at or after this time. Accepts ISO 8601 (e.g. 2026-06-23T14:31:02Z or 2026-06-23T14:31:02-06:00) or a quoted copied TIME value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.',
        onceOption("--from"),
      )
      .option(
        "--to <timestamp>",
        'include findings before this time (exclusive). Accepts ISO 8601 (e.g. 2026-06-23T20:31:02Z) or a quoted copied TIME value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.',
        onceOption("--to"),
      )
      .option(
        "--detector <id>",
        "filter to a detector id (from 'detectors list'); also accepts a name or template",
        onceOption("--detector"),
      )
      .option("--trace <traceId>", "filter to a single trace", onceOption("--trace"));
  },
  resolveArgs(input: ResolveInput): Resolved {
    // A common footgun: pasting a copied `TIME` value after --from/--to without
    // quoting, so the time-of-day + zone land here as stray operands. Mirror the
    // `traces list` hint since findings accepts the same quoted-display format.
    if (input.extras.length > 0) {
      const strayJoined = input.extras.join(" ");
      const fromVal = input.opts.from as string | undefined;
      const toVal = input.opts.to as string | undefined;
      const bareDate = /^\d{4}-\d{2}-\d{2}$/;
      for (const [flag, value] of [
        ["--from", fromVal],
        ["--to", toVal],
      ] as const) {
        if (value !== undefined && bareDate.test(value)) {
          throw new CliError(
            `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot findings list ${flag} "${value} ${strayJoined}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot findings list ${flag} 2026-06-23T20:31:02Z\n  traceroot findings list ${flag} 2026-06-23T14:31:02-06:00`,
            ExitCode.usage,
          );
        }
      }
      throw new CliError(
        `unexpected argument(s): ${strayJoined}. 'findings list' takes no positional arguments. If you meant a time filter, --from/--to take a single ISO 8601 timestamp with no spaces, e.g. --from 2026-06-23T14:29:54Z (or with an offset, 2026-06-23T14:29:54-06:00).`,
        ExitCode.usage,
      );
    }
    const limit = parseLimit(input.opts.limit as string | undefined);
    const range = resolveTimeRange({
      since: input.opts.since as string | undefined,
      from: input.opts.from as string | undefined,
      to: input.opts.to as string | undefined,
    });
    const detector = input.opts.detector as string | undefined;
    const traceId = input.opts.trace as string | undefined;
    return {
      args: {
        ...(limit !== undefined ? { limit } : {}),
        ...(range.startAfter !== undefined ? { start_after: range.startAfter } : {}),
        ...(range.endBefore !== undefined ? { end_before: range.endBefore } : {}),
        ...(detector !== undefined ? { detector } : {}),
        ...(traceId !== undefined ? { trace_id: traceId } : {}),
      },
      state: { limit, ...range },
    };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const state = ctx.state as ListState;
    renderFindings(payload as FindingList, {
      json: ctx.json,
      writers: ctx.writers,
      limit: state.limit,
      startAfter: state.startAfter,
      endBefore: state.endBefore,
      sinceLabel: state.sinceLabel,
    });
  },
};
