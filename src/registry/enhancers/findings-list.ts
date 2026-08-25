import type { Command } from "commander";
import type { FindingList } from "../../api/client.js";
import type { Writers } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatTimestamp } from "../../util/index.js";
import { onceOption } from "../flags.js";
import { sanitizeFindingId } from "./finding-id.js";
import {
  type ListState,
  addListTimeFlags,
  logListFooter,
  rejectListExtras,
  resolveListArgs,
  writeListJson,
} from "./list-shared.js";
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
  const state: ListState = { limit, startAfter, endBefore, sinceLabel };

  if (json) {
    writeListJson(res, state, writers, ALL_FINDINGS);
    return;
  }

  // Id ordering mirrors the UI's detector-runs table: run id -> trace id ->
  // finding id. A finding that fired N detectors has N producing runs (one per
  // (trace, detector)), so RUN IDS is a comma-joined list; empty when no run
  // row references the finding (e.g. findings that predate run recording).
  const headers = ["TIME", "RUN IDS", "TRACE ID", "FINDING ID", "DETECTOR NAME"];
  const rows = res.data.map((item) => [
    formatTimestamp(item.timestamp, timeZone),
    // `?? []` tolerates servers that predate the run_ids field.
    (item.run_ids ?? []).join(","),
    item.trace_id,
    sanitizeFindingId(item.finding_id),
    item.detectors.join(","),
  ]);

  const styler = createStyler(writers.out);
  const rendered = renderTable(headers, rows, { headerStyle: styler.bold });
  writers.out.write(`${rendered}\n`);

  logListFooter(res, state, "finding", writers, timeZone, ALL_FINDINGS);
}

export const findingsList: Enhancer = {
  description:
    "List detector findings. RUN IDS lists every detector run that produced the finding — " +
    "one run per triggered detector on the trace, so a finding fired by N detectors shows N run ids.",
  flags(cmd: Command): void {
    addListTimeFlags(cmd, {
      noun: "findings",
      sinceSubject: "findings",
      boundSubject: "findings",
      column: "TIME",
    })
      .option(
        "--detector <id>",
        "filter to a detector id (from 'detectors list'); also accepts a name or template",
        onceOption("--detector"),
      )
      .option("--trace <traceId>", "filter to a single trace", onceOption("--trace"));
  },
  resolveArgs(input: ResolveInput): Resolved {
    // A common footgun: pasting a copied `TIME` value after --from/--to without
    // quoting, so the time-of-day + zone land here as stray operands.
    rejectListExtras("findings list", input);
    const { args, state } = resolveListArgs(input);
    const detector = input.opts.detector as string | undefined;
    const traceId = input.opts.trace as string | undefined;
    return {
      args: {
        ...args,
        ...(detector !== undefined ? { detector } : {}),
        ...(traceId !== undefined ? { trace_id: traceId } : {}),
      },
      state,
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
