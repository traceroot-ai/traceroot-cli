import type { Command } from "commander";
import { notImplemented } from "../output.js";

export function registerTraces(program: Command): void {
  const traces = program.command("traces").description("Work with traces");

  traces
    .command("list")
    .description("List traces")
    .action(() => notImplemented("traces list"));

  traces
    .command("get")
    .argument("<traceId>", "trace identifier")
    .description("Get a single trace")
    .action(() => notImplemented("traces get"));

  traces
    .command("export")
    .argument("<traceId>", "trace identifier")
    .description("Export a trace")
    .action(() => notImplemented("traces export"));
}
