import type { Command } from "commander";
import { registerFindings } from "./detectors/findings.js";

export function registerDetectors(program: Command): void {
  // `helpCommand(false)` drops the implicit `detectors help [command]` subcommand;
  // `-h, --help` already covers it.
  const detectors = program
    .command("detectors")
    .description("Work with detector findings")
    .helpCommand(false);
  registerFindings(detectors);
}
