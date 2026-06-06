import { Command } from "commander";
import { registerCommands } from "./commands/index.js";
import { getVersion } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("traceroot").description("TraceRoot command line interface").version(getVersion());
  registerCommands(program);
  return program;
}

export async function run(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
