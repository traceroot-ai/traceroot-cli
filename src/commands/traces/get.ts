import type { Command } from "commander";
import type { ApiClient, TraceDetail } from "../../api/client.js";
import { type Writers, colorEnabled, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTree } from "../../render/tree.js";
import { formatDuration, formatTimestamp, parseBackendTime } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

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
  const { client, json, writers, traceId } = deps;
  const trace = await client.getTrace(traceId);

  if (json) {
    // FULL untruncated payload, byte-for-byte the backend response.
    writeJson(trace, writers);
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
  lines.push("");
  lines.push(label("Spans:"));
  lines.push(renderTree(trace.spans, { color: colorEnabled(writers.out) }));
  if (live) {
    // Indicate the tree is incomplete — more spans are still arriving.
    lines.push("  *** (live — more spans incoming)");
  }
  lines.push("");
  // Print the backend-provided URL verbatim; never construct a frontend URL.
  lines.push(`${label("View in TraceRoot:")} ${trace.trace_url}`);

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
