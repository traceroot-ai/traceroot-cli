import type { Command } from "commander";
import { type ApiClient, createApiClient } from "../api/client.js";
import { createTokenProvider } from "../auth/token.js";
import { type Context, buildContext } from "../context.js";
import { CliError, ExitCode } from "../output.js";

/** Build the per-invocation Context from a command's merged (global+local) options. */
export function contextFromCommand(command: Command): Context {
  const opts = command.optsWithGlobals();
  return buildContext({
    apiKey: opts.apiKey as string | undefined,
    host: opts.host as string | undefined,
    authHost: opts.authHost as string | undefined,
    project: opts.project as string | undefined,
    envFile: opts.envFile as string | undefined,
    json: opts.json as boolean | undefined,
    timeout: opts.timeout as string | undefined,
  });
}

/** An authenticated API client plus the credential kind that backs it. */
export interface AuthedClient {
  client: ApiClient;
  kind: "api-key" | "session";
  /**
   * Session mode only: mints (or returns the cached) short-lived access JWT.
   * Exposed for commands that need the raw JWT (identity display) — reads go
   * through `client`, which pulls its bearer from the same provider.
   */
  getAccessToken?: () => Promise<string>;
}

/**
 * Returns an authenticated API client (with its credential kind) from a
 * resolved Context, or throws a CliError (clean stderr, non-zero exit) when no
 * credential resolved. In session mode every request bears a short-lived JWT
 * minted from the stored session token — never the session token itself. The
 * credential is NEVER included in the error message.
 */
export function requireAuthedClient(ctx: Context): AuthedClient {
  const credential = ctx.auth.credential;
  const host = ctx.auth.hostUrl.value;
  if (credential.kind === "none" || credential.value === undefined) {
    throw new CliError(
      "No credentials found. Run `traceroot login` to sign in, or set TRACEROOT_API_KEY, or pass --api-key.",
      ExitCode.auth,
    );
  }
  if (host === undefined) {
    // Unreachable in practice (the host resolution falls back to the default
    // production host), kept as a guard for hand-built contexts.
    throw new CliError(
      "No host found. Run `traceroot login`, or set TRACEROOT_HOST_URL, or pass --host.",
      ExitCode.auth,
    );
  }
  if (credential.kind === "api-key") {
    return {
      kind: "api-key",
      client: createApiClient({
        host,
        auth: { kind: "api-key", key: credential.value },
        timeoutMs: ctx.timeoutMs,
      }),
    };
  }
  const provider = createTokenProvider({
    authHost: ctx.auth.authHost.value ?? host,
    sessionToken: credential.value,
    timeoutMs: ctx.timeoutMs,
  });
  return {
    kind: "session",
    getAccessToken: () => provider.getAccessToken(),
    client: createApiClient({
      host,
      auth: { kind: "token-provider", getAccessToken: () => provider.getAccessToken() },
      timeoutMs: ctx.timeoutMs,
    }),
  };
}

/** Convenience for commands that only need the client. */
export function requireApiClient(ctx: Context): ApiClient {
  return requireAuthedClient(ctx).client;
}
