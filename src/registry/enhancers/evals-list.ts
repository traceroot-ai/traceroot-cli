import type { Command } from "commander";
import type { EvaluationList } from "../../api/client.js";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { parseLimit } from "../../time/range.js";
import { onceOption, rejectExtras } from "../flags.js";
import {
  type PagedState,
  type Wire,
  addLimitFlag,
  countLine,
  limitBounds,
  orDash,
  warnIfCapped,
  when,
} from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

type EvaluationListResponse = Wire<EvaluationList>;
type Evaluation = NonNullable<EvaluationListResponse["evaluations"]>[number];

/**
 * The run this evaluation last started, as one cell: `#12 completed`.
 *
 * `(none)` is for an evaluation that exists and has never run — a different
 * fact from a run whose number or status the server did not report.
 */
export function latestRun(run: Evaluation["latest_run"]): string {
  if (run === null || run === undefined) return "(none)";
  return `#${orDash(run.run_number)} ${orDash(run.status)}`;
}

/** Rendering core, network-free. */
export function renderEvaluationList(
  res: EvaluationListResponse,
  state: PagedState,
  writers: Writers,
  timeZone?: string,
): void {
  const rows = res.evaluations ?? [];
  if (rows.length === 0) {
    logProgress("no evaluations", writers);
    return;
  }
  const styler = createStyler(writers.out);
  // RUNS is the run count, and LATEST RUN / STARTED describe the newest one, so
  // `evals runs list --evaluation-id` has somewhere to go next.
  const table = renderTable(
    ["EVALUATION ID", "NAME", "DATASET", "RUNS", "LATEST RUN", "STARTED"],
    rows.map((e) => [
      orDash(e.evaluation_id),
      orDash(e.name),
      orDash(e.dataset_id),
      orDash(e.run_count),
      latestRun(e.latest_run),
      when(e.latest_run?.started_at, timeZone),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  countLine(rows.length, "evaluation", writers);
  warnIfCapped(
    rows.length,
    state.limit,
    "list_evaluations",
    res.next_cursor,
    "evaluation",
    writers,
  );
}

export const evalsList: Enhancer = {
  description:
    "List the project's evaluations, newest first: how many runs each has and how its latest run " +
    "ended. Start here when you need a run id for `evals runs get`.",
  flags(cmd: Command): void {
    addLimitFlag(cmd, "list_evaluations", "evaluations").option(
      "--name <substring>",
      "filter to evaluations whose name contains this text, case-insensitively",
      onceOption("--name"),
    );
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const limit = parseLimit(
      input.opts.limit as string | undefined,
      limitBounds("list_evaluations").max,
    );
    const name = input.opts.name as string | undefined;
    return {
      args: {
        ...(limit === undefined ? {} : { limit }),
        ...(name === undefined ? {} : { name }),
      },
      state: { limit } satisfies PagedState,
    };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const res = payload as EvaluationListResponse;
    const state = ctx.state as PagedState;
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      const rows = res.evaluations ?? [];
      warnIfCapped(
        rows.length,
        state.limit,
        "list_evaluations",
        res.next_cursor,
        "evaluation",
        ctx.writers,
      );
      return;
    }
    renderEvaluationList(res, state, ctx.writers);
  },
};
