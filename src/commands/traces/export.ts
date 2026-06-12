import type { Command } from "commander";
import { notImplemented } from "../../output.js";

export function registerTracesExport(traces: Command): void {
  traces
    .command("export")
    .argument("<traceId>", "trace identifier")
    .description("Export a trace")
    .action(() => notImplemented("traces export"));
}
