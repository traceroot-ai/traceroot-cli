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

/** A resolved credential (kind + value) plus the hosts it authenticates against. */
export interface ResolvedAccess {
  /** Public API host (reads). */
  host: string;
  /** Host running device login + token mint; equals `host` unless split (dev). */
  authHost: string;
  kind: "api-key" | "session";
  value: string;
}

/**
 * Resolves the credential and hosts from a Context, or throws a CliError (clean
 * stderr, non-zero exit) when nothing resolved. Shared by the curated client
 * ({@link requireAuthedClient}) and the registry transport so both paths apply
 * one precedence and one error contract. The credential is NEVER in the message.
 */
export function requireAccess(ctx: Context): ResolvedAccess {
  const credential = ctx.auth.credential;
  const host = ctx.auth.hostUrl.value;
  if (credential.kind === "none" || credential.value === undefined) {
    throw new CliError(
      "No credentials found. Run `traceroot login` to sign in, or set TRACEROOT_API_KEY, or pass --api-key.",
      ExitCode.auth,
    );
  }
  if (host === undefined) {
    // Unreachable in practice (host resolution falls back to the default
    // production host), kept as a guard for hand-built contexts.
    throw new CliError(
      "No host found. Run `traceroot login`, or set TRACEROOT_HOST_URL, or pass --host.",
      ExitCode.auth,
    );
  }
  return {
    host,
    authHost: ctx.auth.authHost.value ?? host,
    kind: credential.kind,
    value: credential.value,
  };
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
 * resolved Context, or throws a CliError when no credential resolved. In session
 * mode every request bears a short-lived JWT minted from the stored session
 * token — never the session token itself.
 */
export function requireAuthedClient(ctx: Context): AuthedClient {
  const access = requireAccess(ctx);
  if (access.kind === "api-key") {
    return {
      kind: "api-key",
      client: createApiClient({
        host: access.host,
        auth: { kind: "api-key", key: access.value },
        timeoutMs: ctx.timeoutMs,
      }),
    };
  }
  const provider = createTokenProvider({
    authHost: access.authHost,
    sessionToken: access.value,
    timeoutMs: ctx.timeoutMs,
  });
  return {
    kind: "session",
    getAccessToken: () => provider.getAccessToken(),
    client: createApiClient({
      host: access.host,
      auth: {
        kind: "token-provider",
        getAccessToken: () => provider.getAccessToken(),
        invalidate: () => provider.invalidate(),
      },
      timeoutMs: ctx.timeoutMs,
    }),
  };
}

/** Convenience for commands that only need the client. */
export function requireApiClient(ctx: Context): ApiClient {
  return requireAuthedClient(ctx).client;
}
