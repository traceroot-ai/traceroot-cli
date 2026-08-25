import { REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "../../src/output.js";
import { executeTool } from "../../src/registry/execute.js";
import { createFakeFetch, errorResponse, jsonResponse } from "../helpers/fakeFetch.js";

const listSessions = REGISTRY.find((entry) => entry.name === "list_sessions");
const getSession = REGISTRY.find((entry) => entry.name === "get_session");
if (listSessions === undefined || getSession === undefined)
  throw new Error("registry fixture missing");

function transport(fetchImpl: typeof fetch) {
  return { base: "https://api.test", apiKey: "sk-secret", timeoutMs: 30_000, fetchImpl };
}

describe("executeTool", () => {
  it("sends the bearer and accept headers and builds the query from schema args", async () => {
    const fake = createFakeFetch(() => jsonResponse({ data: [] }));
    await executeTool(listSessions, { limit: 5, search_query: "abc" }, transport(fake.fetchImpl));
    const call = fake.calls[0];
    expect(call.url).toBe("https://api.test/api/v1/public/sessions?limit=5&search_query=abc");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret");
    expect(headers.accept).toBe("application/json");
  });

  it("URI-encodes path params", async () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    await executeTool(getSession, { session_id: "a/b c" }, transport(fake.fetchImpl));
    expect(fake.calls[0].url).toBe("https://api.test/api/v1/public/sessions/a%2Fb%20c");
  });

  it.each([
    [401, ExitCode.auth],
    [403, ExitCode.auth],
    [404, ExitCode.notFound],
    [500, ExitCode.internal],
  ])("maps HTTP %i to exit code %i with the server detail", async (status, exitCode) => {
    const fake = createFakeFetch(() => errorResponse(status, "nope"));
    const err = await executeTool(listSessions, {}, transport(fake.fetchImpl)).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(exitCode);
    expect((err as CliError).message).toBe("nope");
  });

  it("falls back to the generic message when the error body is empty", async () => {
    // ApiError.detail keeps the raw body text for non-JSON or detail-less bodies, so the
    // generic fallback only fires on an empty body (accepted divergence — see spec).
    const emptyBodyFetch = (() =>
      Promise.resolve(new Response("", { status: 500 }))) as typeof fetch;
    const err = await executeTool(listSessions, {}, transport(emptyBodyFetch)).catch((e) => e);
    expect((err as CliError).message).toBe("request failed with status 500");
    expect((err as CliError).exitCode).toBe(ExitCode.internal);
  });

  it("translates a timeout into the network exit class with the host-named message", async () => {
    const timeoutFetch = (() =>
      Promise.reject(
        Object.assign(new Error("aborted"), { name: "TimeoutError" }),
      )) as typeof fetch;
    const err = await executeTool(listSessions, {}, transport(timeoutFetch)).catch((e) => e);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message).toBe("request to https://api.test timed out after 30s");
  });

  it("never leaks the api key in transport failures", async () => {
    const failingFetch = (() =>
      Promise.reject(new Error("connect failed for key sk-secret"))) as typeof fetch;
    const err = await executeTool(listSessions, {}, transport(failingFetch)).catch((e) => e);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message).toBe(
      "request to https://api.test failed: connect failed for key <redacted>",
    );
    expect((err as CliError).message).not.toContain("sk-secret");
  });

  function erroringBody(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      pull(controller) {
        controller.error(new Error("body stream reset"));
      },
    });
  }

  it("keeps the status class when an HTTP error's body fails to stream", async () => {
    // Without body buffering, the read failure would escape as a plain fetch
    // error and demote a 401 to a retryable network failure (exit 5).
    const brokenBodyFetch = (() =>
      Promise.resolve(new Response(erroringBody(), { status: 401 }))) as typeof fetch;
    const err = await executeTool(listSessions, {}, transport(brokenBodyFetch)).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.auth);
    expect((err as CliError).message).toBe("request failed with status 401");
  });

  it("classifies a malformed JSON body on a 2xx as internal, not network", async () => {
    const badJsonFetch = (() =>
      Promise.resolve(new Response("definitely-not-json", { status: 200 }))) as typeof fetch;
    const err = await executeTool(listSessions, {}, transport(badJsonFetch)).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.internal);
    expect((err as CliError).message).toBe("request to https://api.test returned invalid JSON");
  });

  it("still fails as a transport error when a SUCCESS body fails to stream", async () => {
    const brokenBodyFetch = (() =>
      Promise.resolve(new Response(erroringBody(), { status: 200 }))) as typeof fetch;
    const err = await executeTool(listSessions, {}, transport(brokenBodyFetch)).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message).toContain("request to https://api.test failed:");
  });
});
