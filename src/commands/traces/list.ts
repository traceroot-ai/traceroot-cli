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
  /** Original `--since` string for the footer label (e.g. `"2m"`). */
  sinceLabel?: string;
  /**
   * IANA timezone override for the footer's human-local time display.
   * Defaults to the system local zone. Tests inject `"America/Denver"` etc.
   * for deterministic output.
   */
  timeZone?: string;
}

/** Resolved, backend-ready ISO time bounds derived from the CLI time flags. */
export interface TimeRange {
  startAfter?: string;
  endBefore?: string;
  /** Original `--since` argument string (e.g. `"2m"`) for the footer. */
  sinceLabel?: string;
}

/**
 * Converts a wall-clock datetime (Y, M, D, h, m, s) interpreted in the given
 * IANA timezone to a UTC instant (ms since epoch). Uses a two-pass approach to
 * resolve DST ambiguities correctly.
 *
 * NOTE: This function is exclusively for values copied from THIS CLI's own local
 * `STARTED` column. It is interpreted in the user's local IANA timezone and the
 * abbreviation is verified — arbitrary non-local timezone abbreviations are
 * intentionally NOT supported (use ISO 8601 with an explicit offset for other zones).
 */
function wallClockToUtc(
  Y: number,
  M: number,
  D: number,
  h: number,
  m: number,
  s: number,
  timeZone: string,
): number {
  // Step 1: naive UTC guess
  const guess = Date.UTC(Y, M - 1, D, h, m, s);

  // Helper: given a UTC instant, compute the zone offset as (local wall-clock
  // interpreted as UTC) minus (the UTC instant). When zone is west of UTC (e.g.
  // MDT = UTC-6), the local wall clock is behind UTC, so localMs < utcMs and the
  // offset is negative. We subtract this offset from guess to get real UTC.
  //
  // Example: guess = 14:31Z (wall clock treated as UTC).
  // At 14:31Z Denver is 08:31 MDT. localMs = 08:31Z. offset = 08:31 - 14:31 = -6h.
  // real_utc = guess - offset = 14:31 - (-6h) = 20:31Z. ✓
  function offsetAt(utcMs: number): number {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(utcMs));
    const pick = (type: Intl.DateTimeFormatPartTypes): number =>
      Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    // hour12:false can return "24" for midnight; normalize to 0.
    const hour = pick("hour") % 24;
    const localMs = Date.UTC(
      pick("year"),
      pick("month") - 1,
      pick("day"),
      hour,
      pick("minute"),
      pick("second"),
    );
    return localMs - utcMs; // negative for zones west of UTC
  }

  // DST disambiguation policy:
  // - Fall-back (fold): an ambiguous wall-clock time (one that occurs twice) resolves to
  //   the EARLIER (pre-transition) occurrence. The two-pass correction converges on the
  //   first offset seen at the naive UTC guess, which is the pre-transition offset.
  // - Spring-forward (gap): a nonexistent wall-clock time resolves to the post-shift instant
  //   because the corrected UTC lands after the transition.
  const offset1 = offsetAt(guess);
  let utc = guess - offset1;
  const offset2 = offsetAt(utc);
  if (offset2 !== offset1) {
    utc = guess - offset2;
  }
  return utc;
}

/**
 * Resolves the abbreviation produced by Intl for a given UTC instant and zone.
 * Returns the short timezone name (e.g. "MDT").
 */
function resolveAbbreviation(utcMs: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/**
 * Treats a CLI-supplied timestamp as ISO 8601 and normalizes it to a UTC instant
 * string. Also accepts the exact display format `YYYY-MM-DD HH:mm:ss <TZ_ABBR>`
 * (a quoted single arg), validating the abbreviation against the local zone.
 * A bare date (`2026-06-01`) becomes midnight UTC; a zone-less datetime is
 * interpreted as UTC. Throws a {@link CliError} when the value is not a
 * parseable timestamp or when the abbreviation doesn't match the local zone.
 *
 * The quoted display format (`YYYY-MM-DD HH:mm:ss TZ_ABBR`) is ONLY for values
 * copied from THIS CLI's own local `STARTED` column. It is interpreted in the
 * user's local IANA timezone and the abbreviation is verified — arbitrary
 * non-local timezone abbreviations are intentionally NOT supported (use ISO 8601
 * with an explicit offset for other zones).
 */
function normalizeTimestamp(raw: string, flag: string, timeZone: string): string {
  const trimmed = raw.trim();

  // Quoted local display with a GMT±offset (e.g. "2026-06-23 17:30:00 GMT+5:30") —
  // the form this CLI's STARTED column shows in zones Intl renders as GMT offsets
  // (IST, JST, CET, BRT, …). The offset is explicit and unambiguous, so convert
  // straight to ISO; no local-zone lookup or abbreviation check is needed.
  const gmtMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(
    trimmed,
  );
  if (gmtMatch !== null) {
    const [, date, time, sign, oh, om] = gmtMatch as unknown as [
      string,
      string,
      string,
      string,
      string,
      string | undefined,
    ];
    const offH = Number.parseInt(oh, 10);
    const offM = om !== undefined ? Number.parseInt(om, 10) : 0;
    const iso = `${date}T${time}${sign}${oh.padStart(2, "0")}:${(om ?? "00").padStart(2, "0")}`;
    const d = new Date(iso);
    // Validate without normalizing. `new Date` with an explicit offset SILENTLY
    // rolls invalid dates (Feb 31 → Mar 3, hour 25 → next day), so round-trip the
    // resolved instant back to the same offset and require the wall-clock to match
    // exactly — plus reject out-of-range offsets (max real offset is +14:00).
    const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
    const offsetMs = (sign === "+" ? 1 : -1) * (offH * 60 + offM) * 60_000;
    const wall = new Date(d.getTime() + offsetMs); // wall-clock now lives in UTC fields
    const roundTrip = `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`;
    if (offH > 14 || offM > 59 || Number.isNaN(d.getTime()) || roundTrip !== `${date}T${time}`) {
      throw new CliError(
        `${flag} "${trimmed}": not a valid timestamp. Use ISO 8601, e.g. ${flag} 2026-06-23T17:30:00+05:30.`,
      );
    }
    return d.toISOString();
  }

  // Try the quoted local display format: "YYYY-MM-DD HH:mm:ss TZ_ABBR" (named abbr)
  const displayMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([A-Za-z]{2,5})$/.exec(
    trimmed,
  );
  if (displayMatch !== null) {
    const [, ys, ms, ds, hs, mins, ss, abbr] = displayMatch as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const Y = Number.parseInt(ys, 10);
    const Mo = Number.parseInt(ms, 10);
    const D = Number.parseInt(ds, 10);
    const h = Number.parseInt(hs, 10);
    const mi = Number.parseInt(mins, 10);
    const s = Number.parseInt(ss, 10);

    const utcMs = wallClockToUtc(Y, Mo, D, h, mi, s, timeZone);

    // Round-trip validation: re-format utcMs back into the local zone and confirm
    // Y/M/D/h/m/s match what was typed. This catches invalid calendar dates
    // (e.g. Feb 31 → silently rolls to Mar 3) and nonexistent DST-gap times
    // (e.g. spring-forward 02:30 that doesn't exist in the local clock).
    const rtFmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const rtParts = rtFmt.formatToParts(new Date(utcMs));
    const rtPick = (type: Intl.DateTimeFormatPartTypes): number => {
      const val = rtParts.find((p) => p.type === type)?.value ?? "0";
      return Number.parseInt(val, 10);
    };
    const rtHour = rtPick("hour") % 24; // hour12:false may return "24" for midnight → 0
    if (
      rtPick("year") !== Y ||
      rtPick("month") !== Mo ||
      rtPick("day") !== D ||
      rtHour !== h ||
      rtPick("minute") !== mi ||
      rtPick("second") !== s
    ) {
      // The typed local time is invalid (bad calendar date/time) or nonexistent
      // (a spring-forward DST gap). Do NOT echo the invalid value back as a
      // suggestion (it would also be invalid ISO); point to ISO 8601 with an
      // explicit offset using a generic, valid example instead.
      throw new CliError(
        `${flag} "${trimmed}": not a valid local time (invalid date/time, or a nonexistent local time such as a DST gap). Use ISO 8601 with an explicit offset, e.g. ${flag} 2026-06-23T14:31:02-06:00.`,
      );
    }

    const localAbbr = resolveAbbreviation(utcMs, timeZone);

    if (localAbbr !== abbr) {
      // Build a suggested ISO-with-offset string using the wall clock and the
      // computed UTC offset, so the example is concrete and copy-pasteable.
      const offsetMins = Math.round((utcMs - Date.UTC(Y, Mo - 1, D, h, mi, s)) / 60_000);
      const sign = offsetMins <= 0 ? "+" : "-";
      const absMin = Math.abs(offsetMins);
      const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
      const offM = String(absMin % 60).padStart(2, "0");
      const suggestion = `${ys}-${ms}-${ds}T${hs}:${mins}:${ss}${sign}${offH}:${offM}`;
      throw new CliError(
        `${flag} "${trimmed}": timezone "${abbr}" doesn't match your local timezone (${timeZone} → ${localAbbr}). Use ISO 8601 with an explicit offset instead, e.g. ${flag} ${suggestion}.`,
      );
    }

    return new Date(utcMs).toISOString();
  }

  // Standard ISO 8601 paths
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
 * Returns an empty range when no flag is given. `now` and `timeZone` are
 * injectable for tests.
 */
export function resolveTimeRange(
  opts: { since?: string; from?: string; to?: string },
  now: () => number = Date.now,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
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
    return { startAfter: startAfter.toISOString(), sinceLabel: since };
  }
  const range: TimeRange = {};
  if (from !== undefined) {
    range.startAfter = normalizeTimestamp(from, "--from", timeZone);
  }
  if (to !== undefined) {
    range.endBefore = normalizeTimestamp(to, "--to", timeZone);
  }
  if (range.startAfter !== undefined && range.endBefore !== undefined) {
    // Both are normalized ISO-8601 UTC strings, so lexical comparison is chronological.
    if (range.startAfter === range.endBefore) {
      throw new CliError(
        "--from and --to resolve to the same time. The lower bound is inclusive and the upper bound is exclusive, so choose a later --to.",
      );
    }
    if (range.startAfter > range.endBefore) {
      throw new CliError("--from must resolve to an earlier time than --to");
    }
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

/**
 * Formats an ISO UTC timestamp into the SAME local 24-hour form the table's
 * `STARTED` column uses (e.g. `2026-06-23 14:29:54 MDT`), so a footer timestamp
 * can be copied straight back into `--from`/`--to`. `timeZone` overrides the
 * system local zone (tests inject a fixed zone for deterministic output).
 */
export function formatLocalDisplay(iso: string, timeZone?: string): string {
  return formatTimestamp(iso, timeZone);
}

/**
 * Returns the `<range>` portion of the compact footer line (human-mode, local TZ).
 * Priority: sinceLabel → both bounds → from-only → to-only → all traces.
 */
export function renderRangeSummary(
  range: { startAfter?: string; endBefore?: string; sinceLabel?: string },
  timeZone?: string,
): string {
  if (range.sinceLabel !== undefined) {
    return `since ${range.sinceLabel}`;
  }
  if (range.startAfter !== undefined && range.endBefore !== undefined) {
    const from = formatLocalDisplay(range.startAfter, timeZone);
    const to = formatLocalDisplay(range.endBefore, timeZone);
    return `from ${from} to before ${to}`;
  }
  if (range.startAfter !== undefined) {
    return `from ${formatLocalDisplay(range.startAfter, timeZone)}`;
  }
  if (range.endBefore !== undefined) {
    return `before ${formatLocalDisplay(range.endBefore, timeZone)}`;
  }
  return "all traces";
}

/**
 * Returns the TZ-independent range label for use in --json output.
 * Uses ISO strings directly (no local-time formatting).
 */
function renderRangeLabel(range: {
  startAfter?: string;
  endBefore?: string;
  sinceLabel?: string;
}): string {
  if (range.sinceLabel !== undefined) {
    return `since ${range.sinceLabel}`;
  }
  if (range.startAfter !== undefined && range.endBefore !== undefined) {
    return `from ${range.startAfter} to before ${range.endBefore}`;
  }
  if (range.startAfter !== undefined) {
    return `from ${range.startAfter}`;
  }
  if (range.endBefore !== undefined) {
    return `before ${range.endBefore}`;
  }
  return "all traces";
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
  const { client, json, writers, limit, startAfter, endBefore, sinceLabel, timeZone } = deps;
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
    const rangeInfo = { startAfter, endBefore, sinceLabel };
    writeJson(
      {
        ...res,
        count: res.data.length,
        range: {
          label: renderRangeLabel(rangeInfo),
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

/**
 * Coercion that rejects a flag given more than once. Relies on Commander passing
 * the previously parsed value as `prev` on a repeat occurrence (and `undefined`
 * on the first). IMPORTANT: do NOT set `.default(...)` on any option using this —
 * Commander would pass that default as `prev` on the first use and falsely reject it.
 */
function onceOption(flag: string): (val: string, prev: string | undefined) => string {
  return (val: string, prev: string | undefined): string => {
    if (prev !== undefined) {
      throw new CliError(`${flag} may only be given once`);
    }
    return val;
  };
}

export function registerTracesList(traces: Command): void {
  traces
    .command("list")
    .description("List traces")
    .option("--limit <n>", "maximum number of traces to return", onceOption("--limit"))
    .option(
      "--since <duration>",
      "only traces within a window ending now, e.g. 30m, 6h, 7d, 2w",
      onceOption("--since"),
    )
    .option(
      "--from <timestamp>",
      'only traces at or after this time. Accepts ISO 8601 (e.g. 2026-06-23T14:31:02Z or 2026-06-23T14:31:02-06:00) or a quoted copied STARTED value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted. (inclusive)',
      onceOption("--from"),
    )
    .option(
      "--to <timestamp>",
      'only traces before this time. Accepts ISO 8601 (e.g. 2026-06-23T20:31:02Z) or a quoted copied STARTED value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted. (exclusive)',
      onceOption("--to"),
    )
    .action(async (_opts, command: Command) => {
      // 1. Reject stray positional operands FIRST (before any API call).
      //    This catches split local timestamps, e.g.: --from 2026-06-23 14:29:54 MDT
      if (command.args.length > 0) {
        const strayJoined = command.args.join(" ");
        const fromVal = (_opts as { from?: string }).from;
        const toVal = (_opts as { to?: string }).to;
        const bareDate = /^\d{4}-\d{2}-\d{2}$/;

        if (fromVal !== undefined && bareDate.test(fromVal)) {
          // Looks like the user forgot to quote: --from 2026-06-23 14:31:02 MDT
          const reconstructed = `${fromVal} ${strayJoined}`;
          throw new CliError(
            `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot traces list --from "${reconstructed}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot traces list --from 2026-06-23T20:31:02Z\n  traceroot traces list --from 2026-06-23T14:31:02-06:00`,
          );
        }
        if (toVal !== undefined && bareDate.test(toVal)) {
          const reconstructed = `${toVal} ${strayJoined}`;
          throw new CliError(
            `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot traces list --to "${reconstructed}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot traces list --to 2026-06-23T20:31:02Z\n  traceroot traces list --to 2026-06-23T14:31:02-06:00`,
          );
        }
        throw new CliError(
          `unexpected argument(s): ${strayJoined}. 'traces list' takes no positional arguments. If you meant a time filter, --from/--to take a single ISO 8601 timestamp with no spaces, e.g. --from 2026-06-23T14:29:54Z (or with an offset, 2026-06-23T14:29:54-06:00).`,
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
        sinceLabel: range.sinceLabel,
      });
    });
}
