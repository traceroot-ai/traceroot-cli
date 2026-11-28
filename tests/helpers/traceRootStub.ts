import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for a TraceRoot host, for tests of what the CLI and the eval runners it starts send
 * there. It listens on 127.0.0.1, records every request, and answers the routes a key check and an
 * eval upload use:
 * - `GET /api/v1/public/whoami`, the key check;
 * - the dataset routes an SDK publishes a `Dataset` through: it knows no dataset, so a runner
 *   publishes one before every uploaded run;
 * - the evaluation run routes: registering a run, which it answers with a run id and the run's
 *   link, as TraceRoot does, a result per case, completing the run, and reading one, which it
 *   answers as a completed run of `uppercase` whatever the id, with the `usage` it was given;
 * - `POST /api/v1/public/traces`, where the SDKs export spans.
 *
 * Every other request gets a 404. A request without the accepted key as its bearer gets a 401.
 */

export interface StubRequest {
  method: string;
  /** The path and query, as sent. */
  path: string;
  /** The `Authorization` header, or null without one. */
  authorization: string | null;
  contentType: string | null;
  /** The body: as text when it is JSON or text, and as base64 otherwise, such as a span export. */
  body: string;
}

export interface TraceRootStubOptions {
  /** The bearer key the stub accepts. Defaults to {@link STUB_API_KEY}. */
  apiKey?: string;
  /** Answer every upload request (anything but `whoami`) with a 403, as for a key that can't write. */
  rejectUploads?: boolean;
  /** Accept a run and its results, then answer its completion with a 500. */
  failCompletion?: boolean;
  /** The `usage` a run read answers with. Without it the answer has none, as an older host's. */
  runUsage?: unknown;
  /** Never answer a run read, as a host that stalls: the request stays open until the stub closes. */
  holdRunReads?: boolean;
}

export interface TraceRootStub {
  /** The host, as `http://127.0.0.1:<port>`. */
  url: string;
  /** Every request so far, in the order they arrived. */
  requests: StubRequest[];
  close(): Promise<void>;
}

/** The key the stub accepts unless told another. Fake: it works nowhere else. */
export const STUB_API_KEY = "tr-fake-stub-0000";

/** The project the stub's key belongs to. */
export const STUB_PROJECT_ID = "prj_stub_0001";

const PUBLIC = "/api/v1/public";

export async function startTraceRootStub(
  options: TraceRootStubOptions = {},
): Promise<TraceRootStub> {
  const apiKey = options.apiKey ?? STUB_API_KEY;
  const requests: StubRequest[] = [];
  let runs = 0;
  let versions = 0;

  const server = createServer((req, res) => {
    void readBody(req).then((bytes) => {
      const path = req.url ?? "/";
      const contentType = req.headers["content-type"] ?? null;
      const text = contentType === null || /json|^text\//.test(contentType);
      requests.push({
        method: req.method ?? "",
        path,
        authorization: req.headers.authorization ?? null,
        contentType,
        body: bytes.toString(text ? "utf8" : "base64"),
      });
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        send(res, 401, { detail: "Invalid API key" });
        return;
      }
      const route = `${req.method} ${path.split("?")[0]}`;
      if (route === `GET ${PUBLIC}/whoami`) {
        send(res, 200, whoami(url));
        return;
      }
      if (options.rejectUploads) {
        send(res, 403, { detail: "This API key can't write to the project" });
        return;
      }
      if (/^GET \/api\/v1\/public\/datasets\/[^/]+$/.test(route)) {
        send(res, 404, { detail: "Dataset not found" });
      } else if (route === `POST ${PUBLIC}/datasets`) {
        send(res, 200, {});
      } else if (/^POST \/api\/v1\/public\/datasets\/[^/]+\/versions$/.test(route)) {
        versions += 1;
        send(res, 200, { dataset_version_id: `dsv_stub_${versions}`, version_number: versions });
      } else if (/^GET \/api\/v1\/public\/evaluation-runs\/[^/]+$/.test(route)) {
        if (options.holdRunReads) {
          return;
        }
        const id = decodeURIComponent(route.slice(route.lastIndexOf("/") + 1));
        send(res, 200, {
          evaluation_run_id: id,
          evaluation_name: "uppercase",
          status: "completed",
          ...(options.runUsage === undefined ? {} : { usage: options.runUsage }),
        });
      } else if (route === `POST ${PUBLIC}/evaluation-runs`) {
        runs += 1;
        const id = `evr_stub_${runs}`;
        send(res, 200, { evaluation_run_id: id, run_url: stubRunUrl(url, id) });
      } else if (/^POST \/api\/v1\/public\/evaluation-runs\/[^/]+\/results$/.test(route)) {
        send(res, 200, {});
      } else if (/^POST \/api\/v1\/public\/evaluation-runs\/[^/]+\/complete$/.test(route)) {
        if (options.failCompletion) {
          send(res, 500, { detail: "the stub fails every completion" });
        } else {
          send(res, 200, {});
        }
      } else if (route === `POST ${PUBLIC}/traces`) {
        send(res, 200, {});
      } else {
        send(res, 404, { detail: `no route for ${route}` });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** The link the stub at `host` gives the run `id`, where TraceRoot shows a run. */
export function stubRunUrl(host: string, id: string): string {
  return `${host}/projects/${STUB_PROJECT_ID}/evaluations/${id}`;
}

/** The key check's answer for the stub's project. */
function whoami(host: string): Record<string, unknown> {
  return {
    project_id: STUB_PROJECT_ID,
    project_name: "Stub project",
    workspace_id: "wsp_stub_0001",
    workspace_name: "Stub workspace",
    key_name: "stub key",
    key_hint: "tr-…0000",
    host,
    ui_base_url: host,
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}
