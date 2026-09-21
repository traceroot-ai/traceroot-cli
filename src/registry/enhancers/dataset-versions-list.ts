import type { Command } from "commander";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { parseLimit } from "../../time/range.js";
import { rejectExtras } from "../flags.js";
import {
  type PagedState,
  addLimitFlag,
  countLine,
  day,
  limitBounds,
  orDash,
  warnIfCapped,
} from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

interface VersionRow {
  dataset_version_id: string;
  version_number?: number | null;
  label?: string | null;
  case_count?: number | null;
  created_at?: string | null;
  is_current?: boolean | null;
}

interface VersionListResponse {
  versions: VersionRow[];
  next_cursor?: string | null;
}

/** Rendering core, network-free. */
export function renderVersionList(
  res: VersionListResponse,
  state: PagedState,
  writers: Writers,
): void {
  const rows = res.versions ?? [];
  if (rows.length === 0) {
    logProgress("no versions published for this dataset", writers);
    return;
  }
  const styler = createStyler(writers.out);
  const table = renderTable(
    ["VERSION ID", "#", "LABEL", "CASES", "CREATED", "CURRENT"],
    rows.map((v) => [
      v.dataset_version_id,
      orDash(v.version_number),
      orDash(v.label),
      // A real count or an em dash — never 0 for "not reported".
      orDash(v.case_count),
      day(v.created_at),
      v.is_current === true ? "*" : "",
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
    "versions",
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
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      return;
    }
    renderVersionList(payload as VersionListResponse, ctx.state as PagedState, ctx.writers);
  },
};
