import { Command } from "commander";
import { registerCommands } from "./commands/index.js";
import { colorizeError, handlePipeError, reportError } from "./output.js";
import { getVersion } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("traceroot").description("TraceRoot command line interface").version(getVersion());
  // Drop the implicit `help [command]` subcommand; `-h, --help` already covers it.
  program.helpCommand(false);
  // Color commander's own errors (unknown command/option) the same red as the
  // central error handler, so every error message is consistent.
  program.configureOutput({
    outputError: (str, write) => write(colorizeError(str)),
  });
  // Global options (long-flag only to avoid clashing with -V/-h). Registered
  // before subcommands so they apply program-wide.
  program
    .option("--api-key <key>", "API key for authentication")
    .option("--host <url>", "API host URL")
    .option("--env-file <path>", "path to a .env file to load")
    .option("--json", "emit machine-readable JSON output");
  registerCommands(program);
  // Root action: lets global flags parse without a subcommand, while still
  // rejecting an unrecognized operand so unknown-command handling is preserved.
  program.action((_opts, command: Command) => {
    const operands = command.args;
    if (operands.length > 0) {
      command.error(`error: unknown command '${operands[0]}'`, { exitCode: 1 });
      return;
    }
    // No subcommand given: show help and exit non-zero. Help goes to stderr
    // (per the output contract: human text never pollutes stdout). An explicit
    // `--help` is intercepted earlier by commander and still prints to stdout.
    command.help({ error: true });
  });
  return program;
}

export async function run(argv: string[]): Promise<void> {
  // Exit cleanly when a downstream reader (e.g. `head`, `jq`) closes the pipe:
  // turn the resulting EPIPE into a quiet exit instead of a Node stack trace.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => handlePipeError(err));
  process.stderr.on("error", (err: NodeJS.ErrnoException) => handlePipeError(err));
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    const code = reportError(err);
    process.exitCode = code;
    if (code !== 0) {
      process.exit(code);
    }
  }
}
