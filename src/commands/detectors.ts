import type { Command } from "commander";
import { registerDetectorsList } from "./detectors/list.js";

export function registerDetectors(program: Command): void {
  // `helpCommand(false)` drops the implicit `detectors help [command]` subcommand;
  // `-h, --help` already covers it.
  const detectors = program
    .command("detectors")
    .description("Work with detectors")
    .helpCommand(false);
  registerDetectorsList(detectors);
}
