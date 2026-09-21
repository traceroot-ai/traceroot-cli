import type { Command } from "commander";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { onceOption, rejectExtras } from "../flags.js";
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
  baseline_value?: number | null;
  diff?: number | null;
  paired_count?: number | null;
  improvements?: number | null;
  regressions?: number | null;
}

interface Comparison {
  baseline_run_number?: number | null;
  baseline_coverage: Coverage;
  state: string;
  trustworthy?: boolean | null;
  reasons?: string[] | null;
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
  not_scored_count?: number | null;
  scores?: Metric[] | null;
  metrics?: Metric[] | null;
  comparison?: Comparison | null;
  run_url?: string | null;
}

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 1000 ? 0 : magnitude >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function signed(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const rendered = num(Math.abs(value));
  if (value > 0) return `+${rendered}`;
  if (value < 0) return `-${rendered}`;
  return rendered;
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
    `results    ${run.scored_count ?? 0} scored · ${run.task_error_count ?? 0} task error${
      (run.task_error_count ?? 0) === 1 ? "" : "s"
    } · ${run.not_scored_count ?? 0} not scored`,
  );
  w("");

  const comparison = run.comparison ?? null;
  if (comparison === null) {
    renderMetrics(run, writers);
    logProgress("no baseline — pass --baseline <run-id> to compare", writers);
  } else {
    renderComparison(run, comparison, writers);
  }

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
    ["METRIC", "VALUE", "UNIT", ""],
    [
      ...scores.map((m) => [m.name, num(m.value), orDash(m.unit), ""]),
      ...metrics.map((m) => [m.name, num(m.value), orDash(m.unit), "(mean per case)"]),
    ],
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
}

/**
 * The comparison, with its trust state ALWAYS attached.
 *
 * A diff without its trust state is the failure this exists to prevent: a subset
 * on either side makes the comparison exploratory, and the number still looks
 * like a verdict.
 */
function renderComparison(run: Run, comparison: Comparison, writers: Writers): void {
  const styler = createStyler(writers.out);
  const w = (line: string) => writers.out.write(`${line}\n`);
  // The run's own coverage is already on screen from the header block. Printing
  // it again beside the baseline's read as two different facts and invited the
  // reader to compare the wrong pair; only the baseline's is new here.
  w(
    `baseline   run #${orDash(comparison.baseline_run_number)} · ${coverageLine(comparison.baseline_coverage)}`,
  );
  const reasons = comparison.reasons ?? [];
  const verdict =
    comparison.trustworthy === true
      ? comparison.state.toUpperCase()
      : `${comparison.state.toUpperCase()} — not trustworthy${reasons.length > 0 ? `: ${reasons.join(", ")}` : ""}`;
  w(`comparison ${verdict}`);
  w("");

  const all = [
    ...(run.scores ?? []).map((m) => ({ m, derived: false })),
    ...(run.metrics ?? []).map((m) => ({ m, derived: true })),
  ];
  if (all.length === 0) {
    logProgress("no scores or metrics reported for this run", writers);
    return;
  }
  const table = renderTable(
    ["METRIC", "VALUE", "BASELINE", "DIFF", "PAIRED", "+/-", ""],
    all.map(({ m, derived }) => {
      // An absent metric still emits a row: absence is information, and a metric
      // that disappeared between two runs is exactly what a reader needs to see.
      const missing =
        (m.value === null || m.value === undefined) &&
        (m.baseline_value === null || m.baseline_value === undefined);
      // The "mean per case" label survives into the comparison view. It is MORE
      // load-bearing here, not less: a diff of +24 on a per-case mean and a diff
      // of +24 on a run total are different claims, and the baseline column makes
      // the number look like a verdict.
      const notes = [derived ? "mean per case" : null, missing ? "not reported this run" : null]
        .filter((n): n is string => n !== null)
        .join(" · ");
      return [
        m.name,
        num(m.value),
        num(m.baseline_value),
        signed(m.diff),
        String(m.paired_count ?? 0),
        `${m.improvements ?? 0}/${m.regressions ?? 0}`,
        notes === "" ? "" : `(${notes})`,
      ];
    }),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
}

export const evalRunsGet: Enhancer = {
  description:
    "Read one evaluation run: its coverage, scores, derived metrics, and — with --baseline — " +
    "a per-metric comparison carrying the trust state that says whether the diff is a verdict.",
  flags(cmd: Command): void {
    cmd.option(
      "--baseline <run-id>",
      "another run in this project to compare against",
      onceOption("--baseline"),
    );
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const baseline = input.opts.baseline as string | undefined;
    return {
      args: {
        ...(input.positionals.run_id === undefined ? {} : { run_id: input.positionals.run_id }),
        ...(baseline === undefined ? {} : { baseline }),
      },
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
