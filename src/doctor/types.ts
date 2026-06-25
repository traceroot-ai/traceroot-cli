/** Outcome of a single diagnostic check. */
export type DoctorStatus = "pass" | "warn" | "fail";

/** Grouping for related checks in the report. */
export type DoctorCategory =
  | "credentials"
  | "traceroot_files"
  | "agent_skills"
  | "repo"
  | "runtime_env";

/** A single diagnostic result. */
export interface DoctorCheck {
  /** Stable machine-readable id (snake_case). */
  name: string;
  category: DoctorCategory;
  status: DoctorStatus;
  /** Human-readable, secret-free explanation. */
  message: string;
}

/** Aggregate counts across all checks. */
export interface DoctorSummary {
  pass: number;
  warn: number;
  fail: number;
}

/** The full doctor result, serialized under `data` in `--json` mode. */
export interface DoctorReport {
  checks: DoctorCheck[];
  summary: DoctorSummary;
}
