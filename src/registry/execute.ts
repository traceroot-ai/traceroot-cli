import { ApiClient, ApiError, type RegistryEntry, bearerAuth, dispatch } from "@traceroot-ai/tools";
import { normalizeBaseUrl } from "../api/client.js";
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

function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return ExitCode.auth;
  if (status === 404) return ExitCode.notFound;
  return ExitCode.internal;
}

/**
 * Dispatches one registry tool through the shared dispatcher, translating
 * failures into the CLI's existing error contract (same classes as
 * src/api/client.ts): 401/403→auth, 404→not-found, other HTTP→internal with the
 * server's `detail` when present; timeouts and transport failures→network with
 * the api key redacted from any surfaced message.
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
    ...(transport.fetchImpl !== undefined ? { fetchImpl: transport.fetchImpl } : {}),
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
    const message = err.detail !== "" ? err.detail : `request failed with status ${err.status}`;
    return new CliError(message, exitCodeForStatus(err.status));
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return new CliError(
      `request to ${transport.base} timed out after ${transport.timeoutMs / 1000}s`,
      ExitCode.network,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  const safe = message.split(transport.apiKey).join("<redacted>");
  return new CliError(`request to ${transport.base} failed: ${safe}`, ExitCode.network);
}
