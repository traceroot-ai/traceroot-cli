import type { Command } from "commander";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { rejectExtras } from "../flags.js";
import { orDash } from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

interface Coverage {
  mode: string;
  selected_case_count?: number | null;
  dataset_case_count?: number | null;
  sample_seed?: number | null;
}

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
  coverage: Coverage;
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

/**
 * Coverage, in the run's own terms.
 *
 * `mode: "unknown"` is never promoted to "full": full coverage that cannot be
 * proven must not be claimed, and a run that never declared what it covered is a
 * different thing from one that measured everything.
 */
export function coverageLine(c: Coverage): string {
  const seed =
    c.sample_seed === null || c.sample_seed === undefined ? "" : ` (seed ${c.sample_seed})`;
  if (c.mode === "unknown") return "unknown — this run did not declare what it covered";
  const selected = c.selected_case_count;
  const total = c.dataset_case_count;
  if (selected === null || selected === undefined || total === null || total === undefined) {
    return `${c.mode}${seed}`;
  }
  return `${c.mode} — ${num(selected)} of ${num(total)} cases${seed}`;
}

/** Rendering core, network-free. */
export function renderRun(run: Run, writers: Writers): void {
  const styler = createStyler(writers.out);
  const w = (line: string) => writers.out.write(`${line}\n`);

  w(`${styler.bold(run.evaluation_name)} · run #${orDash(run.run_number)} · ${run.status}`);
  w(`candidate: ${orDash(run.candidate_version)}        environment: ${orDash(run.environment)}`);
  w(`dataset:   ${orDash(run.dataset_id)}  @ ${orDash(run.dataset_version_id)}`);
  w("");

  // A run that covered less than the dataset is not a final answer about the
  // dataset, and the label says so rather than leaving it to be inferred.
  const finality = run.coverage.mode === "full" ? "" : "          NOT FINAL";
  w(`coverage   ${coverageLine(run.coverage)}${finality}`);
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
 * cost, tokens, calls and duration are averages over the observed population;
 * printing `1,204 tok` unlabelled invites it to be read as what the run spent,
 * which is a different number and usually a much larger one.
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
    "partial or still running, how many cases it covered and how many errored or went " +
    "unscored, its scores and per-case metrics, and its URL.",
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
