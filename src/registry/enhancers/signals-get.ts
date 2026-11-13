import type { Command } from "commander";
import type { SignalDetail } from "../../api/client.js";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { type Wire, clean, orDash, orNone, plural, renderFields, when } from "./eval-reads.js";
import { sanitizeFindingId } from "./finding-id.js";
import type { Enhancer, RenderContext } from "./types.js";

type Signal = Wire<SignalDetail>;

/** `open`, `open, reopened 2 times`, `resolved 2026-11-09 10:00:00 UTC`. */
function statusText(signal: Signal, timeZone?: string): string {
  const resolved =
    signal.status === "resolved" && typeof signal.resolved_at === "string"
      ? ` ${when(signal.resolved_at, timeZone)}`
      : "";
  const reopens = signal.reopen_count ?? 0;
  const reopened = reopens > 0 ? `, reopened ${reopens} ${plural(reopens, "time")}` : "";
  return `${orDash(signal.status)}${resolved}${reopened}`;
}

/** A finding id as `findings get` takes it, or a dash when the server sent none. */
function findingId(value: string | null | undefined): string {
  return typeof value === "string" ? clean(sanitizeFindingId(value)) : "—";
}

/**
 * Rendering core, network-free. The record goes to stdout; what to run next,
 * and why no trace is listed, go to stderr.
 */
export function renderSignal(signal: Signal, writers: Writers, timeZone?: string): void {
  // A deleted detector leaves no name, and its id still finds its findings.
  const detector =
    typeof signal.detector_name === "string" && signal.detector_name !== ""
      ? `${clean(signal.detector_name)} (${orDash(signal.detector_id)})`
      : orDash(signal.detector_id);
  const fields: [string, string][] = [
    ["title", orDash(signal.title)],
    ["signal id", orDash(signal.signal_id)],
    ["status", statusText(signal, timeZone)],
  ];
  if (typeof signal.merged_into_id === "string") {
    fields.push(["merged into", clean(signal.merged_into_id)]);
  }
  fields.push(
    ["detector", detector],
    ["hits", orDash(signal.hit_count)],
    ["first seen", when(signal.first_seen_at, timeZone)],
    ["last seen", when(signal.last_seen_at, timeZone)],
    // The analysis of the current opening: none when no analysis ran for it.
    ["analysis", orNone(signal.rca_state)],
  );
  renderFields(fields, writers);

  if (typeof signal.merged_into_id === "string") {
    logProgress(
      `this signal was merged: read the one its findings moved to with 'traceroot signals get ${clean(signal.merged_into_id)}'`,
      writers,
    );
  }

  // A server without the field has said nothing about which traces it kept.
  const hits = signal.recent_hits;
  if (hits === undefined || hits === null) return;
  if (hits.length === 0) {
    logProgress(
      "no recent traces are shown: traces older than your plan's retention are left out",
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  const table = renderTable(
    ["TRACE ID", "FINDING ID", "TRACE START"],
    hits.map((hit) => [
      orDash(hit.trace_id),
      findingId(hit.finding_id),
      when(hit.trace_start_time, timeZone),
    ]),
    { headerStyle: styler.bold },
  );
  writers.out.write(`\n${styler.bold("recent traces, latest trace start first")}\n${table}\n`);

  const newest = hits[0];
  if (typeof newest?.trace_id === "string" && typeof newest.finding_id === "string") {
    logProgress(
      `open the newest trace with 'traceroot traces get ${clean(newest.trace_id)}', ` +
        `and its finding with 'traceroot findings get ${findingId(newest.finding_id)}'`,
      writers,
    );
  }
}

export const signalsGet: Enhancer = {
  description:
    "Read one signal: its status, detector, hit count, when it was first and last seen, the " +
    "state of its analysis, and the traces it hit most recently, each with the finding it " +
    "produced. Ends by naming the commands that open the newest trace and its finding.",
  // No flags of its own. Without this the factory derives `--project-id` from the
  // tool's schema, and the project comes from the global --project on every other
  // read.
  flags(_cmd: Command): void {},
  render(payload: unknown, ctx: RenderContext): void {
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      return;
    }
    renderSignal(payload as Signal, ctx.writers);
  },
};
