import type { Command } from "commander";
import { notImplemented } from "../output.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show authentication status")
    .action(() => notImplemented("status"));
}
