import type { Command } from "commander";
import type { ApiClient, ListDetectorsParams } from "../../api/client.js";
import {
  CliError,
  ExitCode,
  type Writers,
  defaultWriters,
  logProgress,
  writeJson,
} from "../../output.js";
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

/** The no-filter range label for detectors (vs. traces' "all traces"). */
const ALL_DETECTORS = "all detectors";

/** Dependencies for the testable core of `detectors list`. */
export interface RunDetectorsDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  limit?: number;
  /** ISO 8601 lower bound (inclusive) on creation time, forwarded as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) on creation time, forwarded as `end_before`. */
  endBefore?: string;
  /** Original `--since` string for the footer label (e.g. `"7d"`). */
  sinceLabel?: string;
  /** IANA timezone override for the human-local time display. */
  timeZone?: string;
}

/** Core, network-free logic for `detectors list`. Tests inject a fake client. */
export async function runDetectors(deps: RunDetectorsDeps): Promise<void> {
  const { client, json, writers, limit, startAfter, endBefore, sinceLabel } = deps;
  const params: ListDetectorsParams = {};
  if (limit !== undefined) {
    params.limit = limit;
  }
  if (startAfter !== undefined) {
    params.startAfter = startAfter;
  }
  if (endBefore !== undefined) {
    params.endBefore = endBefore;
  }
  const res = await client.listDetectors(Object.keys(params).length > 0 ? params : undefined);

  if (json) {
    writeJson(
      {
        ...res,
        count: res.data.length,
        range: {
          label: buildRangeText({ startAfter, endBefore, sinceLabel }, (iso) => iso, ALL_DETECTORS),
          startAfter: startAfter ?? null,
          endBefore: endBefore ?? null,
        },
      },
      writers,
    );
    return;
  }

  // DETECTOR ID is last, mirroring `traces list` (TRACE ID last): it's the value
  // to copy into `findings list --detector <id>`.
  const headers = ["CREATED", "NAME", "TEMPLATE", "ENABLED", "DETECTOR ID"];
  const rows = res.data.map((item) => [
    formatTimestamp(item.created_at, deps.timeZone),
    item.name,
    item.template,
    item.enabled ? "yes" : "no",
    item.detector_id,
  ]);

  const styler = createStyler(writers.out);
  const rendered = renderTable(headers, rows, { headerStyle: styler.bold });
  writers.out.write(`${rendered}\n`);

  // Footer: "<count> detector(s) | limit <N> | <range>"
  const returned = res.data.length;
  const total = res.meta?.total;
  const countText =
    typeof total === "number" && total > returned
      ? `${returned} of ${total} detector(s)`
      : `${returned} detector(s)`;
  const effectiveLimit = res.meta?.limit ?? limit ?? 50;
  const rangeText = renderRangeSummary(
    { startAfter, endBefore, sinceLabel },
    deps.timeZone,
    ALL_DETECTORS,
  );
  logProgress(`${countText} | limit ${effectiveLimit} | ${rangeText}`, writers);
}

export function registerDetectorsList(detectors: Command): void {
  detectors
    .command("list")
    .description("List detectors")
    .option("--limit <n>", "maximum number of detectors to return", onceOption("--limit"))
    .option(
      "--since <duration>",
      "only detectors created within a window ending now, e.g. 30m, 6h, 7d, 2w",
      onceOption("--since"),
    )
    .option(
      "--from <timestamp>",
      'include detectors created at or after this time. Accepts ISO 8601 (e.g. 2026-06-23T14:31:02Z or 2026-06-23T14:31:02-06:00) or a quoted copied CREATED value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.',
      onceOption("--from"),
    )
    .option(
      "--to <timestamp>",
      'include detectors created before this time (exclusive). Accepts ISO 8601 (e.g. 2026-06-23T20:31:02Z) or a quoted copied CREATED value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.',
      onceOption("--to"),
    )
    .action(async (_opts, command: Command) => {
      if (command.args.length > 0) {
        // Mirror the `traces list` hint: a copied CREATED value pasted after
        // --from/--to without quoting lands here as stray operands.
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
              `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot detectors list ${flag} "${value} ${strayJoined}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot detectors list ${flag} 2026-06-23T20:31:02Z\n  traceroot detectors list ${flag} 2026-06-23T14:31:02-06:00`,
              ExitCode.usage,
            );
          }
        }
        throw new CliError(
          `unexpected argument(s): ${strayJoined}. 'detectors list' takes no positional arguments. If you meant a time filter, --from/--to take a single ISO 8601 timestamp with no spaces, e.g. --from 2026-06-23T14:29:54Z (or with an offset, 2026-06-23T14:29:54-06:00).`,
          ExitCode.usage,
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
      await runDetectors({
        client,
        json: ctx.json,
        writers: defaultWriters,
        limit,
        startAfter: range.startAfter,
        endBefore: range.endBefore,
        sinceLabel: range.sinceLabel,
      });
    });
}
