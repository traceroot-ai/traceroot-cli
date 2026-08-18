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
export type TraceFilterValues = Ok200<paths["/api/v1/public/traces/filter-values/{field}"]["get"]>;
export type FindingList = Ok200<paths["/api/v1/public/detectors/findings"]["get"]>;
export type FindingDetail = Ok200<paths["/api/v1/public/detectors/findings/{finding_id}"]["get"]>;
export type DetectorList = Ok200<paths["/api/v1/public/detectors"]["get"]>;
export type WorkspaceList = Ok200<paths["/api/v1/public/workspaces"]["get"]>;
export type ProjectList = Ok200<paths["/api/v1/public/projects"]["get"]>;
export type SessionList = Ok200<paths["/api/v1/public/sessions"]["get"]>;
export type SessionDetail = Ok200<paths["/api/v1/public/sessions/{session_id}"]["get"]>;

/**
 * How the client obtains the bearer for each request.
 *
 * - `api-key`: a static project API key, sent verbatim.
 * - `token-provider`: user auth. The provider is asked for a bearer on EVERY
 *   request (it caches and re-mints the short-lived access JWT internally), so
 *   a token refresh between two calls is picked up transparently.
 */
export type ApiAuth =
  | { kind: "api-key"; key: string }
  | { kind: "token-provider"; getAccessToken: () => Promise<string> };

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

/**
 * Target project for the request. Required by the server when authenticating
 * with a user credential (a login is only meaningful scoped to a project); an
 * API key already fixes its project, so there it is optional and must match.
 */
export interface ProjectScopeParams {
  projectId?: string;
}

export interface ListTracesParams extends ProjectScopeParams {
  limit?: number;
  /** ISO 8601 lower bound (inclusive), sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive), sent as `end_before`. */
  endBefore?: string;
  /** Include traces produced by offline-evaluation runs (excluded by default). */
  includeEvaluations?: boolean;
  /** Filter by trace name (substring match). */
  name?: string;
  /** Filter by the user id recorded on the trace, sent as `user_id`. */
  userId?: string;
  /** Search across trace_id, name, session_id, user_id; sent as `search_query`. */
  searchQuery?: string;
  /**
   * Structured filter expression, sent verbatim as `filters` (a JSON array
   * string). The server validates the shape; an invalid value surfaces as a
   * normal CliError from a 400 response.
   */
  filters?: string;
}

export interface ListDetectorsParams extends ProjectScopeParams {
  limit?: number;
  /** ISO 8601 lower bound (inclusive) on creation time, sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) on creation time, sent as `end_before`. */
  endBefore?: string;
}

export interface ListFindingsParams extends ProjectScopeParams {
  limit?: number;
  /** ISO 8601 lower bound (inclusive), sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive), sent as `end_before`. */
  endBefore?: string;
  /** Detector selector (id, name, or template); resolved server-side. */
  detector?: string;
  /** Restrict to a single trace, sent as `trace_id`. */
  traceId?: string;
}

export interface TraceFieldsParams extends ProjectScopeParams {
  /**
   * Field projection to request, sent verbatim as `fields`, e.g. `full` or
   * `io,metadata`. The server validates the value; an invalid group surfaces
   * as a normal CliError from a 400 response.
   */
  fields?: string;
}

export interface ListProjectsParams {
  /** Restrict the result to projects in this workspace, sent as `workspace_id`. */
  workspaceId?: string;
}

export interface ListSessionsParams extends ProjectScopeParams {
  limit?: number;
  /** Search by session id, sent as `search_query`. */
  searchQuery?: string;
  /** ISO 8601 lower bound (inclusive), sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive), sent as `end_before`. */
  endBefore?: string;
}

export interface TimeRangeParams extends ProjectScopeParams {
  /** ISO 8601 lower bound (inclusive), sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive), sent as `end_before`. */
  endBefore?: string;
}

export interface ApiClient {
  whoami(): Promise<Whoami>;
  listTraces(params?: ListTracesParams): Promise<TraceList>;
  getTrace(traceId: string, params?: TraceFieldsParams): Promise<TraceDetail>;
  exportTrace(traceId: string, params?: TraceFieldsParams): Promise<TraceExport>;
  traceFilterValues(field: string, params?: TimeRangeParams): Promise<TraceFilterValues>;
  listDetectors(params?: ListDetectorsParams): Promise<DetectorList>;
  listFindings(params?: ListFindingsParams): Promise<FindingList>;
  getFinding(findingId: string, params?: ProjectScopeParams): Promise<FindingDetail>;
  getFindingByTrace(traceId: string, params?: ProjectScopeParams): Promise<FindingDetail>;
  /** The finding for a trace, or `null` when the trace has none (404). */
  findFindingByTrace(traceId: string, params?: ProjectScopeParams): Promise<FindingDetail | null>;
  listWorkspaces(): Promise<WorkspaceList>;
  listProjects(params?: ListProjectsParams): Promise<ProjectList>;
  listSessions(params?: ListSessionsParams): Promise<SessionList>;
  getSession(sessionId: string, params?: TimeRangeParams): Promise<SessionDetail>;
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
 * else (5xx, other 4xx) is treated as internal (1).
 */
function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) {
    return ExitCode.auth;
  }
  if (status === 404) {
    return ExitCode.notFound;
  }
  return ExitCode.internal;
}

/**
 * Serializes defined params into a `?`-prefixed query string (empty string when
 * nothing is set). Key order follows the object literal, so URLs are stable.
 */
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
  const base = opts.host.replace(/\/+$/, "");
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
  const userAgent = `traceroot-cli/${getVersion()}`;

  /**
   * Resolves the bearer for one request. In token-provider mode this may mint
   * (or transparently refresh) an access JWT; a provider failure propagates
   * unchanged and no network request is made for the read itself.
   */
  async function resolveBearer(): Promise<string> {
    return opts.auth.kind === "api-key" ? opts.auth.key : opts.auth.getAccessToken();
  }

  async function rawGet(path: string): Promise<Response> {
    const bearer = await resolveBearer();
    const url = `${base}${path}`;
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
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      throwIfTimeout(err);
      // The underlying message could echo request contents, so interpolate it
      // only after redacting the bearer.
      const message = err instanceof Error ? err.message : String(err);
      const safe = message.split(bearer).join("<redacted>");
      throw new CliError(`request to ${base} failed: ${safe}`, ExitCode.network);
    }
  }

  // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError". The
  // deadline covers the whole request, so it can fire while connecting, reading
  // headers, or streaming the body; report all of them with one friendly,
  // credential-free message naming the host and the timeout budget.
  function throwIfTimeout(err: unknown): void {
    if (opts.timeoutMs !== undefined && err instanceof Error && err.name === "TimeoutError") {
      throw new CliError(
        `request to ${base} timed out after ${opts.timeoutMs / 1000}s`,
        ExitCode.network,
      );
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
    // The server's instructive 400 for a user credential with no project scope
    // names the op (`list_projects`); translate that into the CLI's own flags.
    if (detail?.includes("project_id query parameter is required")) {
      detail = `${detail}\nHint: run \`traceroot projects list\`, then pass --project <id> (or set TRACEROOT_PROJECT_ID).`;
    }
    throw new CliError(
      detail ?? `request failed with status ${res.status}`,
      exitCodeForStatus(res.status),
    );
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

  /** Like {@link request}, but resolves `null` on a 404 instead of throwing. */
  async function requestOptional<T>(path: string): Promise<T | null> {
    const res = await rawGet(path);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      await failFor(res);
    }
    return readJson<T>(res);
  }

  return {
    whoami() {
      return request<Whoami>("/api/v1/public/whoami");
    },
    listTraces(params) {
      const query = toQuery({
        limit: params?.limit,
        start_after: params?.startAfter,
        end_before: params?.endBefore,
        include_evaluations: params?.includeEvaluations,
        name: params?.name,
        user_id: params?.userId,
        search_query: params?.searchQuery,
        filters: params?.filters,
        project_id: params?.projectId,
      });
      return request<TraceList>(`/api/v1/public/traces${query}`);
    },
    getTrace(traceId, params) {
      const query = toQuery({ fields: params?.fields, project_id: params?.projectId });
      return request<TraceDetail>(`/api/v1/public/traces/${encodeURIComponent(traceId)}${query}`);
    },
    exportTrace(traceId, params) {
      const query = toQuery({ fields: params?.fields, project_id: params?.projectId });
      return request<TraceExport>(
        `/api/v1/public/traces/${encodeURIComponent(traceId)}/export${query}`,
      );
    },
    traceFilterValues(field, params) {
      const query = toQuery({
        start_after: params?.startAfter,
        end_before: params?.endBefore,
        project_id: params?.projectId,
      });
      return request<TraceFilterValues>(
        `/api/v1/public/traces/filter-values/${encodeURIComponent(field)}${query}`,
      );
    },
    listDetectors(params) {
      const query = toQuery({
        limit: params?.limit,
        start_after: params?.startAfter,
        end_before: params?.endBefore,
        project_id: params?.projectId,
      });
      return request<DetectorList>(`/api/v1/public/detectors${query}`);
    },
    listFindings(params) {
      const query = toQuery({
        limit: params?.limit,
        start_after: params?.startAfter,
        end_before: params?.endBefore,
        detector: params?.detector,
        trace_id: params?.traceId,
        project_id: params?.projectId,
      });
      return request<FindingList>(`/api/v1/public/detectors/findings${query}`);
    },
    getFinding(findingId, params) {
      const query = toQuery({ project_id: params?.projectId });
      return request<FindingDetail>(
        `/api/v1/public/detectors/findings/${encodeURIComponent(findingId)}${query}`,
      );
    },
    getFindingByTrace(traceId, params) {
      const query = toQuery({ project_id: params?.projectId });
      return request<FindingDetail>(
        `/api/v1/public/detectors/traces/${encodeURIComponent(traceId)}/finding${query}`,
      );
    },
    findFindingByTrace(traceId, params) {
      const query = toQuery({ project_id: params?.projectId });
      return requestOptional<FindingDetail>(
        `/api/v1/public/detectors/traces/${encodeURIComponent(traceId)}/finding${query}`,
      );
    },
    listWorkspaces() {
      return request<WorkspaceList>("/api/v1/public/workspaces");
    },
    listProjects(params) {
      const query = toQuery({ workspace_id: params?.workspaceId });
      return request<ProjectList>(`/api/v1/public/projects${query}`);
    },
    listSessions(params) {
      const query = toQuery({
        limit: params?.limit,
        search_query: params?.searchQuery,
        start_after: params?.startAfter,
        end_before: params?.endBefore,
        project_id: params?.projectId,
      });
      return request<SessionList>(`/api/v1/public/sessions${query}`);
    },
    getSession(sessionId, params) {
      const query = toQuery({
        start_after: params?.startAfter,
        end_before: params?.endBefore,
        project_id: params?.projectId,
      });
      return request<SessionDetail>(
        `/api/v1/public/sessions/${encodeURIComponent(sessionId)}${query}`,
      );
    },
  };
}
