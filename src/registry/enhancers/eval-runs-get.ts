import type { Command } from "commander";
import type { EvaluationRun } from "../../api/client.js";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { rejectExtras } from "../flags.js";
import { type Wire, clean, orDash, plural } from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

type Run = Wire<EvaluationRun>;
type Metric = NonNullable<Run["scores"]>[number];

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  // Also catches -0, which would otherwise print as "-0".
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  // Below 1, keep significant digits rather than decimal places. A small mean,
  // such as a per-case cost of $0.00004, must never round to a "0" that reads
  // as a measured zero.
  if (magnitude < 1) return value.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  return value.toLocaleString("en-US", { maximumFractionDigits: magnitude >= 1000 ? 0 : 2 });
}

/**
 * `<n> <noun>`, or `— <noun>` when the count is absent. Never `0` for "not
 * reported". A `countable` noun is pluralised by the shared rule ("1 task error",
 * "2 task errors"); "scored" and "reported" read the same at any count.
 */
function count(n: number | null | undefined, noun: string, countable = false): string {
  const word = (k: number) => (countable ? plural(k, noun) : noun);
  return n === null || n === undefined ? `— ${word(2)}` : `${n} ${word(n)}`;
}

/**
 * How the run's results came out. Passed and failed are shown only when a result
 * carries one of those statuses. Released SDK versions still write them, but
 * current ones report per-score results instead, and a pair of zeros would claim a
 * verdict nobody gave.
 */
export function resultsLine(run: Run): string {
  const parts = [count(run.result_count, "reported"), count(run.scored_count, "scored")];
  if ((run.passed_count ?? 0) + (run.failed_count ?? 0) > 0) {
    parts.push(count(run.passed_count, "passed"), count(run.failed_count, "failed"));
  }
  parts.push(
    count(run.task_error_count, "task error", true),
    count(run.scorer_error_count, "scorer error", true),
    count(run.not_scored_count, "not scored"),
  );
  return parts.join(" · ");
}

/** Rendering core, network-free. */
export function renderRun(run: Run, writers: Writers): void {
  const styler = createStyler(writers.out);
  const w = (line: string) => writers.out.write(`${line}\n`);

  w(
    `${styler.bold(orDash(run.evaluation_name))} · run #${orDash(run.run_number)} · ${orDash(run.status)}`,
  );
  w(`candidate: ${orDash(run.candidate_version)}        environment: ${orDash(run.environment)}`);
  w(`dataset:   ${orDash(run.dataset_id)}  @ ${orDash(run.dataset_version_id)}`);
  w("");

  w(`results    ${resultsLine(run)}`);
  w("");

  renderMetrics(run, writers);

  // Printed verbatim when present, never composed from an id and a host.
  if (run.run_url !== null && run.run_url !== undefined && run.run_url !== "") {
    w("");
    w(clean(run.run_url));
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
        orDash(m.name),
        metricValue(m),
        orDash(m.unit),
        orDash(m.observed_count),
        m.value_type === "boolean" ? "(share true)" : "",
      ]),
      ...metrics.map((m) => [
        orDash(m.name),
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
