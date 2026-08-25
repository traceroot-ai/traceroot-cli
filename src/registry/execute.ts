import { ApiClient, ApiError, type RegistryEntry, bearerAuth, dispatch } from "@traceroot-ai/tools";
import {
  exitCodeForStatus,
  normalizeBaseUrl,
  redactSecret,
  statusFallbackMessage,
  timeoutMessage,
  transportFailureMessage,
} from "../api/client.js";
import { requireAuth } from "../commands/shared.js";
import type { Context } from "../context.js";
import { CliError, ExitCode } from "../output.js";

export interface Transport {
  /** Normalized host (no trailing slash), already URL/scheme validated. */
  base: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function transportFromContext(
  ctx: Context,
  deps: { fetchImpl?: typeof fetch } = {},
): Transport {
  const { host, apiKey } = requireAuth(ctx);
  const transport: Transport = { base: normalizeBaseUrl(host), apiKey, timeoutMs: ctx.timeoutMs };
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
  const client = new ApiClient({
    baseUrl: transport.base,
    headers: { ...bearerAuth(transport.apiKey), accept: "application/json" },
    timeoutMs: transport.timeoutMs,
    fetchImpl: bufferedFetch(transport.fetchImpl ?? fetch),
  });
  try {
    return await dispatch(entry, args, client);
  } catch (err) {
    throw translate(err, transport);
  }
}

function translate(err: unknown, transport: Transport): unknown {
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
  const safe = redactSecret(message, transport.apiKey);
  return new CliError(transportFailureMessage(transport.base, safe), ExitCode.network);
}
