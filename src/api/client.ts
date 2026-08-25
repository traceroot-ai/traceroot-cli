import { CliError, ExitCode } from "../output.js";
import { getVersion } from "../version.js";
import type { paths } from "./generated/schema.js";

/** Default per-request timeout when a caller doesn't specify one. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Name-agnostic extractor for an operation's JSON 200 body. */
type Ok200<Op> = Op extends {
  responses: { 200: { content: { "application/json": infer B } } };
}
  ? B
  : never;

export type Whoami = Ok200<paths["/api/v1/public/whoami"]["get"]>;
export type TraceList = Ok200<paths["/api/v1/public/traces"]["get"]>;
export type TraceDetail = Ok200<paths["/api/v1/public/traces/{trace_id}"]["get"]>;
export type TraceExport = Ok200<paths["/api/v1/public/traces/{trace_id}/export"]["get"]>;
export type FindingList = Ok200<paths["/api/v1/public/detectors/findings"]["get"]>;
export type FindingDetail = Ok200<paths["/api/v1/public/detectors/findings/{finding_id}"]["get"]>;
export type DetectorList = Ok200<paths["/api/v1/public/detectors"]["get"]>;
export type WorkspaceList = Ok200<paths["/api/v1/public/workspaces"]["get"]>;
export type ProjectList = Ok200<paths["/api/v1/public/projects"]["get"]>;

/**
 * How the client obtains the bearer for each request.
 *
 * - `api-key`: a static project API key, sent verbatim.
 * - `token-provider`: user (session) auth. The provider is asked for a bearer on
 *   EVERY request — it caches and re-mints the short-lived access JWT internally
 *   — so a token refresh between two calls is picked up transparently.
 */
export type ApiAuth =
  | { kind: "api-key"; key: string }
  | {
      kind: "token-provider";
      getAccessToken: () => Promise<string>;
      /**
       * Drops the provider's cached token so the next `getAccessToken` re-mints.
       * Called by the client after a 401 to recover a token that expired or was
       * rotated mid-session, then retry the request once. Required: a cached
       * provider that cannot be invalidated would make the retry resend the
       * same stale bearer.
       */
      invalidate: () => void;
    };

export interface ApiClientOptions {
  host: string;
  auth: ApiAuth;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Optional per-request timeout in milliseconds. When set, each request aborts
   * after this long instead of blocking indefinitely on a stalled socket.
   */
  timeoutMs?: number;
}

/** Restrict `listProjects` to one workspace (sent as the `workspace_id` query). */
export interface ListProjectsParams {
  workspaceId?: string;
}

export interface ApiClient {
  whoami(): Promise<Whoami>;
  /** Account-scope discovery (user-credential only; a project API key gets 403). */
  listWorkspaces(): Promise<WorkspaceList>;
  /** Account-scope discovery (user-credential only; a project API key gets 403). */
  listProjects(params?: ListProjectsParams): Promise<ProjectList>;
}

/** Shape of a backend JSON error body. */
interface ErrorBody {
  detail?: string;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === "object" && value !== null;
}

/**
 * Classifies a non-2xx HTTP status into a CLI exit-code class so scripts can tell
 * re-auth (401/403) from give-up (404) from an unexpected server error. Anything
 * else (5xx, other 4xx) is treated as internal (1). Shared with the registry
 * executor so the exit-code contract has exactly one definition.
 */
export function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) {
    return ExitCode.auth;
  }
  if (status === 404) {
    return ExitCode.notFound;
  }
  return ExitCode.internal;
}

/** Replaces every occurrence of `secret` in a message with `<redacted>`. */
export function redactSecret(message: string, secret: string): string {
  return message.split(secret).join("<redacted>");
}

/** The one wording for a request that hit the timeout budget. */
export function timeoutMessage(base: string, timeoutMs: number): string {
  return `request to ${base} timed out after ${timeoutMs / 1000}s`;
}

/** The one wording for a transport-level failure (host named, never the key). */
export function transportFailureMessage(base: string, safeDetail: string): string {
  return `request to ${base} failed: ${safeDetail}`;
}

/** The one wording for an HTTP error whose body carried no usable detail. */
export function statusFallbackMessage(status: number): string {
  return `request failed with status ${status}`;
}

/**
 * Validates and normalizes a host URL: strips trailing slashes and rejects
 * malformed URLs or unsupported schemes. Shared by {@link createApiClient} and
 * the registry executor, which both need the same host validation ahead of a
 * request.
 */
export function normalizeBaseUrl(host: string): string {
  const base = host.replace(/\/+$/, "");
  let parsedHost: URL;
  try {
    parsedHost = new URL(base);
  } catch {
    throw new CliError(`invalid host URL: ${base}`, ExitCode.usage);
  }
  if (parsedHost.protocol !== "http:" && parsedHost.protocol !== "https:") {
    throw new CliError(
      `unsupported host scheme: ${parsedHost.protocol} (expected http or https)`,
      ExitCode.usage,
    );
  }
  return base;
}

/** Serializes defined params into a `?a=b&c=d` query string (empty when none). */
function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * Creates a thin typed client over the public REST API. No network activity
 * occurs on construction — only the request methods call `fetch`.
 */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = normalizeBaseUrl(opts.host);
  const userAgent = `traceroot-cli/${getVersion()}`;

  /**
   * Resolves the bearer for one request. In token-provider mode this may mint
   * (or transparently refresh) an access JWT; a provider failure propagates
   * unchanged and no network request is made for the read itself.
   */
  function resolveBearer(): Promise<string> {
    return opts.auth.kind === "api-key"
      ? Promise.resolve(opts.auth.key)
      : opts.auth.getAccessToken();
  }

  async function rawGet(path: string): Promise<Response> {
    const url = `${base}${path}`;
    let refreshed = false;
    while (true) {
      const bearer = await resolveBearer();
      const init: RequestInit = {
        method: "GET",
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
          "user-agent": userAgent,
        },
      };
      if (opts.timeoutMs !== undefined) {
        // A fresh signal per request; aborts the fetch on timeout so a stalled
        // socket can't hang the process indefinitely.
        init.signal = AbortSignal.timeout(opts.timeoutMs);
      }
      let res: Response;
      try {
        res = await fetchImpl(url, init);
      } catch (err) {
        throwIfTimeout(err);
        // Deliberately do NOT interpolate the underlying error message raw: it
        // could echo request contents and leak the bearer. Redact it first.
        const message = err instanceof Error ? err.message : String(err);
        const safe = redactSecret(message, bearer);
        throw new CliError(transportFailureMessage(base, safe), ExitCode.network);
      }
      // A 401 in token-provider mode usually means the cached access JWT just
      // expired or was rotated: drop it, re-mint, and retry the request once
      // before surfacing the error. A second 401 (or a revoked session, which
      // makes the re-mint itself throw an auth error) propagates normally.
      if (res.status === 401 && opts.auth.kind === "token-provider" && !refreshed) {
        refreshed = true;
        opts.auth.invalidate();
        // The abandoned 401 response's body is never read; cancel it so its
        // stream/socket doesn't linger for the rest of the process.
        await res.body?.cancel().catch(() => {});
        continue;
      }
      return res;
    }
  }

  // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError". The
  // deadline covers the whole request, so it can fire while connecting, reading
  // headers, or streaming the body; report all of them with one friendly,
  // credential-free message naming the host and the timeout budget.
  function throwIfTimeout(err: unknown): void {
    if (opts.timeoutMs !== undefined && err instanceof Error && err.name === "TimeoutError") {
      throw new CliError(timeoutMessage(base, opts.timeoutMs), ExitCode.network);
    }
  }

  async function failFor(res: Response): Promise<never> {
    let detail: string | undefined;
    try {
      const body: unknown = await res.json();
      if (isErrorBody(body) && typeof body.detail === "string") {
        detail = body.detail;
      }
    } catch {
      // Ignore unreadable / non-JSON error bodies.
    }
    throw new CliError(detail ?? statusFallbackMessage(res.status), exitCodeForStatus(res.status));
  }

  /** Reads a JSON body, translating a body-phase timeout into the same message. */
  async function readJson<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (err) {
      throwIfTimeout(err);
      throw err;
    }
  }

  async function request<T>(path: string): Promise<T> {
    const res = await rawGet(path);
    if (!res.ok) {
      await failFor(res);
    }
    return readJson<T>(res);
  }

  return {
    whoami() {
      return request<Whoami>("/api/v1/public/whoami");
    },
    listWorkspaces() {
      return request<WorkspaceList>("/api/v1/public/workspaces");
    },
    listProjects(params) {
      const query = toQuery({ workspace_id: params?.workspaceId });
      return request<ProjectList>(`/api/v1/public/projects${query}`);
    },
  };
}
