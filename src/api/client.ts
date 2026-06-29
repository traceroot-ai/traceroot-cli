import { CliError } from "../output.js";
import type { paths } from "./generated/schema.js";

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

// Hand-written types for SQL Gateway endpoints (not in openapi.json).
export interface SqlColumn {
  name: string;
  type: string;
}
export interface SqlQueryRequest {
  query: string;
  parameters?: Record<string, unknown>;
  max_rows?: number;
}
export interface SqlQueryResponse {
  columns: SqlColumn[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  statistics: Record<string, unknown>;
}
export interface SqlSchemaTable {
  name: string;
  columns: SqlColumn[];
}
export interface SqlSchemaResponse {
  tables: SqlSchemaTable[];
}

export interface ApiClientOptions {
  host: string;
  apiKey: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Optional per-request timeout in milliseconds. When set, each request aborts
   * after this long instead of blocking indefinitely on a stalled socket.
   */
  timeoutMs?: number;
}

export interface ListTracesParams {
  limit?: number;
  /** ISO 8601 lower bound (inclusive), sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive), sent as `end_before`. */
  endBefore?: string;
}

export interface ApiClient {
  whoami(): Promise<Whoami>;
  listTraces(params?: ListTracesParams): Promise<TraceList>;
  getTrace(traceId: string): Promise<TraceDetail>;
  exportTrace(traceId: string): Promise<TraceExport>;
  sqlQuery(body: SqlQueryRequest): Promise<SqlQueryResponse>;
  sqlSchema(): Promise<SqlSchemaResponse>;
}

/** Shape of a backend JSON error body. */
interface ErrorBody {
  detail?: string;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === "object" && value !== null;
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
    throw new CliError(`invalid host URL: ${base}`);
  }
  if (parsedHost.protocol !== "http:" && parsedHost.protocol !== "https:") {
    throw new CliError(`unsupported host scheme: ${parsedHost.protocol} (expected http or https)`);
  }
  const headers = {
    authorization: `Bearer ${opts.apiKey}`,
    accept: "application/json",
  };

  async function request<T>(
    path: string,
    reqInit?: { method?: string; body?: unknown },
  ): Promise<T> {
    const url = `${base}${path}`;
    const method = reqInit?.method ?? "GET";

    // Merge in content-type only for requests that carry a body.
    const requestHeaders =
      reqInit?.body !== undefined ? { ...headers, "content-type": "application/json" } : headers;

    const fetchInit: RequestInit = { method, headers: requestHeaders };

    if (reqInit?.body !== undefined) {
      fetchInit.body = JSON.stringify(reqInit.body);
    }

    if (opts.timeoutMs !== undefined) {
      // A fresh signal per request; aborts the fetch on timeout so a stalled
      // socket can't hang the process indefinitely.
      fetchInit.signal = AbortSignal.timeout(opts.timeoutMs);
    }

    let res: Response;
    try {
      res = await fetchImpl(url, fetchInit);
    } catch (err) {
      // Deliberately do NOT interpolate the underlying error message: it could
      // echo back request contents and leak the api key. Mention only the host.
      const message = err instanceof Error ? err.message : String(err);
      const safe = message.split(opts.apiKey).join("<redacted>");
      throw new CliError(`request to ${base} failed: ${safe}`);
    }

    if (!res.ok) {
      let detail: string | undefined;
      try {
        const body: unknown = await res.json();
        if (isErrorBody(body) && typeof body.detail === "string") {
          detail = body.detail;
        }
      } catch {
        // Ignore unreadable / non-JSON error bodies.
      }
      throw new CliError(detail ?? `request failed with status ${res.status}`);
    }

    return (await res.json()) as T;
  }

  return {
    whoami() {
      return request<Whoami>("/api/v1/public/whoami");
    },
    listTraces(params) {
      const search = new URLSearchParams();
      if (params?.limit !== undefined) {
        search.set("limit", String(params.limit));
      }
      if (params?.startAfter !== undefined) {
        search.set("start_after", params.startAfter);
      }
      if (params?.endBefore !== undefined) {
        search.set("end_before", params.endBefore);
      }
      const query = search.toString();
      return request<TraceList>(`/api/v1/public/traces${query ? `?${query}` : ""}`);
    },
    getTrace(traceId) {
      return request<TraceDetail>(`/api/v1/public/traces/${encodeURIComponent(traceId)}`);
    },
    exportTrace(traceId) {
      return request<TraceExport>(`/api/v1/public/traces/${encodeURIComponent(traceId)}/export`);
    },
    sqlQuery(body) {
      return request<SqlQueryResponse>("/api/v1/public/sql", { method: "POST", body });
    },
    sqlSchema() {
      return request<SqlSchemaResponse>("/api/v1/public/sql/schema");
    },
  };
}
