import { describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { CliError, ExitCode } from "../../src/output.js";
import { createFakeFetch, errorResponse, jsonResponse } from "../helpers/fakeFetch.js";

const API_KEY = "tr_secret_LEAK";

function clientWith(responder: Parameters<typeof createFakeFetch>[0], host = "https://h") {
  const fake = createFakeFetch(responder);
  const client = createApiClient({ host, apiKey: API_KEY, fetchImpl: fake.fetchImpl });
  return { client, calls: fake.calls };
}

describe("createApiClient", () => {
  it("does not touch the network on construction", () => {
    const { calls } = clientWith(() => jsonResponse({}));
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-http(s) host at construction", () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    expect(() =>
      createApiClient({ host: "file:///etc/passwd", apiKey: API_KEY, fetchImpl: fake.fetchImpl }),
    ).toThrow(CliError);
    expect(() =>
      createApiClient({ host: "not a url", apiKey: API_KEY, fetchImpl: fake.fetchImpl }),
    ).toThrow(CliError);
    expect(fake.calls).toHaveLength(0);
  });

  it("calls whoami with bearer auth and the right url", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ ok: true }));
    await client.whoami();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://h/api/v1/public/whoami");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("adds ?limit only when provided", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ traces: [] }));
    await client.listTraces({ limit: 5 });
    expect(calls[0]?.url.endsWith("/api/v1/public/traces?limit=5")).toBe(true);

    await client.listTraces();
    expect(calls[1]?.url).toBe("https://h/api/v1/public/traces");
    expect(calls[1]?.url.includes("?limit")).toBe(false);
  });

  it("sends time-range bounds as start_after/end_before", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ traces: [] }));
    await client.listTraces({
      limit: 10,
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
    const url = new URL(calls[0]?.url as string);
    expect(url.pathname).toBe("/api/v1/public/traces");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("start_after")).toBe("2024-01-01T00:00:00.000Z");
    expect(url.searchParams.get("end_before")).toBe("2024-02-01T00:00:00.000Z");
  });

  it("omits a bound that is not provided", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ traces: [] }));
    await client.listTraces({ startAfter: "2024-01-01T00:00:00.000Z" });
    const url = new URL(calls[0]?.url as string);
    expect(url.searchParams.get("start_after")).toBe("2024-01-01T00:00:00.000Z");
    expect(url.searchParams.has("end_before")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("url-encodes the trace id for getTrace", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ trace: {} }));
    await client.getTrace("a/b c");
    expect(calls[0]?.url).toContain("a%2Fb%20c");
    expect(calls[0]?.url).not.toContain("a/b c");
  });

  it("url-encodes the trace id for exportTrace", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ export: {} }));
    await client.exportTrace("a/b c");
    expect(calls[0]?.url).toContain("a%2Fb%20c");
    expect(calls[0]?.url).not.toContain("a/b c");
  });

  it("strips trailing slashes from the host", async () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    const client = createApiClient({
      host: "https://h///",
      apiKey: API_KEY,
      fetchImpl: fake.fetchImpl,
    });
    await client.whoami();
    expect(fake.calls[0]?.url).toBe("https://h/api/v1/public/whoami");
  });

  it("maps a non-2xx response to a CliError using the body detail", async () => {
    const { client } = clientWith(() => errorResponse(404, "trace not found"));
    await expect(client.getTrace("x")).rejects.toBeInstanceOf(CliError);
    await expect(client.getTrace("x")).rejects.toThrow(/trace not found/);
  });

  it("maps a non-2xx response without a detail to a status message", async () => {
    const { client } = clientWith(() => new Response("oops", { status: 500 }));
    await expect(client.whoami()).rejects.toThrow(/request failed with status 500/);
  });

  it("maps a network failure to a CliError mentioning the host", async () => {
    const { client } = clientWith(() => {
      throw new Error(`connect ECONNREFUSED to ${API_KEY}`);
    });
    await expect(client.whoami()).rejects.toBeInstanceOf(CliError);
    await expect(client.whoami()).rejects.toThrow(/https:\/\/h/);
  });
});

describe("HTTP status → exit-code class", () => {
  async function exitCodeOf(status: number): Promise<number> {
    const { client } = clientWith(() => errorResponse(status, `status ${status}`));
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    return (err as CliError).exitCode;
  }

  it("maps 401 and 403 to the auth exit code", async () => {
    expect(await exitCodeOf(401)).toBe(ExitCode.auth);
    expect(await exitCodeOf(403)).toBe(ExitCode.auth);
  });

  it("maps 404 to the not-found exit code", async () => {
    expect(await exitCodeOf(404)).toBe(ExitCode.notFound);
  });

  it("maps a 500 to the internal exit code", async () => {
    expect(await exitCodeOf(500)).toBe(ExitCode.internal);
  });

  it("maps a network failure to the network exit code", async () => {
    const { client } = clientWith(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const err = await client.whoami().catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
  });

  it("maps a request timeout to the network exit code", async () => {
    const fetchImpl = (() =>
      Promise.reject(new DOMException("aborted", "TimeoutError"))) as typeof fetch;
    const client = createApiClient({
      host: "https://h",
      apiKey: API_KEY,
      fetchImpl,
      timeoutMs: 10,
    });
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
  });

  it("rejects a bad host at construction with the usage exit code", () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    const err = ((): unknown => {
      try {
        createApiClient({ host: "not a url", apiKey: API_KEY, fetchImpl: fake.fetchImpl });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
  });
});

describe("detector findings", () => {
  it("sends list filters as query params", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ data: [], meta: {} }));
    await client.listFindings({
      limit: 10,
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
      detector: "hallucination",
      traceId: "tr-1",
    });
    const url = new URL(calls[0]?.url as string);
    expect(url.pathname).toBe("/api/v1/public/detectors/findings");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("start_after")).toBe("2024-01-01T00:00:00.000Z");
    expect(url.searchParams.get("end_before")).toBe("2024-02-01T00:00:00.000Z");
    expect(url.searchParams.get("detector")).toBe("hallucination");
    expect(url.searchParams.get("trace_id")).toBe("tr-1");
  });

  it("omits unset list params", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ data: [], meta: {} }));
    await client.listFindings();
    expect(calls[0]?.url).toBe("https://h/api/v1/public/detectors/findings");
  });

  it("url-encodes the finding id for getFinding", async () => {
    const { client, calls } = clientWith(() => jsonResponse({}));
    await client.getFinding("a/b c");
    expect(calls[0]?.url).toBe("https://h/api/v1/public/detectors/findings/a%2Fb%20c");
  });

  it("url-encodes the trace id for getFindingByTrace", async () => {
    const { client, calls } = clientWith(() => jsonResponse({}));
    await client.getFindingByTrace("a/b c");
    expect(calls[0]?.url).toBe("https://h/api/v1/public/detectors/traces/a%2Fb%20c/finding");
  });

  it("findFindingByTrace returns the finding on 200", async () => {
    const { client } = clientWith(() => jsonResponse({ finding_id: "fnd-1" }));
    const finding = await client.findFindingByTrace("tr-1");
    expect(finding?.finding_id).toBe("fnd-1");
  });

  it("findFindingByTrace returns null on a 404 (trace not flagged)", async () => {
    const { client } = clientWith(() => errorResponse(404, "Finding not found"));
    expect(await client.findFindingByTrace("tr-1")).toBeNull();
  });

  it("findFindingByTrace still throws on a non-404 error", async () => {
    const { client } = clientWith(() => errorResponse(500, "Failed to read finding"));
    await expect(client.findFindingByTrace("tr-1")).rejects.toBeInstanceOf(CliError);
  });
});

describe("detectors", () => {
  it("sends list filters as query params", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ data: [], meta: {} }));
    await client.listDetectors({
      limit: 10,
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
    const url = new URL(calls[0]?.url as string);
    expect(url.pathname).toBe("/api/v1/public/detectors");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("start_after")).toBe("2024-01-01T00:00:00.000Z");
    expect(url.searchParams.get("end_before")).toBe("2024-02-01T00:00:00.000Z");
  });

  it("omits unset list params", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ data: [], meta: {} }));
    await client.listDetectors();
    expect(calls[0]?.url).toBe("https://h/api/v1/public/detectors");
  });
});

describe("never leaks the api key", () => {
  it("keeps the key out of a network-failure CliError", async () => {
    const { client } = clientWith(() => {
      throw new Error(`boom ${API_KEY}`);
    });
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.message).not.toContain(API_KEY);
    expect(String(e)).not.toContain(API_KEY);
  });

  it("keeps the key out of a non-2xx CliError", async () => {
    const { client } = clientWith(() => errorResponse(401, "unauthorized"));
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.message).not.toContain(API_KEY);
    expect(String(e)).not.toContain(API_KEY);
  });
});

describe("request timeout", () => {
  it("attaches a per-request AbortSignal when timeoutMs is set", async () => {
    const fake = createFakeFetch(() => jsonResponse({ ok: true }));
    const client = createApiClient({
      host: "https://h",
      apiKey: API_KEY,
      fetchImpl: fake.fetchImpl,
      timeoutMs: 5000,
    });
    await client.whoami();
    expect(fake.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("attaches no AbortSignal when timeoutMs is unset", async () => {
    const fake = createFakeFetch(() => jsonResponse({ ok: true }));
    const client = createApiClient({
      host: "https://h",
      apiKey: API_KEY,
      fetchImpl: fake.fetchImpl,
    });
    await client.whoami();
    expect(fake.calls[0]?.init.signal).toBeUndefined();
  });

  it("surfaces an aborted request as a CliError (so callers can fall back)", async () => {
    const { client } = clientWith(() => {
      // Simulate what an AbortSignal.timeout firing does to fetch.
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
  });

  it("names the timeout and host without leaking the api key on a real abort", async () => {
    // A fetch that never resolves on its own; it only settles when the
    // per-request AbortSignal fires, rejecting with the signal's reason. This
    // exercises AbortSignal.timeout end to end without hanging the test.
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      })) as typeof fetch;
    const client = createApiClient({
      host: "https://h",
      apiKey: API_KEY,
      fetchImpl,
      timeoutMs: 10,
    });
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.message).toMatch(/timed out/);
    expect(e.message).toContain("https://h");
    expect(e.message).not.toContain(API_KEY);
  });

  it("names the timeout when the abort fires while reading the response body", async () => {
    // Headers arrive, then the body stalls until the deadline: the abort fires
    // inside `res.json()`, not the fetch call. It must still be reported as a
    // timeout rather than escaping as a raw DOMException.
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.reject(
            new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          ),
      } as unknown as Response)) as typeof fetch;
    const client = createApiClient({
      host: "https://h",
      apiKey: API_KEY,
      fetchImpl,
      timeoutMs: 10,
    });
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/timed out/);
  });
});
