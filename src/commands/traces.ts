import type { Command } from "commander";
import { ensureGroup } from "../registry/factory.js";
import { registerTracesList } from "./traces/list.js";

export function registerTraces(program: Command): void {
  const traces = ensureGroup(program, "traces");
  registerTracesList(traces);
}
