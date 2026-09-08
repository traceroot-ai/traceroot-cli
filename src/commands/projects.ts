import type { Command } from "commander";
import { registerProjectsList } from "./projects/list.js";

export function registerProjects(program: Command): void {
  // `helpCommand(false)` drops the implicit `projects help [command]` subcommand;
  // `-h, --help` already covers it.
  const projects = program
    .command("projects")
    .description("Discover your projects (user credentials)")
    .helpCommand(false);
  registerProjectsList(projects);
}
