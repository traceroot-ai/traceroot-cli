import type { Command } from "commander";
import type { FindingDetail } from "../../api/client.js";
import { CliError, ExitCode, type Writers, writeJson } from "../../output.js";
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
  const label = (text: string): string => styler.bold(text);
  const lines: string[] = [];

  // Aligned header fields (values line up under column 13).
  // Id ordering mirrors the UI's detector-runs table: run id -> trace id ->
  // finding id. "none" when no run row references the finding.
  lines.push(
    `${label("Run IDs:")}    ${(finding.run_ids ?? []).length > 0 ? finding.run_ids.join(", ") : "none"}`,
  );
  lines.push(`${label("Trace ID:")}   ${finding.trace_id}`);
  lines.push(`${label("Finding ID:")} ${sanitizeFindingId(finding.finding_id)}`);
  lines.push(`${label("Time:")}       ${formatTimestamp(finding.timestamp, timeZone)}`);
  lines.push(`${label("Summary:")}    ${finding.summary}`);

  // Per-detector, flush-left: `Detector: <name> (<template>)`, then the unique id
  // (disambiguates same-named detectors) and the human-readable category.
  // Multiple detectors are separated by a blank line; per-detector summary/data
  // stay in `--json` only.
  lines.push("");
  finding.results.forEach((result, i) => {
    if (i > 0) {
      lines.push("");
    }
    const template = result.template ? ` (${result.template})` : "";
    lines.push(`${label("Detector:")} ${result.detector_name}${template}`);
    lines.push(`${label("ID:")}       ${result.detector_id}`);
    lines.push(`${label("Category:")} ${categoryLabel(result.template)}`);
  });

  // RCA, flush-left. With a result: a bare `RCA:` header, then the result verbatim
  // (it already carries its own formatting — usually a markdown list — so no added
  // bullets, or the markers double up). No RCA → `RCA: none`; an in-progress RCA
  // with no result yet keeps its status (e.g. `RCA: processing`).
  lines.push("");
  if (!finding.rca) {
    lines.push(`${label("RCA:")} none`);
  } else if (finding.rca.result) {
    lines.push(label("RCA:"));
    for (const resultLine of finding.rca.result.trim().split("\n")) {
      lines.push(resultLine);
    }
  } else {
    lines.push(`${label("RCA:")} ${finding.rca.status}`);
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
