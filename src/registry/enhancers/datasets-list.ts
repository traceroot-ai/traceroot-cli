import type { Command } from "commander";
import type { DatasetList } from "../../api/client.js";
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
  orNone,
  warnIfCapped,
} from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

type DatasetListResponse = Wire<DatasetList>;

/** Rendering core, network-free so the table can be tested without a transport. */
export function renderDatasetList(
  res: DatasetListResponse,
  state: PagedState,
  writers: Writers,
): void {
  const rows = res.datasets ?? [];
  if (rows.length === 0) {
    logProgress("no datasets", writers);
    return;
  }
  // No UPDATED column and no case count: the delivered dataset read returns
  // identity only. A column of em dashes would imply the data exists and is
  // missing, rather than that it was never part of the contract. A case count
  // lives on a version, where it is one grouped aggregate instead of an N+1.
  const styler = createStyler(writers.out);
  const table = renderTable(
    ["DATASET ID", "NAME", "KEY", "CURRENT VERSION"],
    rows.map((d) => [
      orDash(d.dataset_id),
      orDash(d.name),
      orDash(d.key),
      // A dataset with nothing published is not an error and not a blank: it has
      // no current version yet, and `datasets versions get` has nothing to read.
      orNone(d.current_dataset_version_id),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  countLine(rows.length, "dataset", writers);
  warnIfCapped(rows.length, state.limit, "list_datasets", res.next_cursor, "dataset", writers);
}

export const datasetsList: Enhancer = {
  flags(cmd: Command): void {
    addLimitFlag(cmd, "list_datasets", "datasets").option(
      "--name <substring>",
      "filter to datasets whose name contains this text, case-insensitively",
      onceOption("--name"),
    );
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const limit = parseLimit(
      input.opts.limit as string | undefined,
      limitBounds("list_datasets").max,
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
    const res = payload as DatasetListResponse;
    const state = ctx.state as PagedState;
    if (ctx.json) {
      // stdout stays the response, verbatim; the warning goes to stderr so a
      // script still learns that this page is not every dataset.
      writeJson(payload, ctx.writers);
      const rows = res.datasets ?? [];
      warnIfCapped(
        rows.length,
        state.limit,
        "list_datasets",
        res.next_cursor,
        "dataset",
        ctx.writers,
      );
      return;
    }
    renderDatasetList(res, state, ctx.writers);
  },
};
