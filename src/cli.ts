import { Command, Option } from "commander";
import { registerCommands } from "./commands/index.js";
import { CliError, colorizeError, reportError } from "./output.js";
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
  // Surface program-wide global flags (e.g. `--json`) in every subcommand's
  // `--help` under a "Global Options" section, so they're discoverable where
  // users look (e.g. `traceroot traces list --help`). `-h, --help` is available
  // on every command, so it belongs there too — not repeated in each command's
  // own "Options". The root command keeps `--help` in its "Options" (it has no
  // "Global Options" section).
  const notHidden = (o: Option): boolean => !(o as Option & { hidden?: boolean }).hidden;
  const helpOption = (): Option => new Option("-h, --help", "display help for command");
  program.configureHelp({
    showGlobalOptions: true,
    visibleOptions(cmd) {
      const own = cmd.options.filter(notHidden);
      if (cmd.parent === null) {
        own.push(helpOption()); // root: keep `--help` in its own Options
      }
      return own;
    },
    visibleGlobalOptions(cmd) {
      if (cmd.parent === null) {
        return []; // root has no "Global Options" section
      }
      const globals: Option[] = [];
      for (let ancestor: Command | null = cmd.parent; ancestor; ancestor = ancestor.parent) {
        globals.push(...ancestor.options.filter(notHidden));
      }
      globals.push(helpOption()); // subcommands: `--help` is a global flag
      return globals;
    },
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
    // --json with no subcommand is a usage error: we have no structured output
    // to produce, and silently showing help would be surprising.
    if ((_opts as { json?: boolean }).json) {
      throw new CliError(
        "--json requires a command that supports JSON output, e.g. traceroot status --json or traceroot traces list --json",
      );
    }
    // No subcommand given: show help and exit non-zero. Help goes to stderr
    // (per the output contract: human text never pollutes stdout). An explicit
    // `--help` is intercepted earlier by commander and still prints to stdout.
    command.help({ error: true });
  });
  return program;
}

export async function run(argv: string[]): Promise<void> {
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
