import type { Command } from "commander";
import { registerWorkspacesList } from "./workspaces/list.js";

export function registerWorkspaces(program: Command): void {
  // `helpCommand(false)` drops the implicit `workspaces help [command]` subcommand;
  // `-h, --help` already covers it.
  const workspaces = program
    .command("workspaces")
    .description("Discover your workspaces (user credentials)")
    .helpCommand(false);
  registerWorkspacesList(workspaces);
}
