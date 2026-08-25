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
      /** [group, subcommand] or [top-level name]. Positional arguments are
       * derived by the factory from the tool's path template ({placeholders}),
       * so they are never declared here. */
      path: [string, string] | [string];
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
};

/** Group commands in `--help` order, with the description each group shows. */
export const GROUPS: Record<string, string> = {
  traces: "Work with traces",
  detectors: "Work with detectors",
  findings: "Work with detector findings",
};
