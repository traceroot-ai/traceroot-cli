import { REGISTRY } from "@traceroot-ai/tools";
import type { Command } from "commander";
import type { SignalList } from "../../api/client.js";
import { type Writers, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { parseLimit } from "../../time/range.js";
import { onceOption, rejectExtras } from "../flags.js";
import { parsePage } from "./alerts-list.js";
import { addLimitFlag, clean, limitBounds, orDash, when } from "./eval-reads.js";
import { logListFooter } from "./list-shared.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

/** State threaded from `resolveArgs` to `render`. */
export interface SignalsListState {
  limit?: number;
  page?: number;
  status?: string;
  detectorId?: string;
}

/**
 * The statuses `--status` takes, read from the registry for the help text. The
 * factory checks the value against the same enum before anything is sent.
 */
function statuses(): string {
  const values = REGISTRY.find((entry) => entry.name === "list_signals")?.inputSchema.properties
    .status?.enum;
  return Array.isArray(values) ? values.join(", ") : "";
}

/** What the footer says the page was drawn from: "open signals of detector d1, page 2". */
export function scopeLabel(state: SignalsListState): string {
  const signals = state.status === undefined ? "all signals" : `${clean(state.status)} signals`;
  const detector = state.detectorId === undefined ? "" : ` of detector ${clean(state.detectorId)}`;
  const page = state.page === undefined ? "" : `, page ${state.page}`;
  return `${signals}${detector}${page}`;
}

/** Rendering core, network-free. */
export function renderSignalsList(
  res: SignalList,
  state: SignalsListState,
  writers: Writers,
  timeZone?: string,
): void {
  const styler = createStyler(writers.out);
  const table = renderTable(
    ["SIGNAL ID", "STATUS", "HITS", "LAST SEEN", "DETECTOR", "TITLE"],
    res.data.map((s) => [
      orDash(s.signal_id),
      orDash(s.status),
      orDash(s.hit_count),
      // The list is newest created first; this column shows which still fire.
      when(s.last_seen_at, timeZone),
      // A deleted detector leaves no name, and its id still finds its findings.
      orDash(s.detector_name ?? s.detector_id),
      orDash(s.title),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  logListFooter(res, { limit: state.limit }, "signal", writers, timeZone, scopeLabel(state));
}

export const signalsList: Enhancer = {
  description:
    "List the project's signals, newest created first: the recurring problems detector findings " +
    "are grouped into, with their status, hit count and when each was last seen. Merged signals " +
    "are left out.",
  flags(cmd: Command): void {
    addLimitFlag(cmd, "list_signals", "signals")
      .option("--page <n>", "zero-based page of results", onceOption("--page"))
      .option(
        "--status <status>",
        `only signals with this status: ${statuses()}`,
        onceOption("--status"),
      )
      .option(
        "--detector-id <id>",
        "only signals of this detector, by its id from 'detectors list' (names are not accepted)",
        onceOption("--detector-id"),
      );
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const limit = parseLimit(
      input.opts.limit as string | undefined,
      limitBounds("list_signals").max,
    );
    const page = parsePage(input.opts.page as string | undefined);
    const status = input.opts.status as string | undefined;
    const detectorId = input.opts.detectorId as string | undefined;
    return {
      args: {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
        ...(status === undefined ? {} : { status }),
        ...(detectorId === undefined ? {} : { detector_id: detectorId }),
      },
      state: { limit, page, status, detectorId } satisfies SignalsListState,
    };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const res = payload as SignalList;
    if (ctx.json) {
      writeJson({ ...res, count: res.data.length }, ctx.writers);
      return;
    }
    renderSignalsList(res, ctx.state as SignalsListState, ctx.writers);
  },
};
