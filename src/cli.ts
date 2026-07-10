import { Command, Option } from "commander";
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
  // Surface program-wide global flags (e.g. `--json`) in every subcommand's
  // `--help` under a "Global Options" section, so they're discoverable where
  // users look (e.g. `traceroot traces list --help`). `-h, --help` is available
  // on every command, so it belongs there too — not repeated in each command's
  // own "Options". The root command keeps `--help` in its "Options" (it has no
  // "Global Options" section). Subcommands are listed by name only in the root
  // summary (no trailing "[options]"), so every command reads consistently.
  const notHidden = (o: Option): boolean => !(o as Option & { hidden?: boolean }).hidden;
  const helpOption = (): Option => new Option("-h, --help", "display help for command");
  program.configureHelp({
    showGlobalOptions: true,
    subcommandTerm: (cmd) => cmd.name(),
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
    .option("--json", "emit machine-readable JSON output for supported commands")
    .option("--timeout <ms>", "per-request network timeout in milliseconds (default: 30000)");
  registerCommands(program);
  // Make the exit-code contract discoverable from `traceroot --help` so scripts
  // know how to branch on failures (mirrors the README table).
  program.addHelpText(
    "after",
    [
      "",
      "Exit codes:",
      "  0  success",
      "  1  internal   unexpected/internal error",
      "  2  usage      invalid arguments or options",
      "  3  auth       authentication required or invalid",
      "  4  not_found  the requested resource does not exist",
      "  5  network    network failure or timeout (retryable)",
      "",
      'Under --json, failures also print {"error":{"code","message"}} to stderr.',
    ].join("\n"),
  );
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
    // The central catch has no resolved Context, so detect `--json` straight from
    // argv (the accepted approach) to pick the machine-readable error envelope.
    const json = argv.includes("--json");
    // Set `process.exitCode` rather than calling `process.exit`, so a piped
    // stderr can fully drain before the process ends instead of being truncated.
    process.exitCode = reportError(err, { json });
  }
}
