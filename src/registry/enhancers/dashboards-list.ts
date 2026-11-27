import type { DashboardList } from "../../api/client.js";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { yesNo } from "./dashboards-get.js";
import { type Wire, countLine, orDash, when } from "./eval-reads.js";
import type { Enhancer, RenderContext } from "./types.js";

type DashboardListResponse = Wire<DashboardList>;

/**
 * Rendering core, network-free. One row per dashboard, in the order the server
 * lists them (default first). The description and creator are left out: they
 * are free text that would make every row as wide as the longest one, and
 * `dashboards get` and --json still print them.
 */
export function renderDashboardList(
  res: DashboardListResponse,
  writers: Writers,
  timeZone?: string,
): void {
  const rows = res.data ?? [];
  if (rows.length === 0) {
    logProgress("no dashboards", writers);
    return;
  }
  const styler = createStyler(writers.out);
  // The id comes first, so a row that wraps on a narrow terminal never splits
  // it, and the name sits beside it.
  const table = renderTable(
    ["DASHBOARD ID", "NAME", "DEFAULT", "WIDGETS", "UPDATED"],
    rows.map((d) => [
      orDash(d.id),
      orDash(d.name),
      yesNo(d.is_default),
      orDash(d.widget_count),
      when(d.update_time, timeZone),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  countLine(rows.length, "dashboard", writers);
}

export const dashboardsList: Enhancer = {
  description:
    "List the project's dashboards, default first: each one's dashboard id, its name, whether " +
    "it is the default, its widget count, and when it was last updated. `dashboards get " +
    "<dashboard-id>` and --json also show the description and creator. To resolve a dashboard " +
    "by name, list here and match its name — never guess a dashboard id.",
  render(payload: unknown, ctx: RenderContext): void {
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      return;
    }
    renderDashboardList(payload as DashboardListResponse, ctx.writers);
  },
};
