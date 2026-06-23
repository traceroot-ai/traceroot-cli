import type { Command } from "commander";
import { registerSkillsInstall } from "./skills/install.js";
import { registerSkillsList } from "./skills/list.js";

export function registerSkills(program: Command): void {
  // `helpCommand(false)` drops the implicit `skills help [command]` subcommand;
  // `-h, --help` already covers it (mirrors `traces`).
  const skills = program
    .command("skills")
    .description("List and install TraceRoot skills")
    .helpCommand(false);
  registerSkillsList(skills);
  registerSkillsInstall(skills);
}
