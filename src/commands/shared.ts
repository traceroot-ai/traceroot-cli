import type { Command } from "commander";
import { type ApiClient, createApiClient } from "../api/client.js";
import { type Context, buildContext } from "../context.js";
import { CliError } from "../output.js";

/**
 * Help text appended to the new commands so the inherited program-wide `--json`
 * flag is discoverable from each subcommand's `--help` (commander does not list
 * root options under subcommands).
 */
const GLOBAL_JSON_HELP = "\nGlobal option:\n  --json  emit a single machine-readable JSON document";

/** Appends {@link GLOBAL_JSON_HELP} to a command's help and returns it (chainable). */
export function withGlobalJsonHelp<T extends Command>(command: T): T {
  command.addHelpText("after", GLOBAL_JSON_HELP);
  return command;
}

/** Build the per-invocation Context from a command's merged (global+local) options. */
export function contextFromCommand(command: Command): Context {
  const opts = command.optsWithGlobals();
  return buildContext({
    apiKey: opts.apiKey as string | undefined,
    host: opts.host as string | undefined,
    envFile: opts.envFile as string | undefined,
    json: opts.json as boolean | undefined,
  });
}

/**
 * Returns an authenticated API client from a resolved Context, or throws a
 * CliError (clean stderr, non-zero exit) when the api key or host is unresolved.
 * The api key is NEVER included in the error message.
 */
export function requireApiClient(ctx: Context): ApiClient {
  const apiKey = ctx.auth.apiKey.value;
  const host = ctx.auth.hostUrl.value;
  if (apiKey === undefined) {
    throw new CliError(
      "No API key found. Run `traceroot login`, or set TRACEROOT_API_KEY, or pass --api-key.",
    );
  }
  if (host === undefined) {
    throw new CliError(
      "No host found. Run `traceroot login`, or set TRACEROOT_HOST_URL, or pass --host.",
    );
  }
  return createApiClient({ host, apiKey });
}
