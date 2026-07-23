import type { Command } from "commander";
import type { ApiClient, FindingDetail } from "../../api/client.js";
import { CliError, ExitCode, type Writers, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";
import { onceOption } from "../traces/list.js";

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
    throw new CliError("provide either a finding id or --trace, not both", ExitCode.usage);
  }
  if (!hasFinding && !hasTrace) {
    throw new CliError("provide a finding id, or --trace <trace-id>", ExitCode.usage);
  }

  const finding = hasFinding
    ? await client.getFinding(findingId as string)
    : await client.getFindingByTrace(traceId as string);

  if (json) {
    // Bare object, byte-for-byte the backend response (mirrors `traces get`).
    writeJson(finding, writers);
    return;
  }

  writers.out.write(`${renderFinding(finding, writers, timeZone)}\n`);
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

function renderFinding(finding: FindingDetail, writers: Writers, timeZone?: string): string {
  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const lines: string[] = [];

  // Aligned header fields (values line up under column 13).
  lines.push(`${label("Finding ID:")} ${finding.finding_id}`);
  lines.push(`${label("Trace ID:")}   ${finding.trace_id}`);
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
          ExitCode.usage,
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
