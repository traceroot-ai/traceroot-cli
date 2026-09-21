import type { Command } from "commander";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { parseLimit } from "../../time/range.js";
import { rejectExtras } from "../flags.js";
import {
  type PagedState,
  addLimitFlag,
  compact,
  countLine,
  limitBounds,
  orDash,
  warnIfCapped,
} from "./eval-reads.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

interface TestCase {
  test_case_id: string;
  input?: unknown;
  expected?: unknown;
  metadata?: unknown;
  source_trace_id?: string | null;
  source_span_id?: string | null;
}

interface VersionResponse {
  dataset_id?: string;
  dataset_version_id: string;
  version_number?: number | null;
  label?: string | null;
  items: TestCase[];
  next_cursor?: string | null;
}

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
  const header: [string, string][] = [
    ["version id", res.dataset_version_id],
    ["version", orDash(name)],
    ["dataset id", orDash(res.dataset_id)],
  ];
  const width = Math.max(...header.map(([label]) => label.length));
  for (const [label, value] of header) {
    writers.out.write(`${styler.bold(label.padEnd(width))}  ${value}\n`);
  }
  writers.out.write("\n");

  const items = res.items ?? [];
  if (items.length === 0) {
    logProgress("this version has no test cases", writers);
    return;
  }
  // `input`, `expected` and `metadata` are arbitrary JSON, so they are clipped to
  // a readable width here and left whole in `--json`. FROM TRACE is the case's
  // provenance when it was captured from a real trace rather than authored.
  const table = renderTable(
    ["CASE ID", "INPUT", "EXPECTED", "FROM TRACE"],
    items.map((c) => [
      c.test_case_id,
      compact(c.input, 44),
      compact(c.expected, 28),
      orDash(c.source_trace_id),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`${table}\n`);
  countLine(items.length, "case", writers);
  warnIfCapped(items.length, state.limit, "get_dataset_version", res.next_cursor, "cases", writers);
}

export const datasetVersionsGet: Enhancer = {
  flags(cmd: Command): void {
    addLimitFlag(cmd, "get_dataset_version", "test cases");
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const limit = parseLimit(
      input.opts.limit as string | undefined,
      limitBounds("get_dataset_version").max,
    );
    return {
      args: {
        ...(input.positionals.version_id === undefined
          ? {}
          : { version_id: input.positionals.version_id }),
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
    renderVersion(payload as VersionResponse, ctx.state as PagedState, ctx.writers);
  },
};
