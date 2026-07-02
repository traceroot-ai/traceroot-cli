import type { Command } from "commander";
import { registerFindingsList } from "./findings/list.js";

export function registerFindings(program: Command): void {
  // `helpCommand(false)` drops the implicit `findings help [command]` subcommand;
  // `-h, --help` already covers it.
  const findings = program
    .command("findings")
    .description("Work with detector findings")
    .helpCommand(false);
  registerFindingsList(findings);
}
