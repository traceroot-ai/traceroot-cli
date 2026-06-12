import type { Command } from "commander";
import { notImplemented } from "../../output.js";

export function registerTracesGet(traces: Command): void {
  traces
    .command("get")
    .argument("<traceId>", "trace identifier")
    .description("Get a single trace")
    .action(() => notImplemented("traces get"));
}
