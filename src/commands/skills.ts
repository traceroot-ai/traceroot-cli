import type { Command } from "commander";
import { JSON_OPTION_DESC } from "./shared.js";
import { registerSkillsInstall } from "./skills/install.js";
import { registerSkillsList } from "./skills/list.js";

export function registerSkills(program: Command): void {
  // `helpCommand(false)` drops the implicit `skills help [command]` subcommand;
  // `-h, --help` already covers it (mirrors `traces`).
  const skills = program
    .command("skills")
    .description("List and install TraceRoot skills")
    .option("--json", JSON_OPTION_DESC)
    .helpCommand(false);
  registerSkillsList(skills);
  registerSkillsInstall(skills);
}
