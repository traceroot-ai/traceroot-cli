import type { Command } from "commander";
import { CliError, ExitCode, type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { parseLimit } from "../../time/range.js";
import { formatTimestamp } from "../../util/index.js";
import { onceOption, rejectExtras } from "../flags.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

interface AlertSummary {
  id: string;
  name: string;
  status: string;
  severity: string;
  aggregation: string;
  measure: string;
  threshold_operator: string;
  threshold: number;
  window: string;
  last_evaluated_at: string | null;
}

interface AlertListResponse {
  data: AlertSummary[];
  meta?: { capacity?: { used?: number; max?: number } };
}

export interface RenderAlertsListOptions {
  json: boolean;
  writers: Writers;
  timeZone?: string;
}

/** `p95 duration_ms > 1500 / 5m` — the rule at a glance, from five fields. */
function ruleText(a: AlertSummary): string {
  return `${a.aggregation} ${a.measure} ${a.threshold_operator} ${a.threshold} / ${a.window}`;
}

/**
 * Curated rendering for `alerts list`. The response carries 20 fields per
 * alert, so the default renderer would produce an unreadable table; these six
 * columns are what identify an alert and its current state, with ALERT ID last
 * as the value to copy into `alerts get`.
 */
export function renderAlertsList(res: AlertListResponse, opts: RenderAlertsListOptions): void {
  const { json, writers, timeZone } = opts;
  if (json) {
    writeJson({ ...res, count: res.data.length }, writers);
    return;
  }

  const headers = ["NAME", "STATUS", "SEVERITY", "RULE", "LAST EVAL", "ALERT ID"];
  const rows = res.data.map((a) => [
    a.name,
    a.status,
    a.severity,
    ruleText(a),
    a.last_evaluated_at === null ? "never" : formatTimestamp(a.last_evaluated_at, timeZone),
    a.id,
  ]);

  const styler = createStyler(writers.out);
  writers.out.write(`${renderTable(headers, rows, { headerStyle: styler.bold })}\n`);

  const capacity = res.meta?.capacity;
  const suffix =
    typeof capacity?.used === "number" && typeof capacity?.max === "number"
      ? ` | ${capacity.used}/${capacity.max} used`
      : "";
  logProgress(`${res.data.length} alert(s)${suffix}`, writers);
}

/**
 * Parses --page: a non-negative integer, zero-based (page 0 is the first
 * page). Deliberately not `parseLimit`: that helper rejects `value < 1`,
 * which would wrongly reject the valid `--page 0`.
 */
function parsePage(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new CliError("--page must be a non-negative integer", ExitCode.usage);
  }
  return Number.parseInt(raw, 10);
}

export const alertsList: Enhancer = {
  description: "List the project's threshold alerts",
  flags(cmd: Command): void {
    cmd
      .option("--limit <n>", "maximum number of alerts to return", onceOption("--limit"))
      .option("--page <n>", "zero-based page of results", onceOption("--page"))
      .option("--search <query>", "match against the alert name", onceOption("--search"));
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const args: Record<string, unknown> = {};
    // No local maximum: range bounds are validated server-side (deliberate);
    // this only rejects a non-numeric value before it becomes `limit=NaN`.
    const limit = parseLimit(input.opts.limit as string | undefined);
    const page = parsePage(input.opts.page as string | undefined);
    const search = input.opts.search;
    if (limit !== undefined) args.limit = limit;
    if (page !== undefined) args.page = page;
    if (typeof search === "string") args.search_query = search;
    return { args };
  },
  render(payload: unknown, ctx: RenderContext): void {
    renderAlertsList(payload as AlertListResponse, { json: ctx.json, writers: ctx.writers });
  },
};
