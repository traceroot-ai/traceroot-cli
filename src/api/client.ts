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
export type FindingList = Ok200<paths["/api/v1/public/detectors/findings"]["get"]>;
export type FindingDetail = Ok200<paths["/api/v1/public/detectors/findings/{finding_id}"]["get"]>;

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

export interface ListFindingsParams {
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

export interface ApiClient {
  whoami(): Promise<Whoami>;
  listTraces(params?: ListTracesParams): Promise<TraceList>;
  getTrace(traceId: string): Promise<TraceDetail>;
  exportTrace(traceId: string): Promise<TraceExport>;
  listFindings(params?: ListFindingsParams): Promise<FindingList>;
  getFinding(findingId: string): Promise<FindingDetail>;
  getFindingByTrace(traceId: string): Promise<FindingDetail>;
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

  async function request<T>(path: string): Promise<T> {
    const url = `${base}${path}`;
    const init: RequestInit = { method: "GET", headers };
    if (opts.timeoutMs !== undefined) {
      // A fresh signal per request; aborts the fetch on timeout so a stalled
      // socket can't hang the process indefinitely.
      init.signal = AbortSignal.timeout(opts.timeoutMs);
    }
    let res: Response;
    try {
      res = await fetchImpl(url, init);
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
    listFindings(params) {
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
      if (params?.detector !== undefined) {
        search.set("detector", params.detector);
      }
      if (params?.traceId !== undefined) {
        search.set("trace_id", params.traceId);
      }
      const query = search.toString();
      return request<FindingList>(`/api/v1/public/detectors/findings${query ? `?${query}` : ""}`);
    },
    getFinding(findingId) {
      return request<FindingDetail>(
        `/api/v1/public/detectors/findings/${encodeURIComponent(findingId)}`,
      );
    },
    getFindingByTrace(traceId) {
      return request<FindingDetail>(
        `/api/v1/public/detectors/traces/${encodeURIComponent(traceId)}/finding`,
      );
    },
  };
}
