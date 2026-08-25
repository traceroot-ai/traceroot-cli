import { ApiClient, ApiError, type RegistryEntry, bearerAuth, dispatch } from "@traceroot-ai/tools";
import {
  exitCodeForStatus,
  normalizeBaseUrl,
  redactSecret,
  statusFallbackMessage,
  timeoutMessage,
  transportFailureMessage,
} from "../api/client.js";
import { createTokenProvider } from "../auth/token.js";
import { requireAccess } from "../commands/shared.js";
import type { Context } from "../context.js";
import { CliError, ExitCode } from "../output.js";
import { getVersion } from "../version.js";

/**
 * How the registry transport obtains the bearer for a dispatch.
 *
 * - `api-key`: a static project key, used verbatim.
 * - `token-provider`: user (session) auth. `getAccessToken` mints/refreshes the
 *   short-lived access JWT; a 401 calls `invalidate` and re-mints once.
 */
export type TransportAuth =
  | { kind: "api-key"; key: string }
  | {
      kind: "token-provider";
      getAccessToken: () => Promise<string>;
      invalidate: () => void;
    };

export interface Transport {
  /** Normalized host (no trailing slash), already URL/scheme validated. */
  base: string;
  auth: TransportAuth;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function transportFromContext(
  ctx: Context,
  deps: { fetchImpl?: typeof fetch } = {},
): Transport {
  const access = requireAccess(ctx);
  let auth: TransportAuth;
  if (access.kind === "api-key") {
    auth = { kind: "api-key", key: access.value };
  } else {
    // The mint must go through the caller's fetch too: with the global fetch a
    // test fake could never intercept /api/cli/token, and a generated command
    // would make an uncontrolled real request before its faked read.
    const provider = createTokenProvider({
      authHost: access.authHost,
      sessionToken: access.value,
      timeoutMs: ctx.timeoutMs,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    auth = {
      kind: "token-provider",
      getAccessToken: () => provider.getAccessToken(),
      invalidate: () => provider.invalidate(),
    };
  }
  const transport: Transport = {
    base: normalizeBaseUrl(access.host),
    auth,
    timeoutMs: ctx.timeoutMs,
  };
  if (deps.fetchImpl !== undefined) {
    transport.fetchImpl = deps.fetchImpl;
  }
  return transport;
}

/**
 * Buffers every response body before the registry client sees it, so a failure
 * while STREAMING an HTTP error's body cannot demote a status-class error
 * (401→auth, 404→not-found) to a network failure: the registry client reads the
 * error body unguarded, and without this a body-read throw would escape before
 * `ApiError` carries the status out. An error status whose body cannot be read
 * is passed through with an empty body (→ the generic status message); a body
 * failure on a SUCCESS response still throws, so timeouts keep their wording.
 */
function bufferedFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      if (!response.ok) {
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      throw err;
    }
    return new Response(text.length > 0 ? text : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Dispatches one registry tool through the shared dispatcher, translating
 * failures into the CLI's error contract (single-sourced in src/api/client.ts):
 * 401/403→auth, 404→not-found, other HTTP→internal with the server's `detail`
 * when present; timeouts and transport failures→network with the api key
 * redacted from any surfaced message.
 */
export async function executeTool(
  entry: RegistryEntry,
  args: Record<string, unknown>,
  transport: Transport,
): Promise<unknown> {
  const userAgent = `traceroot-cli/${getVersion()}`;
  let refreshed = false;
  while (true) {
    const bearer =
      transport.auth.kind === "api-key"
        ? transport.auth.key
        : await transport.auth.getAccessToken();
    const client = new ApiClient({
      baseUrl: transport.base,
      headers: { ...bearerAuth(bearer), accept: "application/json", "user-agent": userAgent },
      timeoutMs: transport.timeoutMs,
      fetchImpl: bufferedFetch(transport.fetchImpl ?? fetch),
    });
    try {
      return await dispatch(entry, args, client);
    } catch (err) {
      // A 401 under session auth usually means the cached access JWT just
      // expired or was rotated: drop it, re-mint, and retry the dispatch once.
      // A second 401 (or a revoked session, whose re-mint itself throws auth)
      // propagates. An api key never retries.
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        transport.auth.kind === "token-provider" &&
        !refreshed
      ) {
        refreshed = true;
        transport.auth.invalidate();
        continue;
      }
      throw translate(err, transport, bearer);
    }
  }
}

function translate(err: unknown, transport: Transport, bearer: string): unknown {
  if (err instanceof CliError) return err;
  if (err instanceof ApiError) {
    const message = err.detail !== "" ? err.detail : statusFallbackMessage(err.status);
    return new CliError(message, exitCodeForStatus(err.status));
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return new CliError(timeoutMessage(transport.base, transport.timeoutMs), ExitCode.network);
  }
  if (err instanceof SyntaxError) {
    // A 2xx response whose body isn't valid JSON (the registry client parses
    // success bodies unconditionally) is a server-side contract violation, not
    // a transport failure: internal (1), never retryable network (5).
    return new CliError(`request to ${transport.base} returned invalid JSON`, ExitCode.internal);
  }
  const message = err instanceof Error ? err.message : String(err);
  const safe = redactSecret(message, bearer);
  return new CliError(transportFailureMessage(transport.base, safe), ExitCode.network);
}
