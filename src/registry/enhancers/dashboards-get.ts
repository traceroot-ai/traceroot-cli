import type { DashboardDetail } from "../../api/client.js";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { renderFields } from "../../render/fields.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { plural } from "../../util/index.js";
import { type Wire, clean, orDash, when } from "./eval-reads.js";
import { suggest } from "./signals-get.js";
import type { Enhancer, RenderContext } from "./types.js";

type Dashboard = Wire<DashboardDetail>;
type Widget = NonNullable<Dashboard["widgets"]>[number];

/** A JSON object, or undefined: the contract leaves a widget's `spec` untyped. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `yes`, `no`, or a dash when the server sent no boolean. */
function yesNo(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "—";
}

/**
 * The chart a widget draws: a query widget's display type (`number`, `line`,
 * `bar`, …), and otherwise the widget's own type (`trace_feed`, or a legacy
 * `detector`), as `widgets create --type` takes it.
 */
export function widgetDisplay(widget: Widget): string {
  if (widget.type !== "query") return orDash(widget.type);
  return orDash(text(record(record(widget.spec)?.display)?.type));
}

/**
 * What a widget charts, in the words `alerts get` writes a metric in:
 * `sum cost of spans by model_name, 1 filter`, or `latest 10 traces` for a
 * trace feed. Filters are counted rather than written out, because the two
 * widget types spell their operators differently; `widgets get` shows them.
 */
export function widgetQuery(widget: Widget): string {
  const spec = record(widget.spec);
  if (spec === undefined) return "—";
  let query: string;
  if (widget.type === "query") {
    const metric = record(spec.metric);
    const view = text(spec.view);
    const agg = text(metric?.agg);
    const measure = text(metric?.measure);
    if (view === undefined || agg === undefined || measure === undefined) return "—";
    query = measure === "count" ? `count of ${view}` : `${agg} ${measure} of ${view}`;
    const breakdown = text(spec.breakdown);
    if (breakdown !== undefined) query += ` by ${breakdown}`;
  } else if (widget.type === "trace_feed") {
    // The page's own default applies when no limit is stored, so no number is
    // claimed that the response did not send.
    query =
      typeof spec.limit === "number"
        ? `latest ${spec.limit} ${plural(spec.limit, "trace")}`
        : "latest traces";
  } else {
    return "—";
  }
  const filters = Array.isArray(spec.filters) ? spec.filters.length : 0;
  if (filters > 0) query += `, ${filters} ${plural(filters, "filter")}`;
  return clean(query);
}

/**
 * Rendering core, network-free. The dashboard and its widgets go to stdout, one
 * row per widget in the order they were created, as `--json` lists them; what
 * to run next goes to stderr. The grid layout is only for the web page.
 */
export function renderDashboard(dashboard: Dashboard, writers: Writers, timeZone?: string): void {
  // An API key reads no creator: the server leaves it out for a project credential.
  const creator = text(dashboard.creator);
  renderFields(
    [
      ["Dashboard ID", orDash(dashboard.id)],
      ["Name", orDash(dashboard.name)],
      ["Description", orDash(dashboard.description)],
      ["Default", yesNo(dashboard.is_default)],
      [
        "Created",
        `${when(dashboard.create_time, timeZone)}${creator === undefined ? "" : ` by ${clean(creator)}`}`,
      ],
      ["Updated", when(dashboard.update_time, timeZone)],
    ],
    writers,
  );

  // A server without the field has said nothing about the widgets.
  const widgets = dashboard.widgets;
  if (widgets === undefined || widgets === null) return;
  if (widgets.length === 0) {
    logProgress("this dashboard has no widgets", writers);
    return;
  }

  const styler = createStyler(writers.out);
  const table = renderTable(
    ["TITLE", "DISPLAY", "QUERY", "WIDGET ID"],
    widgets.map((widget) => [
      orDash(widget.title),
      widgetDisplay(widget),
      widgetQuery(widget),
      orDash(widget.id),
    ]),
    { headerStyle: styler.bold },
  );
  const heading = `${widgets.length} ${plural(widgets.length, "widget")}`;
  writers.out.write(`\n${styler.bold(heading)}\n${table}\n`);

  suggest("read one widget, with its full spec:", ["traceroot widgets get <widget-id>"], writers);
  logProgress("grid positions are left out here; --json prints the full response", writers);
}

export const dashboardsGet: Enhancer = {
  render(payload: unknown, ctx: RenderContext): void {
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      return;
    }
    renderDashboard(payload as Dashboard, ctx.writers);
  },
};
