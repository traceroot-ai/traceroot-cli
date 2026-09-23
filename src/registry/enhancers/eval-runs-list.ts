import { REGISTRY } from "@traceroot-ai/tools";
import type { Command } from "commander";
import type { EvaluationRunList } from "../../api/client.js";
import { CliError, ExitCode, type Writers, logProgress, writeJson } from "../../output.js";
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

type RunListResponse = Wire<EvaluationRunList>;

/**
 * The statuses the contract accepts, read from the registry rather than copied,
 * so a new one flows in with the next tools release instead of being rejected
 * here. Checked locally to keep a typo a usage error rather than a 422.
 */
export function runStatuses(): string[] {
  const schema = REGISTRY.find((entry) => entry.name === "list_evaluation_runs")?.inputSchema
    .properties.status;
  const values = (schema as { enum?: unknown } | undefined)?.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
}

/** Rendering core, network-free. */
export function renderRunList(
  res: RunListResponse,
  state: PagedState,
  writers: Writers,
  timeZone?: string,
): void {
  const rows = res.runs ?? [];
  if (rows.length === 0) {
    logProgress("no evaluation runs", writers);
    return;
  }
  const styler = createStyler(writers.out);
  // No scores, counts or cost: those are aggregates over a run's results, and the
  // contract leaves them to `evals runs get` one run at a time. STARTED is what a
  // reader scans to find last night's run.
  const table = renderTable(
    ["RUN ID", "EVALUATION", "#", "STATUS", "CANDIDATE", "STARTED"],
    rows.map((r) => [
      orDash(r.evaluation_run_id),
      orDash(r.evaluation_name),
      orDash(r.run_number),
      orDash(r.status),
      orDash(r.candidate_version),
      when(r.started_at, timeZone),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  countLine(rows.length, "run", writers);
  warnIfCapped(rows.length, state.limit, "list_evaluation_runs", res.next_cursor, "run", writers);
}

export const evalRunsList: Enhancer = {
  description:
    "List the project's evaluation runs, newest first, with the id each one is read by. Filter to " +
    "one evaluation with --evaluation-id, or to a status with --status.",
  flags(cmd: Command): void {
    addLimitFlag(cmd, "list_evaluation_runs", "runs")
      .option(
        "--evaluation-id <id>",
        "only runs of this evaluation (from `traceroot evals list`)",
        onceOption("--evaluation-id"),
      )
      .option(
        "--status <status>",
        `only runs with this status: ${runStatuses().join(", ")}`,
        onceOption("--status"),
      );
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const limit = parseLimit(
      input.opts.limit as string | undefined,
      limitBounds("list_evaluation_runs").max,
    );
    const evaluationId = input.opts.evaluationId as string | undefined;
    const status = input.opts.status as string | undefined;
    const allowed = runStatuses();
    if (status !== undefined && allowed.length > 0 && !allowed.includes(status)) {
      throw new CliError(`--status must be one of: ${allowed.join(", ")}`, ExitCode.usage);
    }
    return {
      args: {
        ...(limit === undefined ? {} : { limit }),
        ...(evaluationId === undefined ? {} : { evaluation_id: evaluationId }),
        ...(status === undefined ? {} : { status }),
      },
      state: { limit } satisfies PagedState,
    };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const res = payload as RunListResponse;
    const state = ctx.state as PagedState;
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      const rows = res.runs ?? [];
      warnIfCapped(
        rows.length,
        state.limit,
        "list_evaluation_runs",
        res.next_cursor,
        "run",
        ctx.writers,
      );
      return;
    }
    renderRunList(res, state, ctx.writers);
  },
};
