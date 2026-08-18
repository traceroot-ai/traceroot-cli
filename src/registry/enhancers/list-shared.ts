import type { Command } from "commander";
import { CliError, ExitCode, type Writers, logProgress, writeJson } from "../../output.js";
import {
  buildRangeText,
  parseLimit,
  renderRangeSummary,
  resolveTimeRange,
} from "../../time/range.js";
import { onceOption } from "../flags.js";
import type { ResolveInput } from "./types.js";

/**
 * The pieces every curated list command (traces/detectors/findings list)
 * shares: the --limit/--since/--from/--to flag block, the unquoted-timestamp
 * stray-operand hints, the resolved range args/state, the `--json` range
 * envelope, and the count footer. One definition here keeps the three
 * commands' wording and formats from drifting apart.
 */

/** Per-command wording slotted into the shared flag descriptions. */
export interface ListFlagWording {
  /** Plural noun for --limit ("traces", "detectors", "findings"). */
  noun: string;
  /** Subject phrase for --since ("traces", "detectors created", "findings"). */
  sinceSubject: string;
  /** Subject phrase for --from/--to ("traces started", "detectors created", "findings"). */
  boundSubject: string;
  /** The table column users copy timestamps from ("STARTED", "CREATED", "TIME"). */
  column: string;
}

export function addListTimeFlags(cmd: Command, w: ListFlagWording): Command {
  return cmd
    .option("--limit <n>", `maximum number of ${w.noun} to return`, onceOption("--limit"))
    .option(
      "--since <duration>",
      `only ${w.sinceSubject} within a window ending now, e.g. 30m, 6h, 7d, 2w`,
      onceOption("--since"),
    )
    .option(
      "--from <timestamp>",
      `include ${w.boundSubject} at or after this time. Accepts ISO 8601 (e.g. 2026-06-23T14:31:02Z or 2026-06-23T14:31:02-06:00) or a quoted copied ${w.column} value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.`,
      onceOption("--from"),
    )
    .option(
      "--to <timestamp>",
      `include ${w.boundSubject} before this time (exclusive). Accepts ISO 8601 (e.g. 2026-06-23T20:31:02Z) or a quoted copied ${w.column} value (e.g. "2026-06-23 14:31:02 MDT"). Values with spaces MUST be quoted.`,
      onceOption("--to"),
    );
}

/**
 * Rejects stray positional operands with the unquoted-timestamp hints: a
 * copied display value pasted after --from/--to without quoting lands here as
 * stray operands (e.g. `--from 2026-06-23 14:31:02 MDT`).
 * `commandPath` is the subcommand path shown in the hints, e.g. "traces list".
 */
export function rejectListExtras(commandPath: string, input: ResolveInput): void {
  if (input.extras.length === 0) return;
  const strayJoined = input.extras.join(" ");
  const bareDate = /^\d{4}-\d{2}-\d{2}$/;
  for (const [flag, value] of [
    ["--from", input.opts.from as string | undefined],
    ["--to", input.opts.to as string | undefined],
  ] as const) {
    if (value !== undefined && bareDate.test(value)) {
      throw new CliError(
        `unexpected argument(s): ${strayJoined}.\n\nDid you mean to quote the timestamp?\n  traceroot ${commandPath} ${flag} "${value} ${strayJoined}"\n\nTimestamps with spaces must be passed as one shell argument.\nISO 8601 also works:\n  traceroot ${commandPath} ${flag} 2026-06-23T20:31:02Z\n  traceroot ${commandPath} ${flag} 2026-06-23T14:31:02-06:00`,
        ExitCode.usage,
      );
    }
  }
  throw new CliError(
    `unexpected argument(s): ${strayJoined}. '${commandPath}' takes no positional arguments. If you meant a time filter, --from/--to take a single ISO 8601 timestamp with no spaces, e.g. --from 2026-06-23T14:29:54Z (or with an offset, 2026-06-23T14:29:54-06:00).`,
    ExitCode.usage,
  );
}

/** State threaded from a list command's `resolveArgs` to its `render`. */
export interface ListState {
  limit?: number;
  startAfter?: string;
  endBefore?: string;
  sinceLabel?: string;
}

/**
 * Validates --limit and resolves --since/--from/--to into the tool args
 * (`limit`/`start_after`/`end_before`, undefined keys omitted) plus the
 * presentation state the footer needs. Callers with extra filters (e.g.
 * findings' --detector/--trace) extend `args` afterwards.
 */
export function resolveListArgs(input: ResolveInput): {
  args: Record<string, unknown>;
  state: ListState;
} {
  const limit = parseLimit(input.opts.limit as string | undefined);
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
}

/** The list-response envelope shape the shared JSON/footer helpers read. */
export interface ListEnvelope {
  data: unknown[];
  meta?: { limit?: number; total?: number };
}

/**
 * The `--json` envelope every list command emits: the raw response plus
 * `count` and the resolved `range` (label with RAW ISO bounds; bounds
 * themselves `?? null`). `allLabel` overrides the no-filter label
 * (default "all traces").
 */
export function writeListJson(
  res: ListEnvelope,
  state: ListState,
  writers: Writers,
  allLabel?: string,
): void {
  const { startAfter, endBefore, sinceLabel } = state;
  writeJson(
    {
      ...res,
      count: res.data.length,
      range: {
        label: buildRangeText({ startAfter, endBefore, sinceLabel }, (iso) => iso, allLabel),
        startAfter: startAfter ?? null,
        endBefore: endBefore ?? null,
      },
    },
    writers,
  );
}

/**
 * The compact one-line footer: `<count> <noun>(s) | limit <N> | <range>`,
 * with "<count> of <total>" when the backend reports more than it returned
 * and the backend's default limit (50) as the last fallback.
 */
export function logListFooter(
  res: ListEnvelope,
  state: ListState,
  noun: string,
  writers: Writers,
  timeZone?: string,
  allLabel?: string,
): void {
  const returned = res.data.length;
  const total = res.meta?.total;
  const countText =
    typeof total === "number" && total > returned
      ? `${returned} of ${total} ${noun}(s)`
      : `${returned} ${noun}(s)`;
  const effectiveLimit = res.meta?.limit ?? state.limit ?? 50;
  const rangeText = renderRangeSummary(
    { startAfter: state.startAfter, endBefore: state.endBefore, sinceLabel: state.sinceLabel },
    timeZone,
    allLabel,
  );
  logProgress(`${countText} | limit ${effectiveLimit} | ${rangeText}`, writers);
}
