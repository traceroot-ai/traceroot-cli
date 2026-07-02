import type { Command } from "commander";
import type { ApiClient, FindingDetail } from "../../api/client.js";
import { type Writers, CliError, defaultWriters, writeJson } from "../../output.js";
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

  writers.out.write(`${renderFinding(finding, writers, timeZone)}\n`);
}

function renderFinding(finding: FindingDetail, writers: Writers, timeZone?: string): string {
  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const lines: string[] = [];

  // Flat, aligned header fields, mirroring `traces get`.
  lines.push(`${label("Finding:")} ${finding.finding_id}`);
  lines.push(`${label("Trace:")}   ${finding.trace_id}`);
  lines.push(`${label("Time:")}    ${formatTimestamp(finding.timestamp, timeZone)}`);
  lines.push(`${label("Summary:")} ${finding.summary}`);

  lines.push("");
  lines.push(label("Detectors:"));
  for (const result of finding.results) {
    const heading =
      result.template && result.template !== result.detector_name
        ? `${result.detector_name} (${result.template})`
        : result.detector_name;
    lines.push(`  ${heading}`);
    if (result.summary) {
      lines.push(`    ${result.summary}`);
    }
    if (result.data !== null && result.data !== undefined) {
      for (const dataLine of JSON.stringify(result.data, null, 2).split("\n")) {
        lines.push(`    ${dataLine}`);
      }
    }
  }

  lines.push("");
  lines.push(label("RCA:"));
  if (finding.rca === null || finding.rca === undefined) {
    lines.push(`  ${label("Status:")} none`);
  } else {
    lines.push(`  ${label("Status:")} ${finding.rca.status}`);
    if (finding.rca.result !== null && finding.rca.result !== undefined) {
      for (const resultLine of finding.rca.result.split("\n")) {
        lines.push(`  ${resultLine}`);
      }
    }
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
