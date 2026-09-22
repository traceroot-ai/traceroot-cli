import type { Command } from "commander";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { rejectExtras } from "../flags.js";
import { orDash } from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

interface Metric {
  name: string;
  value?: number | null;
  unit?: string | null;
  /** How many cases carried this score or metric. */
  observed_count?: number | null;
  /** numeric: a mean · boolean: the share true, as a 0–1 mean · categorical: no mean. */
  value_type?: "numeric" | "boolean" | "categorical" | null;
}

interface Run {
  evaluation_name: string;
  run_number?: number | null;
  status: string;
  candidate_version?: string | null;
  environment?: string | null;
  dataset_id?: string | null;
  dataset_version_id?: string | null;
  scored_count?: number | null;
  task_error_count?: number | null;
  scorer_error_count?: number | null;
  not_scored_count?: number | null;
  scores?: Metric[] | null;
  metrics?: Metric[] | null;
  run_url?: string | null;
}

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 1000 ? 0 : magnitude >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Rendering core, network-free. */
export function renderRun(run: Run, writers: Writers): void {
  const styler = createStyler(writers.out);
  const w = (line: string) => writers.out.write(`${line}\n`);

  w(`${styler.bold(run.evaluation_name)} · run #${orDash(run.run_number)} · ${run.status}`);
  w(`candidate: ${orDash(run.candidate_version)}        environment: ${orDash(run.environment)}`);
  w(`dataset:   ${orDash(run.dataset_id)}  @ ${orDash(run.dataset_version_id)}`);
  w("");

  w(
    `results    ${run.scored_count ?? 0} scored · ${plural(run.task_error_count ?? 0, "task error")} · ${plural(
      run.scorer_error_count ?? 0,
      "scorer error",
    )} · ${run.not_scored_count ?? 0} not scored`,
  );
  w("");

  renderMetrics(run, writers);

  // Printed verbatim when present, never composed from an id and a host.
  if (run.run_url !== null && run.run_url !== undefined && run.run_url !== "") {
    w("");
    w(run.run_url);
  }
}

/**
 * Scores and derived metrics, in one table.
 *
 * Derived metrics are labelled **mean per case** and never as totals. A run's
 * cost and duration are averages over the observed population; printing a cost
 * unlabelled invites it to be read as what the run spent, which is a different
 * number and usually a much larger one.
 */
function renderMetrics(run: Run, writers: Writers): void {
  const scores = run.scores ?? [];
  const metrics = run.metrics ?? [];
  if (scores.length === 0 && metrics.length === 0) {
    logProgress("no scores or metrics reported for this run", writers);
    return;
  }
  const styler = createStyler(writers.out);
  const table = renderTable(
    ["METRIC", "VALUE", "UNIT", "CASES", ""],
    [
      ...scores.map((m) => [
        m.name,
        metricValue(m),
        orDash(m.unit),
        orDash(m.observed_count),
        m.value_type === "boolean" ? "(share true)" : "",
      ]),
      ...metrics.map((m) => [
        m.name,
        metricValue(m),
        orDash(m.unit),
        orDash(m.observed_count),
        "(mean per case)",
      ]),
    ],
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
}

/**
 * A metric's value, keeping "nothing observed" and "observed but not a number"
 * apart. A categorical score comes back as `value: null` with cases behind it;
 * printing `—` there would claim no case carried it, when every one did.
 */
export function metricValue(m: Metric): string {
  if (m.value !== null && m.value !== undefined) return num(m.value);
  if (m.value_type === "categorical") return "categorical";
  return (m.observed_count ?? 0) > 0 ? "non-numeric" : "—";
}

export const evalRunsGet: Enhancer = {
  description:
    "Read one evaluation run's summary: the dataset version it used, whether it is complete, " +
    "partial or still running, how many cases scored and how many errored or went unscored, " +
    "its scores and per-case cost and duration, and its URL.",
  // Deliberately no flags. Without this override the factory derives flags from
  // the tool's input schema, and a contract that still carries `baseline` would
  // put `--baseline` back. Comparison is a separate operation, not a read option.
  flags(_cmd: Command): void {},
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    return {
      args: input.positionals.run_id === undefined ? {} : { run_id: input.positionals.run_id },
    };
  },
  render(payload: unknown, ctx: RenderContext): void {
    // Verbatim in --json: no reshaping, no derived fields, no client-side
    // arithmetic. This command returns one object, not rows, so there is no
    // count or range envelope to add.
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      return;
    }
    renderRun(payload as Run, ctx.writers);
  },
};
