import { type Writers, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { formatTimestamp } from "../../util/index.js";
import type { Enhancer, RenderContext } from "./types.js";

interface AlertFilter {
  field: string;
  op: string;
  value: string | number;
  key?: string | null;
}

interface AlertDetail {
  id: string;
  name: string;
  status: string;
  severity: string;
  view: string;
  aggregation: string;
  measure: string;
  threshold_operator: string;
  threshold: number;
  window: string;
  no_data_mode: string;
  renotify: { mode: string; interval_minutes?: number | null };
  filters: AlertFilter[];
  creator: string | null;
  create_time: string;
  update_time: string;
  last_evaluated_at: string | null;
  last_error: string | null;
}

export interface RenderAlertDetailOptions {
  json: boolean;
  writers: Writers;
  timeZone?: string;
}

function filterText(f: AlertFilter): string {
  const field = f.key === undefined || f.key === null ? f.field : `${f.field}.${f.key}`;
  return `${field} ${f.op} ${f.value}`;
}

function renotifyText(r: AlertDetail["renotify"]): string {
  if (r.mode !== "EVERY") return "off";
  return typeof r.interval_minutes === "number" ? `every ${r.interval_minutes}m` : "every";
}

/** Curated key/value rendering for `alerts get`; the payload has 24 fields. */
export function renderAlertDetail(payload: AlertDetail, opts: RenderAlertDetailOptions): void {
  const { json, writers, timeZone } = opts;
  if (json) {
    writeJson(payload, writers);
    return;
  }
  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const filters =
    payload.filters.length === 0 ? "none" : payload.filters.map(filterText).join(", ");
  const lines = [
    `${label("Alert:")}       ${payload.name}`,
    `${label("Alert ID:")}    ${payload.id}`,
    `${label("Status:")}      ${payload.status} (severity ${payload.severity})`,
    `${label("Rule:")}        ${payload.aggregation} ${payload.measure} ${payload.threshold_operator} ${payload.threshold} / ${payload.window}`,
    `${label("View:")}        ${payload.view}`,
    `${label("Filters:")}     ${filters}`,
    `${label("Renotify:")}    ${renotifyText(payload.renotify)}`,
    `${label("No data:")}     ${payload.no_data_mode}`,
    `${label("Last eval:")}   ${payload.last_evaluated_at === null ? "never" : formatTimestamp(payload.last_evaluated_at, timeZone)}`,
    `${label("Created:")}     ${formatTimestamp(payload.create_time, timeZone)}${payload.creator === null ? "" : ` by ${payload.creator}`}`,
    `${label("Updated:")}     ${formatTimestamp(payload.update_time, timeZone)}`,
  ];
  if (payload.last_error !== null) {
    lines.push(`${label("Last error:")}  ${payload.last_error}`);
  }
  writers.out.write(`${lines.join("\n")}\n`);
}

export const alertsGet: Enhancer = {
  description: "Show one alert's full rule and evaluation state",
  render(payload: unknown, ctx: RenderContext): void {
    renderAlertDetail(payload as AlertDetail, { json: ctx.json, writers: ctx.writers });
  },
};
