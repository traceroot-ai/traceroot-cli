/**
 * Where each registry tool surfaces in the CLI. EVERY tool must have an entry —
 * tests/registry/naming.test.ts fails the build for an unplaced tool. Placing a
 * brand-new endpoint is one line here; no handler code.
 *
 * Declaration order is meaningful: groups and subcommands register in this order,
 * which fixes `--help` ordering.
 */
export type Placement =
  | {
      kind: "command";
      /** [top-level name], [group, subcommand], or [group, subgroup, subcommand].
       * Every segment but the last is a group and needs a GROUPS entry under its
       * space-joined path. Positional arguments are derived by the factory from
       * the tool's path template ({placeholders}), so they are never declared here. */
      path: [string] | [string, string] | [string, string, string];
    }
  | {
      /** Dispatched by another command's enhancer; never gets its own command. */
      kind: "companion";
      /** Tool names of the command placements allowed to dispatch it. */
      of: string[];
      note: string;
    }
  | {
      /** Deliberately no CLI surface. */
      kind: "internal";
      note: string;
    };

export const PLACEMENTS: Record<string, Placement> = {
  list_traces: { kind: "command", path: ["traces", "list"] },
  get_trace: { kind: "command", path: ["traces", "get"] },
  export_trace: { kind: "command", path: ["traces", "export"] },
  list_trace_filter_values: {
    kind: "internal",
    note: "deliberately no CLI surface: per-field trace filtering belongs to the SQL query surface",
  },
  list_detectors: { kind: "command", path: ["detectors", "list"] },
  get_detector: { kind: "command", path: ["detectors", "get"] },
  list_findings: { kind: "command", path: ["findings", "list"] },
  get_finding: { kind: "command", path: ["findings", "get"] },
  get_finding_by_trace: {
    kind: "companion",
    of: ["get_finding", "get_trace", "export_trace"],
    note: "reached via 'findings get --trace' and the best-effort finding lookups in 'traces get'/'traces export'",
  },
  list_sessions: {
    kind: "internal",
    note: "deliberately no CLI surface: session reading belongs to the SQL query surface",
  },
  get_session: {
    kind: "internal",
    note: "deliberately no CLI surface: session reading belongs to the SQL query surface",
  },
  whoami: {
    kind: "internal",
    note: "served by 'status', 'login', and 'doctor'; deliberately no standalone command",
  },
  list_alerts: { kind: "command", path: ["alerts", "list"] },
  get_alert: { kind: "command", path: ["alerts", "get"] },
  create_alert: { kind: "command", path: ["alerts", "create"] },
  list_dashboards: { kind: "command", path: ["dashboards", "list"] },
  get_dashboard: { kind: "command", path: ["dashboards", "get"] },
  create_dashboard: { kind: "command", path: ["dashboards", "create"] },
  list_workspaces: { kind: "command", path: ["workspaces", "list"] },
  list_projects: { kind: "command", path: ["projects", "list"] },
  create_workspace: { kind: "command", path: ["workspaces", "create"] },
  create_project: { kind: "command", path: ["projects", "create"] },
  create_detector: { kind: "command", path: ["detectors", "create"] },
  create_widget: { kind: "command", path: ["widgets", "create"] },
  run_sql: { kind: "command", path: ["sql"] },
  get_sql_schema: { kind: "command", path: ["sql", "schema"] },
  get_dashboard_data: {
    kind: "internal",
    note: "deliberately no CLI surface: a whole dashboard's data is read in the web app",
  },
  run_widget_query: {
    kind: "internal",
    note: "no CLI surface yet: a widget's own query belongs with the dashboards commands",
  },
  list_datasets: { kind: "command", path: ["datasets", "list"] },
  get_dataset: { kind: "command", path: ["datasets", "get"] },
  list_dataset_versions: { kind: "command", path: ["datasets", "versions", "list"] },
  get_dataset_version: { kind: "command", path: ["datasets", "versions", "get"] },
  list_evaluations: { kind: "command", path: ["evals", "list"] },
  list_evaluation_runs: { kind: "command", path: ["evals", "runs", "list"] },
  get_evaluation_run: { kind: "command", path: ["evals", "runs", "get"] },
};

/**
 * Group commands in `--help` order, with the description each group shows.
 * A nested group is keyed by its space-joined path ("datasets versions"), and
 * must be listed after its parent so `--help` ordering follows declaration.
 */
export const GROUPS: Record<string, string> = {
  workspaces: "Discover your workspaces (user credentials)",
  projects: "Discover your projects (user credentials)",
  traces: "Work with traces",
  detectors: "Work with detectors",
  findings: "Work with detector findings",
  alerts: "Work with threshold alerts",
  dashboards: "Work with dashboards",
  widgets: "Work with dashboard widgets",
  sql: "Query your spans and traces with SQL",
  datasets: "Work with evaluation datasets",
  "datasets versions": "Work with a dataset's published versions",
  evals: "Work with evaluations",
  "evals runs": "Read recorded evaluation runs",
};
