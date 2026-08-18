import type { Command } from "commander";
import { ensureGroup } from "../registry/factory.js";
import { registerTracesExport } from "./traces/export.js";
import { registerTracesGet } from "./traces/get.js";
import { registerTracesList } from "./traces/list.js";

export function registerTraces(program: Command): void {
  const traces = ensureGroup(program, "traces");
  registerTracesList(traces);
  registerTracesGet(traces);
  registerTracesExport(traces);
}
