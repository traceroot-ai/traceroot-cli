import { alertsGet } from "./alerts-get.js";
import { alertsList } from "./alerts-list.js";
import { detectorsList } from "./detectors-list.js";
import { findingsGet } from "./findings-get.js";
import { findingsList } from "./findings-list.js";
import { projectsList } from "./projects-list.js";
import { sql } from "./sql.js";
import { tracesExport } from "./traces-export.js";
import { tracesGet } from "./traces-get.js";
import { tracesList } from "./traces-list.js";
import type { Enhancer } from "./types.js";
import { workspacesList } from "./workspaces-list.js";

/** Per-tool presentation overrides, applied by the factory over the generated
 * defaults. Absence = fully generated command (the zero-code path). */
export const ENHANCERS: Partial<Record<string, Enhancer>> = {
  list_traces: tracesList,
  get_trace: tracesGet,
  export_trace: tracesExport,
  list_detectors: detectorsList,
  get_finding: findingsGet,
  list_findings: findingsList,
  list_alerts: alertsList,
  get_alert: alertsGet,
  list_workspaces: workspacesList,
  list_projects: projectsList,
  run_sql: sql,
};
