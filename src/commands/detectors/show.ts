import type { Command } from "commander";
import type { ApiClient, FindingDetail } from "../../api/client.js";
import { type Writers, CliError, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

/** Dependencies for the testable core of `detectors show`. */
export interface RunShowDeps {
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

/** Core, network-free logic for `detectors show`. Tests inject a fake client. */
export async function runShow(deps: RunShowDeps): Promise<void> {
  const { client, json, writers, findingId, traceId, timeZone } = deps;

  if (findingId !== undefined && traceId !== undefined) {
    throw new CliError("provide either a finding id or --trace, not both");
  }
  if (findingId === undefined && traceId === undefined) {
    throw new CliError("provide a finding id, or --trace <trace-id>");
  }

  const finding =
    findingId !== undefined
      ? await client.getFinding(findingId)
      : await client.getFindingByTrace(traceId as string);

  if (json) {
    // Bare object, byte-for-byte the backend response (mirrors `traces get`).
    writeJson(finding, writers);
    return;
  }

  writers.out.write(`${renderFinding(finding, writers, timeZone)}\n`);
}

function renderFinding(finding: FindingDetail, writers: Writers, timeZone?: string): string {
  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const lines: string[] = [];

  lines.push(label("Finding"));
  lines.push(`  ID: ${finding.finding_id}`);
  lines.push(`  Trace: ${finding.trace_id}`);
  lines.push(`  Time: ${formatTimestamp(finding.timestamp, timeZone)}`);
  lines.push(`  Summary: ${finding.summary}`);

  lines.push(label("Detector Results"));
  for (const result of finding.results) {
    lines.push(`  ${label(result.detector_name)}`);
    lines.push(`    Identified: ${result.identified}`);
    lines.push(`    Summary: ${result.summary}`);
    lines.push("    Data:");
    for (const dataLine of JSON.stringify(result.data ?? null, null, 2).split("\n")) {
      lines.push(`      ${dataLine}`);
    }
  }

  lines.push(label("RCA"));
  if (finding.rca === null || finding.rca === undefined) {
    lines.push("  Status: none");
  } else {
    lines.push(`  Status: ${finding.rca.status}`);
    if (finding.rca.result !== null && finding.rca.result !== undefined) {
      lines.push("  Result:");
      for (const resultLine of finding.rca.result.split("\n")) {
        lines.push(`    ${resultLine}`);
      }
    }
  }

  return lines.join("\n");
}

export function registerShow(detectors: Command): void {
  detectors
    .command("show")
    .argument("[findingId]", "finding identifier")
    .option("--trace <traceId>", "look up the finding for a trace instead of by finding id")
    .description("Show a single detector finding")
    .action(async (findingId: string | undefined, _opts, command: Command) => {
      const opts = command.opts();
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      await runShow({
        client,
        json: ctx.json,
        writers: defaultWriters,
        findingId,
        traceId: opts.trace as string | undefined,
      });
    });
}
