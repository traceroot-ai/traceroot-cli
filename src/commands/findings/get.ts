import type { Command } from "commander";
import type { ApiClient, FindingDetail } from "../../api/client.js";
import { CliError, type Writers, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { wrapMarkdown } from "../../render/wrap.js";
import { formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";
import { onceOption } from "../traces/list.js";

/** Fallback RCA wrap width when the terminal doesn't report a column count. */
const DEFAULT_WRAP_WIDTH = 80;

/** Dependencies for the testable core of `findings get`. */
export interface RunGetDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  /** Look up by finding id. Exactly one of findingId / traceId must be set. */
  findingId?: string;
  /** Look up the (1-per-trace) finding for a trace instead. */
  traceId?: string;
  /** IANA timezone override for the human-local time display. */
  timeZone?: string;
}

/** Core, network-free logic for `findings get`. Tests inject a fake client. */
export async function runGet(deps: RunGetDeps): Promise<void> {
  const { client, json, writers, findingId, traceId, timeZone } = deps;

  // Treat a blank value as "not provided" so `get ""` / `--trace ""` give a clear
  // error instead of hitting a malformed URL (e.g. `/traces//finding`).
  const hasFinding = findingId !== undefined && findingId.trim() !== "";
  const hasTrace = traceId !== undefined && traceId.trim() !== "";

  if (hasFinding && hasTrace) {
    throw new CliError("provide either a finding id or --trace, not both");
  }
  if (!hasFinding && !hasTrace) {
    throw new CliError("provide a finding id, or --trace <trace-id>");
  }

  const finding = hasFinding
    ? await client.getFinding(findingId as string)
    : await client.getFindingByTrace(traceId as string);

  if (json) {
    // Bare object, byte-for-byte the backend response (mirrors `traces get`).
    writeJson(finding, writers);
    return;
  }

  // Best-effort: fetch the trace purely to get its backend-provided `trace_url`
  // for the footer link. Never let this fail the command — any error (network,
  // 404, etc.) degrades to no link, with the next-step hints still shown.
  let traceUrl: string | null = null;
  try {
    const trace = await client.getTrace(finding.trace_id);
    traceUrl = trace.trace_url;
  } catch {
    traceUrl = null;
  }

  writers.out.write(`${renderFinding(finding, writers, traceUrl, timeZone)}\n`);
}

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

function categoryLabel(template: string | null | undefined): string {
  if (!template) {
    return "Unknown";
  }
  return CATEGORY_LABELS[template] ?? template.charAt(0).toUpperCase() + template.slice(1);
}

/**
 * The detector's own classification, from `result.data.category` (a loose,
 * detector-defined payload — only a non-empty string `category` key is
 * trusted). `null` when `data` doesn't carry one, so the caller falls back to
 * the template-derived label.
 */
function dataCategory(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const value = (data as Record<string, unknown>).category;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The Category line's value: the detector's own conclusion (`data.category`)
 * when present, annotated with the raw template id for precision, e.g.
 * `Tool call error (template: failure)`. Falls back to the template-derived
 * label alone when `data` has no usable category.
 */
function detectorCategory(result: FindingDetail["results"][number]): string {
  const category = dataCategory(result.data);
  if (category === null) {
    return categoryLabel(result.template);
  }
  return result.template ? `${category} (template: ${result.template})` : category;
}

function renderFinding(
  finding: FindingDetail,
  writers: Writers,
  traceUrl: string | null,
  timeZone?: string,
): string {
  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const lines: string[] = [];

  // Aligned header fields (values line up under column 13).
  lines.push(`${label("Finding ID:")} ${finding.finding_id}`);
  lines.push(`${label("Trace ID:")}   ${finding.trace_id}`);
  lines.push(`${label("Time:")}       ${formatTimestamp(finding.timestamp, timeZone)}`);
  lines.push(`${label("Summary:")}    ${finding.summary}`);

  // Per-detector, flush-left: `Detector: <name> (<template>)`, then the unique id
  // (disambiguates same-named detectors), whether the detector actually fired
  // (`Identified:`), and the Category line — the detector's own conclusion
  // (`result.data.category`) when present, else the template-derived label.
  // Multiple detectors are separated by a blank line; the raw `summary` /
  // `data` payload stays in `--json` only.
  lines.push("");
  finding.results.forEach((result, i) => {
    if (i > 0) {
      lines.push("");
    }
    const template = result.template ? ` (${result.template})` : "";
    lines.push(`${label("Detector:")}   ${result.detector_name}${template}`);
    lines.push(`${label("ID:")}         ${result.detector_id}`);
    lines.push(`${label("Identified:")} ${result.identified ? "yes" : "no"}`);
    lines.push(`${label("Category:")}   ${detectorCategory(result)}`);
  });

  // RCA, flush-left. With a result: a bare `RCA:` header, then the result
  // wrapped to the terminal width with minimal markdown treatment (headings /
  // `**bold**` / `` `code` `` styled-or-stripped rather than printed literally;
  // see `render/wrap.ts`). No RCA → `RCA: none`; an in-progress RCA with no
  // result yet keeps its status (e.g. `RCA: processing`).
  lines.push("");
  if (!finding.rca) {
    lines.push(`${label("RCA:")} none`);
  } else if (finding.rca.result) {
    lines.push(label("RCA:"));
    const width = process.stdout.columns ?? DEFAULT_WRAP_WIDTH;
    lines.push(wrapMarkdown(finding.rca.result.trim(), width, styler.bold));
  } else {
    lines.push(`${label("RCA:")} ${finding.rca.status}`);
  }

  // Footer: never dead-end. A backend-provided trace link when available (best
  // effort — never hand-construct a frontend URL), and always the next-step
  // hints, matching the `styler.warn` idiom `traces get` uses.
  lines.push("");
  if (traceUrl !== null) {
    lines.push(`${label("View in TraceRoot:")} ${styler.link(traceUrl)}`);
  }
  lines.push(styler.warn(`run 'traceroot traces get ${finding.trace_id}' for spans and context`));
  lines.push(
    styler.warn(`run 'traceroot traces export ${finding.trace_id}' to save a full bundle`),
  );

  return lines.join("\n");
}

export function registerFindingsGet(findings: Command): void {
  findings
    .command("get")
    .argument("[findingId]", "finding identifier")
    .option(
      "--trace <traceId>",
      "look up the finding for a trace instead of by finding id",
      onceOption("--trace"),
    )
    .description("Get a single detector finding")
    .action(async (findingId: string | undefined, _opts, command: Command) => {
      if (command.args.length > 1) {
        throw new CliError(
          `unexpected argument(s): ${command.args.slice(1).join(" ")}. 'findings get' takes a single finding id (or use --trace).`,
        );
      }
      const opts = command.opts();
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      await runGet({
        client,
        json: ctx.json,
        writers: defaultWriters,
        findingId,
        traceId: opts.trace as string | undefined,
      });
    });
}
