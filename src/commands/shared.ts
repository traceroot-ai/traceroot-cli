import type { Command } from "commander";
import { type ApiClient, createApiClient } from "../api/client.js";
import { type Context, buildContext } from "../context.js";
import { CliError } from "../output.js";

/**
 * Shared description for the `--json` option. The new commands declare `--json`
 * as a local option (so it appears in their own Options section alongside
 * `-h, --help`) even though it is also accepted as a program-wide flag; both
 * `traceroot --json <cmd>` and `traceroot <cmd> --json` resolve via
 * `optsWithGlobals()`. The wording notes that root/help itself emits no JSON.
 */
export const JSON_OPTION_DESC = "emit machine-readable JSON output for supported commands";

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
