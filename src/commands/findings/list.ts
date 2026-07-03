import type { Command } from "commander";
import type { ApiClient, ListFindingsParams } from "../../api/client.js";
import { type Writers, CliError, defaultWriters, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";
import {
  buildRangeText,
  onceOption,
  parseLimit,
  renderRangeSummary,
  resolveTimeRange,
} from "../traces/list.js";

/** The no-filter range label for findings (vs. traces' "all traces"). */
const ALL_FINDINGS = "all findings";

/** Dependencies for the testable core of `findings list`. */
export interface RunFindingsDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  limit?: number;
  /** ISO 8601 lower bound (inclusive) forwarded as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) forwarded as `end_before`. */
  endBefore?: string;
  /** Detector selector forwarded verbatim; resolved server-side. */
  detector?: string;
  /** Restrict to a single trace, forwarded as `trace_id`. */
  traceId?: string;
  /** Original `--since` string for the footer label (e.g. `"24h"`). */
  sinceLabel?: string;
  /** IANA timezone override for the footer's human-local time display. */
  timeZone?: string;
}

/** Core, network-free logic for `findings list`. Tests inject a fake client. */
export async function runFindings(deps: RunFindingsDeps): Promise<void> {
  const { client, json, writers, limit, startAfter, endBefore, detector, traceId, sinceLabel } =
    deps;
  const params: ListFindingsParams = {};
  if (limit !== undefined) {
    params.limit = limit;
  }
  if (startAfter !== undefined) {
    params.startAfter = startAfter;
  }
  if (endBefore !== undefined) {
    params.endBefore = endBefore;
  }
  if (detector !== undefined) {
    params.detector = detector;
  }
  if (traceId !== undefined) {
    params.traceId = traceId;
  }
  const res = await client.listFindings(Object.keys(params).length > 0 ? params : undefined);

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
    formatTimestamp(item.timestamp, deps.timeZone),
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
    deps.timeZone,
    ALL_FINDINGS,
  );
  logProgress(`${countText} | limit ${effectiveLimit} | ${rangeText}`, writers);
}

export function registerFindingsList(findings: Command): void {
  findings
    .command("list")
    .description("List detector findings")
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
    .option("--trace <traceId>", "filter to a single trace", onceOption("--trace"))
    .action(async (_opts, command: Command) => {
      if (command.args.length > 0) {
        // A common footgun: pasting a copied `TIME` value after --from/--to without
        // quoting, so the time-of-day + zone land here as stray operands. Mirror the
        // `traces list` hint since findings accepts the same quoted-display format.
        const strayJoined = command.args.join(" ");
        const fromVal = (_opts as { from?: string }).from;
        const toVal = (_opts as { to?: string }).to;
        const bareDate = /^\d{4}-\d{2}-\d{2}$/;
        for (const [flag, value] of [
          ["--from", fromVal],
          ["--to", toVal],
        ] as const) {
          if (value !== undefined && bareDate.test(value)) {
            throw new CliError(
              `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot findings list ${flag} "${value} ${strayJoined}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot findings list ${flag} 2026-06-23T20:31:02Z\n  traceroot findings list ${flag} 2026-06-23T14:31:02-06:00`,
            );
          }
        }
        throw new CliError(
          `unexpected argument(s): ${strayJoined}. 'findings list' takes no positional arguments. If you meant a time filter, --from/--to take a single ISO 8601 timestamp with no spaces, e.g. --from 2026-06-23T14:29:54Z (or with an offset, 2026-06-23T14:29:54-06:00).`,
        );
      }
      const opts = command.opts();
      const limit = parseLimit(opts.limit as string | undefined);
      const range = resolveTimeRange({
        since: opts.since as string | undefined,
        from: opts.from as string | undefined,
        to: opts.to as string | undefined,
      });
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      await runFindings({
        client,
        json: ctx.json,
        writers: defaultWriters,
        limit,
        startAfter: range.startAfter,
        endBefore: range.endBefore,
        detector: opts.detector as string | undefined,
        traceId: opts.trace as string | undefined,
        sinceLabel: range.sinceLabel,
      });
    });
}
