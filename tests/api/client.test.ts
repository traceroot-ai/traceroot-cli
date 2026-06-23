import { describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/output.js";
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
