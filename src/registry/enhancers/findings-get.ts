import type { Command } from "commander";
import type { FindingDetail } from "../../api/client.js";
import { CliError, ExitCode, type Writers, writeJson } from "../../output.js";
import { fieldLines } from "../../render/fields.js";
import { createStyler } from "../../render/style.js";
import { formatTimestamp } from "../../util/index.js";
import { onceOption } from "../flags.js";
import { sanitizeFindingId } from "./finding-id.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

/**
 * Human-readable category label per detector template, mirroring the frontend's
 * `frontend/ui/src/features/detectors/templates.ts`. Unknown templates fall back
 * to a title-cased form; a null template (e.g. a deleted detector) → "Unknown".
 */
const CATEGORY_LABELS: Record<string, string> = {
  failure: "Failure",
  hallucination: "Hallucination",
  logic: "Logic Error",
  task: "Task Completion",
  safety: "Safety",
  blank: "Blank",
};

/** Exported so tests can pin the multi-word labels the fallback cannot produce. */
export function categoryLabel(template: string | null | undefined): string {
  if (!template) {
    return "Unknown";
  }
  // Object.hasOwn, not bare indexing: a template literally named "toString"
  // must hit the title-case fallback, not an inherited Object.prototype method.
  return Object.hasOwn(CATEGORY_LABELS, template)
    ? (CATEGORY_LABELS[template] as string)
    : template.charAt(0).toUpperCase() + template.slice(1);
}

/** Core, network-free rendering logic for `findings get`. Exported for tests. */
export function renderFinding(finding: FindingDetail, writers: Writers, timeZone?: string): string {
  const styler = createStyler(writers.out);
  const lines: string[] = [];

  // Header fields. Id ordering mirrors the UI's detector-runs table: run id ->
  // trace id -> finding id. "(none)" when no run row references the finding.
  // An empty string is an absent value, so it prints as "—", as in every get.
  const runIds = finding.run_ids ?? [];
  lines.push(
    ...fieldLines(
      [
        ["Run IDs", runIds.length > 0 ? runIds.join(", ") : "(none)"],
        ["Trace ID", finding.trace_id],
        ["Finding ID", sanitizeFindingId(finding.finding_id)],
        ["Time", formatTimestamp(finding.timestamp, timeZone)],
        ["Summary", finding.summary || "—"],
      ],
      styler,
    ),
  );

  // Per detector: its name and template, its unique id (disambiguates
  // same-named detectors) and the human-readable category. Multiple detectors
  // are separated by a blank line; per-detector summary/data stay in `--json`.
  for (const result of finding.results) {
    const template = result.template ? ` (${result.template})` : "";
    lines.push(
      "",
      ...fieldLines(
        [
          ["Detector", `${result.detector_name || "—"}${template}`],
          ["Detector ID", result.detector_id || "—"],
          ["Category", categoryLabel(result.template)],
        ],
        styler,
      ),
    );
  }

  // RCA. With a result: a bare `RCA:` header, then the result verbatim (it
  // already carries its own formatting — usually a markdown list — so no added
  // bullets, or the markers double up). No RCA → `RCA:  (none)`; an in-progress
  // RCA with no result yet keeps its status (e.g. `RCA:  processing`).
  lines.push("");
  if (!finding.rca) {
    lines.push(...fieldLines([["RCA", "(none)"]], styler));
  } else if (finding.rca.result) {
    lines.push(styler.bold("RCA:"));
    for (const resultLine of finding.rca.result.trim().split("\n")) {
      lines.push(resultLine);
    }
  } else {
    lines.push(...fieldLines([["RCA", finding.rca.status]], styler));
  }

  return lines.join("\n");
}

export const findingsGet: Enhancer = {
  description:
    "Get a single detector finding. Run IDs lists every detector run that produced it " +
    "(one per triggered detector on the trace).",
  arguments(cmd: Command): void {
    cmd.argument("[findingId]", "finding identifier");
  },
  flags(cmd: Command): void {
    cmd.option(
      "--trace <traceId>",
      "look up the finding for a trace instead of by finding id",
      onceOption("--trace"),
    );
  },
  resolveArgs(input: ResolveInput): Resolved {
    if (input.extras.length > 0) {
      throw new CliError(
        `unexpected argument(s): ${input.extras.join(" ")}. 'findings get' takes a single finding id (or use --trace).`,
        ExitCode.usage,
      );
    }
    const findingId = input.positionals.finding_id;
    const traceId = input.opts.trace as string | undefined;
    // Treat a blank value as "not provided" so `get ""` / `--trace ""` give a
    // clear error instead of hitting a malformed URL (e.g. `/traces//finding`).
    const hasFinding = findingId !== undefined && findingId.trim() !== "";
    const hasTrace = traceId !== undefined && traceId.trim() !== "";

    if (hasFinding && hasTrace) {
      throw new CliError("provide either a finding id or --trace, not both", ExitCode.usage);
    }
    if (!hasFinding && !hasTrace) {
      throw new CliError("provide a finding id, or --trace <trace-id>", ExitCode.usage);
    }
    return hasFinding
      ? { args: { finding_id: sanitizeFindingId(findingId as string) } }
      : { tool: "get_finding_by_trace", args: { trace_id: traceId as string } };
  },
  render(payload: unknown, ctx: RenderContext): void {
    const finding = payload as FindingDetail;
    if (ctx.json) {
      // Bare object, byte-for-byte the backend response (mirrors `traces get`).
      writeJson(finding, ctx.writers);
      return;
    }
    ctx.writers.out.write(`${renderFinding(finding, ctx.writers)}\n`);
  },
};
