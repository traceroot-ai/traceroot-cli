import { describe, expect, it } from "vitest";
import { redeemHandoff } from "../../src/auth/handoff.js";
import { CliError, ExitCode } from "../../src/output.js";
import { getVersion } from "../../src/version.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";

/** Shaped like the real thing: `trh_` + 43 base64url characters. */
const CODE = `trh_${"A".repeat(43)}`;

function redeemWith(
  responder: Parameters<typeof createFakeFetch>[0],
  opts: { authHost?: string; timeoutMs?: number } = {},
) {
  const fake = createFakeFetch(responder);
  return {
    calls: fake.calls,
    run: () =>
      redeemHandoff({
        authHost: opts.authHost ?? "https://ui",
        code: CODE,
        fetchImpl: fake.fetchImpl,
        timeoutMs: opts.timeoutMs,
      }),
  };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (e: unknown) => e,
  );
}

describe("redeemHandoff", () => {
  it("POSTs the code to /api/cli/handoff/redeem with no authorization header", async () => {
    const { run, calls } = redeemWith(() =>
      jsonResponse({ sessionToken: "sess-1", email: "bob@new.example", expiresIn: 604_800 }),
    );
    const outcome = await run();

    expect(outcome).toEqual({
      kind: "redeemed",
      credential: { sessionToken: "sess-1", email: "bob@new.example" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ui/api/cli/handoff/redeem");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: CODE });
    const headers = new Headers(calls[0]?.init.headers);
    // The route is deliberately unauthenticated — the caller has no credential
    // yet, which is the whole point of the handoff.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("user-agent")).toBe(`traceroot-cli/${getVersion()}`);
  });

  it("normalises a trailing slash on the auth host rather than doubling it", async () => {
    const { run, calls } = redeemWith(() => jsonResponse({ sessionToken: "sess-1" }), {
      authHost: "https://ui/",
    });
    await run();
    expect(calls[0]?.url).toBe("https://ui/api/cli/handoff/redeem");
  });

  it("tolerates a response with no email", async () => {
    const { run } = redeemWith(() => jsonResponse({ sessionToken: "sess-1" }));
    expect(await run()).toEqual({ kind: "redeemed", credential: { sessionToken: "sess-1" } });
  });

  it("returns a recoverable rejection on 401 instead of throwing an auth error", async () => {
    // Unknown, expired and already-redeemed are one indistinguishable answer by
    // design. A *value* is what lets the caller fall back to the device flow.
    const { run } = redeemWith(() => jsonResponse({ error: "invalid" }, 401));
    expect(await run()).toEqual({ kind: "rejected" });
  });

  it("returns a recoverable rejection on 403 as well", async () => {
    const { run } = redeemWith(() => jsonResponse({ error: "forbidden" }, 403));
    expect(await run()).toEqual({ kind: "rejected" });
  });

  it("maps 429 to a network error, not a rejected code", async () => {
    const err = await caught(redeemWith(() => jsonResponse({ error: "slow down" }, 429)).run);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message.toLowerCase()).toContain("rate limited");
  });

  it("maps a 5xx to a network error, not a rejected code", async () => {
    const err = await caught(redeemWith(() => jsonResponse({ error: "boom" }, 503)).run);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message).toContain("503");
  });

  it("maps a 404 to notFound, naming the deployment that has no such route", async () => {
    const err = await caught(redeemWith(() => jsonResponse({}, 404)).run);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.notFound);
    expect((err as CliError).message).toContain("https://ui");
  });

  it("maps a transport failure to a network error", async () => {
    const err = await caught(
      redeemWith(() => {
        throw new Error("fetch failed");
      }).run,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
  });

  it("reports a timeout as a network timeout", async () => {
    const err = await caught(
      redeemWith(
        () => {
          throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        },
        { timeoutMs: 30_000 },
      ).run,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message).toContain("timed out");
  });

  it("reports a body-phase timeout as a network timeout, not an unreadable response", async () => {
    const fake = createFakeFetch(
      () =>
        ({
          status: 200,
          ok: true,
          json: () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
        }) as unknown as Response,
    );
    const err = await caught(() =>
      redeemHandoff({
        authHost: "https://ui",
        code: CODE,
        fetchImpl: fake.fetchImpl,
        timeoutMs: 30_000,
      }),
    );
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message).not.toContain("unreadable");
  });

  it("treats a 200 with no session token as an internal error", async () => {
    const err = await caught(redeemWith(() => jsonResponse({ email: "bob@new.example" })).run);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.internal);
  });

  it("treats a JSON null body as malformed instead of throwing a TypeError", async () => {
    const err = await caught(redeemWith(() => jsonResponse(null)).run);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain("malformed");
  });

  it("rejects a malformed auth host as a usage error", async () => {
    const err = await caught(() => redeemHandoff({ authHost: "not a url", code: CODE }));
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
  });

  it("rejects an empty code as a usage error before any request", async () => {
    const fake = createFakeFetch(() => jsonResponse({ sessionToken: "sess-1" }));
    const err = await caught(() =>
      redeemHandoff({ authHost: "https://ui", code: "   ", fetchImpl: fake.fetchImpl }),
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect(fake.calls).toHaveLength(0);
  });

  it("redacts the code from a transport error message", async () => {
    // A runtime error can quote the request it failed on, and this request's
    // body IS the credential.
    const err = await caught(
      redeemWith(() => {
        throw new Error(`connect ECONNREFUSED while sending {"code":"${CODE}"}`);
      }).run,
    );
    expect((err as CliError).message).not.toContain(CODE);
    expect((err as CliError).message).toContain("<redacted>");
  });

  it("never names the code in any error it raises, whatever the server does", async () => {
    // One assertion over every failure the route can produce, so a future
    // branch that interpolates the code has somewhere to fail.
    const statuses = [400, 404, 429, 500, 503];
    for (const status of statuses) {
      const err = await caught(redeemWith(() => jsonResponse({ detail: CODE }, status)).run);
      expect(err, `status ${status} raises a CliError`).toBeInstanceOf(CliError);
      expect((err as CliError).message, `status ${status} message`).not.toContain(CODE);
    }
    const malformed = await caught(redeemWith(() => jsonResponse({ nope: CODE })).run);
    expect((malformed as CliError).message).not.toContain(CODE);
  });
});
