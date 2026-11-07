import type { Command } from "commander";
import { buildProgram } from "../../src/cli.js";
import { createFakeFetch } from "./fakeFetch.js";
import { StringSink } from "./stringSink.js";

/** A real program whose every request gets `response`, with its output captured. */
export function harness(response: Response) {
  const fake = createFakeFetch(() => response);
  const out = new StringSink();
  const err = new StringSink();
  const program = buildProgram({ registry: { fetchImpl: fake.fetchImpl, writers: { out, err } } });
  const run = (...argv: string[]) =>
    program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], { from: "user" });
  return { fake, out, err, run, program };
}

export function sqlCommand(program: Command): Command {
  const sql = program.commands.find((command) => command.name() === "sql");
  if (sql === undefined) throw new Error("sql not registered");
  return sql;
}
