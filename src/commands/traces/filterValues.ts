import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import {
  CliError,
  ExitCode,
  type Writers,
  defaultWriters,
  logProgress,
  writeJson,
} from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { contextFromCommand, requireApiClient } from "../shared.js";
import { onceOption } from "./list.js";

/** Dependencies for the testable core of `traces filter-values`. */
export interface RunFilterValuesDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  field: string;
  /** ISO 8601 lower bound (inclusive), sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive), sent as `end_before`. */
  endBefore?: string;
  /** Target project (required by the server under user credentials). */
  projectId?: string;
}

/** Core, network-free logic for `traces filter-values`. Tests inject a fake client. */
export async function runFilterValues(deps: RunFilterValuesDeps): Promise<void> {
  const { client, json, writers, field } = deps;
  if (field.trim() === "") {
    throw new CliError("provide a field name", ExitCode.usage);
  }
  const res = await client.traceFilterValues(field, {
    startAfter: deps.startAfter,
    endBefore: deps.endBefore,
    projectId: deps.projectId,
  });

  if (json) {
    writeJson({ ...res, count: res.values.length }, writers);
    return;
  }

  const headers = ["VALUE", "COUNT"];
  const rows = res.values.map((item) => [String(item.value), String(item.count)]);
  const styler = createStyler(writers.out);
  writers.out.write(`${renderTable(headers, rows, { headerStyle: styler.bold })}\n`);
  logProgress(`${res.values.length} value(s) for ${res.field}`, writers);
}

export function registerTracesFilterValues(traces: Command): void {
  traces
    .command("filter-values")
    .argument("<field>", "the trace field to enumerate distinct values for")
    .description("List the distinct values of a trace field (for --filters)")
    .option(
      "--from <timestamp>",
      "only consider spans starting at or after this time (ISO 8601)",
      onceOption("--from"),
    )
    .option(
      "--to <timestamp>",
      "only consider spans starting before this time (exclusive, ISO 8601)",
      onceOption("--to"),
    )
    .action(async (field: string, _opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const opts = command.opts();
      await runFilterValues({
        client: requireApiClient(ctx),
        json: ctx.json,
        writers: defaultWriters,
        field,
        startAfter: opts.from as string | undefined,
        endBefore: opts.to as string | undefined,
        projectId: ctx.auth.projectId.value,
      });
    });
}
