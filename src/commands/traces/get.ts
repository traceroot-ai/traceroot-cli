import type { Command } from "commander";
import type { ApiClient, FindingDetail, TraceDetail } from "../../api/client.js";
import { CliError, type Writers, colorEnabled, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import {
  filterErrorsWithAncestors,
  renderTree,
  spansWithinDepth,
  treeOrder,
} from "../../render/tree.js";
import { formatDuration, formatTimestamp, parseBackendTime } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";
import { onceOption } from "./list.js";

/** Max width for the single-line RCA preview shown inline in `traces get`. */
const RCA_PREVIEW_MAX = 80;

/**
 * Collapse an RCA to one truncated line (code-point safe) for the inline
 * preview. A leading list bullet (`- `/`* `) is stripped so the preview reads as
 * a sentence rather than a fragment of a list.
 */
function rcaPreview(result: string): string {
  const oneLine = result
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*]\s+/, "");
  const chars = Array.from(oneLine);
  return chars.length > RCA_PREVIEW_MAX
    ? `${chars.slice(0, RCA_PREVIEW_MAX - 1).join("")}…`
    : oneLine;
}

/** Dependencies for the testable core of `traces get`. */
export interface RunGetDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  traceId: string;
  /** Cap emitted spans (tree + JSON). Undefined = no cap. */
  maxSpans?: number;
  /** Cap tree depth, roots = 1 (tree + JSON). Undefined = no cap. */
  depth?: number;
  /** Keep only error spans plus their ancestor chains. */
  errorsOnly?: boolean;
  /**
   * Machine output format. `"jsonl"` streams a header line (trace minus spans,
   * plus `finding`) then one span per line; it implies machine output whether or
   * not the global `--json` flag is set. Undefined = follow `json`.
   */
  output?: "jsonl";
}

/**
 * Applies the `traces get` span bounds in a fixed order — `--errors-only` first,
 * then `--depth`, then `--max-spans` — so the human tree and the JSON/JSONL
 * emitters always work from the same set. Returns the spans to emit plus the
 * counts the truncation marker and empty-result indicators need.
 */
function boundSpans(
  spans: Span[],
  opts: { maxSpans?: number; depth?: number; errorsOnly?: boolean },
): {
  /** Errors-only working set (or all spans); what the human tree renders. */
  working: Span[];
  /** Final capped list emitted by the JSON/JSONL paths. */
  shown: Span[];
  /** Post-depth total the `--max-spans` marker reports against. */
  depthTotal: number;
  /** True when `--errors-only` matched nothing. */
  errorsOnlyEmpty: boolean;
} {
  const working = opts.errorsOnly === true ? filterErrorsWithAncestors(spans) : spans;
  const depthFiltered = opts.depth !== undefined ? spansWithinDepth(working, opts.depth) : working;
  // `--max-spans` SELECTS the first n spans in tree traversal order — the same
  // order the human tree prints, via the shared `treeOrder` — so both modes keep
  // the SAME spans. The kept spans are then EMITTED in their original backend
  // array order, keeping the JSON/JSONL body array-stable.
  let shown = depthFiltered;
  if (opts.maxSpans !== undefined && opts.maxSpans < depthFiltered.length) {
    const keep = new Set(
      treeOrder(depthFiltered)
        .slice(0, opts.maxSpans)
        .map((s) => s.span_id),
    );
    shown = depthFiltered.filter((s) => keep.has(s.span_id));
  }
  return {
    working,
    shown,
    depthTotal: depthFiltered.length,
    errorsOnlyEmpty: opts.errorsOnly === true && working.length === 0,
  };
}

type Span = TraceDetail["spans"][number];

/** Latest span end time across all spans, or null when none have ended. */
function latestSpanEnd(spans: Span[]): string | null {
  let max: string | null = null;
  for (const span of spans) {
    if (span.span_end_time !== null && (max === null || span.span_end_time > max)) {
      max = span.span_end_time;
    }
  }
  return max;
}

/** A trace is live (still running) when at least one span has no end time yet. */
function isLive(spans: Span[]): boolean {
  return spans.some((span) => span.span_end_time === null);
}

/** Milliseconds between two ISO timestamps, or null when not derivable. */
function elapsedMs(start: string, end: string | null): number | null {
  if (end === null) {
    return null;
  }
  // Parse both as zone-less UTC so the live path (end is a real-UTC ISO) and the
  // completed path stay consistent; a bare `new Date(...)` would misread the
  // zone-less backend start time as host-local and skew the elapsed math.
  const startDate = parseBackendTime(start);
  const endDate = parseBackendTime(end);
  if (startDate === null || endDate === null) {
    return null;
  }
  const ms = endDate.getTime() - startDate.getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Core, network-free logic for `traces get`. Tests inject a fake client. */
export async function runGet(deps: RunGetDeps): Promise<void> {
  const { client, json, writers, traceId, maxSpans, depth, errorsOnly, output } = deps;
  const trace = await client.getTrace(traceId);

  // Best-effort: surface the detector finding for this trace (findings are
  // 1-per-trace). A 404 means "not flagged" (null); any other failure must not
  // break `traces get`, so it also degrades to no finding.
  let finding: FindingDetail | null = null;
  try {
    finding = await client.findFindingByTrace(traceId);
  } catch {
    finding = null;
  }

  // Apply the bounding flags ONCE; every emit path reads from this result so the
  // human tree and the JSON/JSONL bodies can never diverge.
  const { working, shown, depthTotal, errorsOnlyEmpty } = boundSpans(trace.spans, {
    maxSpans,
    depth,
    errorsOnly,
  });
  // Only `--max-spans` advertises a truncation marker (with the true post-filter
  // total); `--depth` simply omits deeper spans. Present only when it fires, so
  // default output is byte-identical to before.
  const truncated = shown.length < depthTotal;
  const marker = truncated ? { spans_truncated: { shown: shown.length, total: depthTotal } } : {};
  // `--errors-only` matching nothing is surfaced explicitly rather than as a
  // silent empty span list.
  const emptyMarker = errorsOnlyEmpty ? { errors_only_no_matches: true } : {};

  if (output === "jsonl") {
    // Header first (all trace fields except spans, plus finding + any markers),
    // then one span per line, written incrementally so a downstream `head`/`grep`
    // can stop us early (the global EPIPE handler makes that a clean exit).
    const { spans: _spans, ...header } = trace;
    writeJson({ ...header, finding, ...marker, ...emptyMarker }, writers);
    for (const span of shown) {
      writeJson(span, writers);
    }
    return;
  }

  if (json) {
    // The full trace with its spans bounded by the flags, plus the finding (or
    // null) so scripts get everything in one call.
    writeJson({ ...trace, spans: shown, finding, ...marker, ...emptyMarker }, writers);
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const live = isLive(trace.spans);

  // Live traces have no real end yet: show elapsed-so-far and a LIVE marker
  // instead of an end time. Completed traces derive end/duration from the spans.
  const end = live ? null : latestSpanEnd(trace.spans);
  const duration = live
    ? elapsedMs(trace.trace_start_time, new Date().toISOString())
    : elapsedMs(trace.trace_start_time, end);

  const lines: string[] = [];
  lines.push(`${label("Trace:")}    ${trace.name}`);
  lines.push(`${label("ID:")}       ${trace.trace_id}`);
  lines.push(`${label("Started:")}  ${formatTimestamp(trace.trace_start_time)}`);
  if (live) {
    lines.push(`${label("Status:")}   ${styler.bold("LIVE")}`);
  } else if (end !== null) {
    lines.push(`${label("Ended:")}    ${formatTimestamp(end)}`);
  }
  if (duration !== null) {
    lines.push(`${label("Duration:")} ${formatDuration(duration)}${live ? " (so far)" : ""}`);
  }
  // Detector finding indicator (only when the trace was flagged). Kept compact:
  // finding id + which detectors fired, the RCA text (or its status while still
  // generating), and a yellow pointer to `findings get` for the full RCA /
  // per-detector data. Labels align on the value column, like `findings get`.
  if (finding !== null) {
    lines.push("");
    const detectors =
      finding.detectors.length > 0 ? `  (flagged by ${finding.detectors.join(", ")})` : "";
    lines.push(`${label("Finding ID:")} ${finding.finding_id}${detectors}`);
    if (finding.rca !== null) {
      // Show the RCA text directly; only fall back to the status (e.g. while it
      // is still being generated) when there is no result yet.
      const preview = rcaPreview(finding.rca.result ?? "");
      lines.push(`${label("RCA:")}        ${preview || finding.rca.status}`);
    }
    lines.push(
      styler.warn(
        `            run 'traceroot findings get ${finding.finding_id}' for the full finding`,
      ),
    );
  }
  lines.push("");
  lines.push(label("Spans:"));
  if (errorsOnlyEmpty) {
    lines.push("  (no error spans in this trace)");
  } else {
    lines.push(
      renderTree(working, { color: colorEnabled(writers.out), maxDepth: depth, maxSpans }),
    );
  }
  if (live) {
    // Indicate the tree is incomplete — more spans are still arriving.
    lines.push("  *** (live — more spans incoming)");
  }
  lines.push("");
  // Print the backend-provided URL verbatim; never construct a frontend URL.
  // Rendered as an OSC 8 hyperlink so it is clickable in supporting terminals;
  // falls back to the bare URL when color is disabled (piped/`NO_COLOR`).
  lines.push(`${label("View in TraceRoot:")} ${styler.link(trace.trace_url)}`);

  writers.out.write(`${lines.join("\n")}\n`);
}

/**
 * Coercion for a positive-integer option that also rejects a repeated flag.
 * Modeled on {@link onceOption} + `parseLimit`, but returns a validated `number`.
 */
function positiveIntOnce(flag: string): (val: string, prev: number | undefined) => number {
  return (val: string, prev: number | undefined): number => {
    if (prev !== undefined) {
      throw new CliError(`${flag} may only be given once`);
    }
    if (!/^\d+$/.test(val)) {
      throw new CliError(`${flag} must be a positive integer`);
    }
    const value = Number.parseInt(val, 10);
    if (!Number.isInteger(value) || value < 1) {
      throw new CliError(`${flag} must be a positive integer`);
    }
    return value;
  };
}

export function registerTracesGet(traces: Command): void {
  traces
    .command("get")
    .argument("<traceId>", "trace identifier")
    .description("Get a single trace")
    .option(
      "--max-spans <n>",
      "cap the number of spans shown (tree and JSON); adds a truncation marker",
      positiveIntOnce("--max-spans"),
    )
    .option(
      "--depth <n>",
      "cap tree depth (roots = 1); deeper spans are hidden in both tree and JSON",
      positiveIntOnce("--depth"),
    )
    .option("--errors-only", "show only error spans and their ancestor chains")
    .option(
      "--output <format>",
      "machine output format: 'jsonl' streams a header line then one span per line (implies JSON)",
      onceOption("--output"),
    )
    .action(async (traceId: string, _opts, command: Command) => {
      const opts = command.opts();
      // `--output` accepts only `jsonl`; reject anything else as a usage error
      // before any network work.
      const output = opts.output as string | undefined;
      if (output !== undefined && output !== "jsonl") {
        throw new CliError(`--output must be 'jsonl' (got '${output}')`);
      }
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      await runGet({
        client,
        json: ctx.json,
        writers: defaultWriters,
        traceId,
        maxSpans: opts.maxSpans as number | undefined,
        depth: opts.depth as number | undefined,
        errorsOnly: opts.errorsOnly as boolean | undefined,
        output: output === "jsonl" ? "jsonl" : undefined,
      });
    });
}
