import type { Command } from "commander";
import type { DatasetVersionList } from "../../api/client.js";
import { type Writers, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { parseLimit } from "../../time/range.js";
import { rejectExtras } from "../flags.js";
import {
  type PagedState,
  type Wire,
  addLimitFlag,
  countLine,
  limitBounds,
  orDash,
  renderEmptyPage,
  warnIfCapped,
  when,
} from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

type VersionListResponse = Wire<DatasetVersionList>;

/** Rendering core, network-free. */
export function renderVersionList(
  res: VersionListResponse,
  state: PagedState,
  writers: Writers,
  timeZone?: string,
): void {
  const rows = res.versions ?? [];
  if (rows.length === 0) {
    renderEmptyPage(
      "no versions published for this dataset",
      state.limit,
      "list_dataset_versions",
      res.next_cursor,
      "version",
      writers,
    );
    return;
  }
  const styler = createStyler(writers.out);
  const table = renderTable(
    ["VERSION ID", "#", "LABEL", "CASES", "CREATED", "CURRENT"],
    rows.map((v) => [
      orDash(v.dataset_version_id),
      orDash(v.version_number),
      orDash(v.label),
      // A real count or an em dash — never 0 for "not reported".
      orDash(v.case_count),
      when(v.created_at, timeZone),
      // Blank is a statement — "this is not the current version" — so it is kept
      // for a reported `false`. A version whose currency the server never said
      // anything about reads as absent, like every other unreported cell.
      v.is_current === true ? "*" : v.is_current === false ? "" : "—",
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  countLine(rows.length, "version", writers);
  warnIfCapped(
    rows.length,
    state.limit,
    "list_dataset_versions",
    res.next_cursor,
    "version",
    writers,
  );
}

export const datasetVersionsList: Enhancer = {
  flags(cmd: Command): void {
    addLimitFlag(cmd, "list_dataset_versions", "versions");
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const limit = parseLimit(
      input.opts.limit as string | undefined,
      limitBounds("list_dataset_versions").max,
    );
    return {
      args: {
        ...(input.positionals.dataset_id === undefined
          ? {}
          : { dataset_id: input.positionals.dataset_id }),
        ...(limit === undefined ? {} : { limit }),
      },
      state: { limit } satisfies PagedState,
    };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const res = payload as VersionListResponse;
    const state = ctx.state as PagedState;
    if (ctx.json) {
      // stdout stays the response, verbatim; the warning goes to stderr.
      writeJson(payload, ctx.writers);
      const rows = res.versions ?? [];
      warnIfCapped(
        rows.length,
        state.limit,
        "list_dataset_versions",
        res.next_cursor,
        "version",
        ctx.writers,
      );
      return;
    }
    renderVersionList(res, state, ctx.writers);
  },
};
