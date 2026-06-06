import type { Command } from "commander";
import { notImplemented } from "../output.js";

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Authenticate with TraceRoot")
    .action(() => notImplemented("login"));
}
