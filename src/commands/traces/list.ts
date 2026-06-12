import type { Command } from "commander";
import { notImplemented } from "../../output.js";

export function registerTracesList(traces: Command): void {
  traces
    .command("list")
    .description("List traces")
    .action(() => notImplemented("traces list"));
}
