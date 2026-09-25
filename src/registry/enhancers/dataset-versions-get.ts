import type { Command } from "commander";
import type { DatasetVersion } from "../../api/client.js";
import { type Writers, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { parseLimit } from "../../time/range.js";
import { rejectExtras } from "../flags.js";
import {
  type PagedState,
  type Wire,
  addLimitFlag,
  compact,
  countLine,
  limitBounds,
  orDash,
  renderEmptyPage,
  renderFields,
  warnIfCapped,
} from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

type VersionResponse = Wire<DatasetVersion>;

/**
 * `v3`, `v3 (golden)`, or the bare label when the number is missing — never the
 * label repeated twice when it already is the derived name.
 */
export function versionLabel(
  n: number | null | undefined,
  label: string | null | undefined,
): string | null {
  if (n === null || n === undefined)
    return label === null || label === undefined || label === "" ? null : label;
  const derived = `v${n}`;
  return label === null || label === undefined || label === "" || label === derived
    ? derived
    : `${derived} (${label})`;
}

/** Rendering core, network-free. */
export function renderVersion(res: VersionResponse, state: PagedState, writers: Writers): void {
  const styler = createStyler(writers.out);
  const name = versionLabel(res.version_number, res.label);
  renderFields(
    [
      ["version id", orDash(res.dataset_version_id)],
      ["version", orDash(name)],
      ["dataset id", orDash(res.dataset_id)],
    ],
    writers,
  );
  writers.out.write("\n");

  const items = res.items ?? [];
  if (items.length === 0) {
    renderEmptyPage(
      "this version has no test cases",
      state.limit,
      "get_dataset_version",
      res.next_cursor,
      "case",
      writers,
    );
    return;
  }
  // `input`, `expected` and `metadata` are arbitrary JSON, so they are clipped to
  // a readable width here and left whole in `--json`. FROM TRACE is the case's
  // provenance when it was captured from a real trace rather than authored.
  const table = renderTable(
    ["CASE ID", "INPUT", "EXPECTED", "FROM TRACE"],
    items.map((c) => [
      orDash(c.test_case_id),
      compact(c.input, 44),
      compact(c.expected, 28),
      orDash(c.source_trace_id),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  countLine(items.length, "case", writers);
  warnIfCapped(items.length, state.limit, "get_dataset_version", res.next_cursor, "case", writers);
}

/**
 * Cases per page when `--limit` is not given. Always sent: without a `limit`
 * the server returns the WHOLE version (so SDK pulls are never silently cut),
 * which in a terminal is thousands of table rows. The CLI reads one bounded
 * page and says when there is more.
 */
export const DEFAULT_CASE_PAGE = 200;

export const datasetVersionsGet: Enhancer = {
  // Its own text, not the registry's: the tool tells an agent to follow
  // next_cursor, and this command has no cursor flag. It reads one page.
  description:
    "Read one immutable dataset version: its identity and one page of its test cases " +
    "(input, expected, and the trace a case was captured from), 200 by default and up to " +
    "1000 with --limit. It reads a single page, and says when the version has more.",
  flags(cmd: Command): void {
    addLimitFlag(cmd, "get_dataset_version", "test cases", DEFAULT_CASE_PAGE);
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const limit =
      parseLimit(input.opts.limit as string | undefined, limitBounds("get_dataset_version").max) ??
      DEFAULT_CASE_PAGE;
    return {
      args: {
        ...(input.positionals.version_id === undefined
          ? {}
          : { version_id: input.positionals.version_id }),
        limit,
      },
      state: { limit } satisfies PagedState,
    };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const res = payload as VersionResponse;
    const state = ctx.state as PagedState;
    if (ctx.json) {
      // The CLI always sends a page size, so `--json` is one page too. stdout stays
      // the response, verbatim, and stderr says when it is not the whole version,
      // so a script redirecting stdout does not take one page for the snapshot.
      writeJson(payload, ctx.writers);
      const items = res.items ?? [];
      warnIfCapped(
        items.length,
        state.limit,
        "get_dataset_version",
        res.next_cursor,
        "case",
        ctx.writers,
      );
      return;
    }
    renderVersion(res, state, ctx.writers);
  },
};
