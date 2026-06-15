import type { Command } from "commander";
import { registerTracesExport } from "./traces/export.js";
import { registerTracesGet } from "./traces/get.js";
import { registerTracesList } from "./traces/list.js";

export function registerTraces(program: Command): void {
  // `helpCommand(false)` drops the implicit `traces help [command]` subcommand;
  // `-h, --help` already covers it.
  const traces = program.command("traces").description("Work with traces").helpCommand(false);
  registerTracesList(traces);
  registerTracesGet(traces);
  registerTracesExport(traces);
}
