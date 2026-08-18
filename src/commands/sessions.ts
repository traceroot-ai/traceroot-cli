import type { Command } from "commander";
import { registerSessionsGet } from "./sessions/get.js";
import { registerSessionsList } from "./sessions/list.js";

export function registerSessions(program: Command): void {
  // `helpCommand(false)` drops the implicit `sessions help [command]` subcommand;
  // `-h, --help` already covers it.
  const sessions = program.command("sessions").description("Work with sessions").helpCommand(false);
  registerSessionsList(sessions);
  registerSessionsGet(sessions);
}
