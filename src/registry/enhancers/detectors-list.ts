import type { Command } from "commander";
import type { DetectorList } from "../../api/client.js";
import type { Writers } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatTimestamp } from "../../util/index.js";
import {
  type ListState,
  addListTimeFlags,
  logListFooter,
  rejectListExtras,
  resolveListArgs,
  writeListJson,
} from "./list-shared.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

/** The no-filter range label for detectors (vs. traces' "all traces"). */
const ALL_DETECTORS = "all detectors";

/** Options for the testable, network-free rendering core of `detectors list`. */
export interface RenderDetectorsOptions {
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

/**
 * Core, network-free rendering logic for `detectors list`. The detector list
 * itself is fetched by the factory before `render` runs, so this operates on
 * an already-fetched response.
 */
export function renderDetectors(res: DetectorList, opts: RenderDetectorsOptions): void {
  const { json, writers, limit, startAfter, endBefore, sinceLabel, timeZone } = opts;
  const state: ListState = { limit, startAfter, endBefore, sinceLabel };

  if (json) {
    writeListJson(res, state, writers, ALL_DETECTORS);
    return;
  }

  // DETECTOR ID is last, mirroring `traces list` (TRACE ID last): it's the value
  // to copy into `findings list --detector <id>`.
  const headers = ["CREATED", "NAME", "TEMPLATE", "ENABLED", "DETECTOR ID"];
  const rows = res.data.map((item) => [
    formatTimestamp(item.created_at, timeZone),
    item.name,
    item.template,
    item.enabled ? "yes" : "no",
    item.detector_id,
  ]);

  const styler = createStyler(writers.out);
  const rendered = renderTable(headers, rows, { headerStyle: styler.bold });
  writers.out.write(`${rendered}\n`);

  logListFooter(res, state, "detector", writers, timeZone, ALL_DETECTORS);
}

export const detectorsList: Enhancer = {
  description: "List detectors",
  flags(cmd: Command): void {
    addListTimeFlags(cmd, {
      noun: "detectors",
      sinceSubject: "detectors created",
      boundSubject: "detectors created",
      column: "CREATED",
    });
  },
  resolveArgs(input: ResolveInput): Resolved {
    // Mirror the `traces list` hint: a copied CREATED value pasted after
    // --from/--to without quoting lands here as stray operands.
    rejectListExtras("detectors list", input);
    return resolveListArgs(input);
  },
  render(payload: unknown, ctx: RenderContext): void {
    const state = ctx.state as ListState;
    renderDetectors(payload as DetectorList, {
      json: ctx.json,
      writers: ctx.writers,
      limit: state.limit,
      startAfter: state.startAfter,
      endBefore: state.endBefore,
      sinceLabel: state.sinceLabel,
    });
  },
};
