import type { Command } from "commander";
import type { ApiClient, FindingDetail, TraceDetail } from "../../api/client.js";
import { type Writers, colorEnabled, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTree } from "../../render/tree.js";
import { elapsedMs, formatDuration, formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

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

/** Core, network-free logic for `traces get`. Tests inject a fake client. */
export async function runGet(deps: RunGetDeps): Promise<void> {
  const { client, json, writers, traceId } = deps;
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

  if (json) {
    // FULL untruncated trace, plus the finding (or null) so scripts get it in one call.
    writeJson({ ...trace, finding }, writers);
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const live = isLive(trace.spans);
  // Single "now" instant, reused for both the header's live elapsed duration
  // and the per-span tree (via renderTree's `now` option), so a still-running
  // span's elapsed-so-far agrees with the header rather than drifting apart
  // from a second, later `Date.now()` read.
  const nowIso = new Date().toISOString();

  // Live traces have no real end yet: show elapsed-so-far and a LIVE marker
  // instead of an end time. Completed traces derive end/duration from the spans.
  const end = live ? null : latestSpanEnd(trace.spans);
  const duration = live
    ? elapsedMs(trace.trace_start_time, nowIso)
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
  lines.push(
    renderTree(trace.spans, {
      color: colorEnabled(writers.out),
      width: process.stdout.columns ?? 80,
      now: nowIso,
    }),
  );
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

export function registerTracesGet(traces: Command): void {
  traces
    .command("get")
    .argument("<traceId>", "trace identifier")
    .description("Get a single trace")
    .action(async (traceId: string, _opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      await runGet({ client, json: ctx.json, writers: defaultWriters, traceId });
    });
}
