import type { Command } from "commander";
import { registerLogin } from "./login.js";
import { registerStatus } from "./status.js";
import { registerTraces } from "./traces.js";

/**
 * The single extension point for command registration. Later issues add their
 * command groups here without reshaping cli.ts.
 */
export function registerCommands(program: Command): void {
  registerLogin(program);
  registerStatus(program);
  registerTraces(program);
}
