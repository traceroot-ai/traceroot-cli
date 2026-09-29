import { CliError } from "../output.js";
import type { TraceList } from "./client.js";

/**
 * Client for the setup-specific endpoints.
 *
 * These are NOT in `openapi.json` yet, so they are hand-typed here rather than
 * generated — deliberately kept out of `api/client.ts` so the boundary between
 * "shipped and generated from the published contract" and "awaiting backend
 * support" stays visible in the file layout.
 *
 * Every method here calls the real endpoint; when the deployment does not
 * implement it the call raises {@link BackendUnavailableError} and the caller
 * degrades to a documented manual path. Nothing is stubbed to succeed.
 */

/** Raised when an endpoint is absent (404) or not implemented (501). */
export class BackendUnavailableError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(path: string, status: number) {
    super(`endpoint not available: ${path}`);
    this.name = "BackendUnavailableError";
    this.status = status;
    this.path = path;
  }
}

/** A non-2xx response that is not an "endpoint missing" signal. */
export class SetupApiError extends CliError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SetupApiError";
    this.status = status;
  }
}

/** One workspace from `list_workspaces`. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

export interface ProjectSummary {
  project_id: string;
  project_name: string;
  workspace_id: string;
  workspace_name?: string | null;
}

/** Key metadata. The plaintext `key` is only ever present on creation. */
export interface ApiKeySummary {
  id: string;
  name: string | null;
  hint: string;
  project_id: string;
  expires_at: string | null;
  last_used_at?: string | null;
  created_at?: string;
  /**
   * What the key may do: `ingest` (send telemetry only) or `admin` (everything
   * the project allows). Optional because a deployment predating scopes returns
   * nothing here; treat its absence as "full project rights".
   */
  scope?: string;
}

export interface CreatedApiKey extends ApiKeySummary {
  /** Returned exactly once, at creation. */
  key: string;
}

export interface SetupApiOptions {
  host: string;
  /** A project API key, for the key-authenticated routes. */
  apiKey?: string;
  /**
   * The user credential, for the account-scope routes.
   *
   * Supplies a freshly-minted access JWT per request rather than a fixed
   * string, because that JWT lives ten minutes — a client built once and used
   * across a wizard run would otherwise go stale mid-run.
   */
  tokenProvider?: { getAccessToken(): Promise<string> };
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SetupApi {
  /**
   * Traces for this project, newest first.
   *
   * Here rather than on the generated client because the wizard's one read must
   * not depend on which operations the tool registry chooses to expose. It is
   * the same public endpoint either way.
   */
  listTraces(params?: { limit?: number; startAfter?: string }): Promise<TraceList>;
  /** The workspaces this user belongs to. Account-scope; needs a user credential. */
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  /** The projects this user can reach, optionally narrowed to one workspace. */
  listProjects(workspaceId?: string): Promise<ProjectSummary[]>;
  /**
   * Creates a project. `workspaceId` is required only when the user belongs to
   * several workspaces — the server refuses to guess rather than risk creating
   * it in the wrong one, which is discovered weeks later.
   */
  createProject(name: string, workspaceId?: string): Promise<ProjectSummary>;
  listApiKeys(projectId: string): Promise<ApiKeySummary[]>;
  createApiKey(input: {
    name: string;
    projectId: string;
    expiresInDays: number | null;
  }): Promise<CreatedApiKey>;
  /**
   * Mints a key for an arbitrary project the *user* can reach, authenticated by
   * a CLI token rather than a key for that same project.
   *
   * `createApiKey` cannot do this: it authenticates with a key for the project
   * it mints into, which is fine for rotation and useless before the first key
   * exists.
   */
  createProjectApiKey(input: {
    projectId: string;
    name: string;
    scope?: "ingest" | "admin";
    expiresInDays: number | null;
  }): Promise<CreatedApiKey>;
  revokeApiKey(keyId: string): Promise<void>;
}

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  /** Overrides the client's own credential for this one call. */
  bearer?: string;
  /** Sends no Authorization header at all. */
  anonymous?: boolean;
}

function errorDetail(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") {
      return detail;
    }
  }
  return undefined;
}

/** Creates the setup API client. No network activity happens on construction. */
export function createSetupApi(opts: SetupApiOptions): SetupApi {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.host.replace(/\/+$/, "");

  async function request<T>(options: RequestOptions): Promise<T> {
    const url = `${base}${options.path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.anonymous !== true) {
      // Minted per request, because an access JWT lives ten minutes and a
      // wizard run outlasts that. `bearer` and a project key are both fixed
      // strings and take precedence when present.
      const token =
        options.bearer ??
        opts.apiKey ??
        (opts.tokenProvider === undefined ? undefined : await opts.tokenProvider.getAccessToken());
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      }
    }
    const init: RequestInit = { method: options.method, headers };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (opts.signal !== undefined) {
      init.signal = opts.signal;
    } else if (opts.timeoutMs !== undefined) {
      init.signal = AbortSignal.timeout(opts.timeoutMs);
    }

    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      // Never interpolate the raw error: it can echo request contents, which
      // for these endpoints includes credentials.
      const message = err instanceof Error ? err.message : String(err);
      const safe =
        opts.apiKey === undefined ? message : message.split(opts.apiKey).join("<redacted>");
      throw new SetupApiError(`request to ${base} failed: ${safe}`, 0);
    }

    if (res.status === 404 || res.status === 501) {
      throw new BackendUnavailableError(options.path, res.status);
    }

    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = errorDetail(await res.json());
      } catch {
        // Unreadable / non-JSON error body.
      }
      throw new SetupApiError(detail ?? `request failed with status ${res.status}`, res.status);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  /** Unwraps `{ projects: [...] }` or a bare array, so either shape works. */
  function unwrap<T>(response: unknown, key: string): T[] {
    if (Array.isArray(response)) {
      return response as T[];
    }
    if (typeof response === "object" && response !== null) {
      const inner = (response as Record<string, unknown>)[key];
      if (Array.isArray(inner)) {
        return inner as T[];
      }
    }
    return [];
  }

  return {
    listTraces(params) {
      const query = new URLSearchParams();
      if (params?.limit !== undefined) {
        query.set("limit", String(params.limit));
      }
      if (params?.startAfter !== undefined) {
        query.set("start_after", params.startAfter);
      }
      const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
      return request<TraceList>({ method: "GET", path: `/api/v1/public/traces${suffix}` });
    },
    async listWorkspaces() {
      const response = await request<unknown>({
        method: "GET",
        path: "/api/v1/public/workspaces",
      });
      return unwrap<WorkspaceSummary>(response, "data");
    },
    async listProjects(workspaceId) {
      const query =
        workspaceId === undefined ? "" : `?workspace_id=${encodeURIComponent(workspaceId)}`;
      const response = await request<unknown>({
        method: "GET",
        path: `/api/v1/public/projects${query}`,
      });
      // `list_projects` answers `{data: [{id, name, workspace_id, workspace_name}]}`.
      // The wizard speaks in `project_id`/`project_name` throughout, so the
      // translation happens once, here, rather than at every call site.
      return unwrap<Record<string, unknown>>(response, "data").map((item) => ({
        project_id: String(item.id ?? item.project_id ?? ""),
        project_name: String(item.name ?? item.project_name ?? ""),
        workspace_id: String(item.workspace_id ?? ""),
        workspace_name: typeof item.workspace_name === "string" ? item.workspace_name : null,
      }));
    },
    createProject(name, workspaceId) {
      return request<ProjectSummary>({
        method: "POST",
        path: "/api/v1/public/projects",
        body: workspaceId === undefined ? { name } : { name, workspace_id: workspaceId },
      });
    },
    async listApiKeys(_projectId) {
      // Scoped server-side to the authenticating key's project, so the
      // parameter is unused here; it is kept for call-site clarity.
      const response = await request<unknown>({
        method: "GET",
        path: "/api/v1/public/api-keys",
      });
      return unwrap<ApiKeySummary>(response, "keys");
    },
    createApiKey(input) {
      return request<CreatedApiKey>({
        method: "POST",
        path: "/api/v1/public/api-keys",
        // No `project_id`: the server derives the project from the credential,
        // so sending one could only ever disagree with it.
        body: {
          name: input.name,
          expires_in_days: input.expiresInDays,
        },
      });
    },
    createProjectApiKey(input) {
      return request<CreatedApiKey>({
        method: "POST",
        path: `/api/v1/public/projects/${encodeURIComponent(input.projectId)}/api-keys`,
        body: {
          name: input.name,
          scope: input.scope,
          expires_in_days: input.expiresInDays,
        },
      });
    },
    async revokeApiKey(keyId) {
      await request<void>({
        method: "DELETE",
        path: `/api/v1/public/api-keys/${encodeURIComponent(keyId)}`,
      });
    },
  };
}
