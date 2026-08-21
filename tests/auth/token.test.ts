import { describe, expect, it } from "vitest";
import { createTokenProvider, decodeJwtClaims } from "../../src/auth/token.js";
import { CliError, ExitCode } from "../../src/output.js";
import { getVersion } from "../../src/version.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";

const SESSION = "sess_secret_LEAK";

function mintResponse(token = "jwt-1", expiresIn = 600) {
  return jsonResponse({ accessToken: token, tokenType: "Bearer", expiresIn });
}

function providerWith(
  responder: Parameters<typeof createFakeFetch>[0],
  opts: { now?: () => number } = {},
) {
  const fake = createFakeFetch(responder);
  const provider = createTokenProvider({
    authHost: "https://ui",
    sessionToken: SESSION,
    fetchImpl: fake.fetchImpl,
    now: opts.now,
  });
  return { provider, calls: fake.calls };
}

describe("createTokenProvider", () => {
  it("mints via POST /api/cli/token with the session bearer and user-agent", async () => {
    const { provider, calls } = providerWith(() => mintResponse());
    const token = await provider.getAccessToken();
    expect(token).toBe("jwt-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ui/api/cli/token");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SESSION}`);
    expect(headers.get("user-agent")).toBe(`traceroot-cli/${getVersion()}`);
  });

  it("caches the JWT across calls until near expiry", async () => {
    let clock = 0;
    const { provider, calls } = providerWith(() => mintResponse(), { now: () => clock });
    await provider.getAccessToken();
    clock += 8 * 60 * 1000; // 8 min: still >1 min from the 10-min expiry
    expect(await provider.getAccessToken()).toBe("jwt-1");
    expect(calls).toHaveLength(1);
  });

  it("re-mints when within a minute of expiry", async () => {
    let clock = 0;
    let minted = 0;
    const { provider, calls } = providerWith(
      () => {
        minted += 1;
        return mintResponse(`jwt-${minted}`);
      },
      { now: () => clock },
    );
    await provider.getAccessToken();
    clock += (600 - 30) * 1000; // 30s before expiry — inside the refresh window
    expect(await provider.getAccessToken()).toBe("jwt-2");
    expect(calls).toHaveLength(2);
  });

  it("maps a 401 to an auth error prompting re-login", async () => {
    const { provider } = providerWith(() => jsonResponse({ error: "invalid" }, 401));
    const err = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.auth);
    expect((err as CliError).message).toContain("traceroot login");
  });

  it("maps a 429 to a retryable rate-limit error", async () => {
    const { provider } = providerWith(() => jsonResponse({ error: "rate limited" }, 429));
    const err = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message.toLowerCase()).toContain("rate");
  });

  it("treats a malformed 200 body as an internal error", async () => {
    const { provider } = providerWith(() => jsonResponse({ nope: true }));
    const err = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.internal);
  });

  it("redacts the session token from network error messages", async () => {
    const { provider } = providerWith(() => {
      throw new Error(`boom ${SESSION} boom`);
    });
    const err = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).not.toContain(SESSION);
    expect((err as CliError).message).toContain("<redacted>");
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
    const provider = createTokenProvider({
      authHost: "https://ui",
      sessionToken: SESSION,
      fetchImpl: fake.fetchImpl,
      timeoutMs: 30_000,
    });
    const err = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.network);
    expect((err as CliError).message).toContain("timed out");
    expect((err as CliError).message).not.toContain("unreadable");
  });

  it("maps a 403 from mint to an auth error prompting re-login", async () => {
    const { provider } = providerWith(() => jsonResponse({ error: "no access" }, 403));
    const err = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.auth);
    expect((err as CliError).message).toContain("traceroot login");
  });

  it("treats a JSON null body as malformed instead of throwing a TypeError", async () => {
    const { provider } = providerWith(() => jsonResponse(null));
    const err = await provider.getAccessToken().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.internal);
    expect((err as CliError).message).toContain("malformed");
  });

  it("caches with the default TTL when expiresIn is missing (no re-mint every call)", async () => {
    let clock = 0;
    let minted = 0;
    const { provider, calls } = providerWith(
      () => {
        minted += 1;
        return jsonResponse({ accessToken: `jwt-${minted}`, tokenType: "Bearer" });
      },
      { now: () => clock },
    );
    await provider.getAccessToken();
    clock += 5 * 60 * 1000; // 5 min later: well within the default 600s TTL
    expect(await provider.getAccessToken()).toBe("jwt-1");
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-finite expiresIn and uses the default TTL (not a forever cache)", async () => {
    let clock = 0;
    let minted = 0;
    const { provider, calls } = providerWith(
      () => {
        minted += 1;
        return jsonResponse({
          accessToken: `jwt-${minted}`,
          tokenType: "Bearer",
          expiresIn: Number.POSITIVE_INFINITY,
        });
      },
      { now: () => clock },
    );
    await provider.getAccessToken();
    // Past the default 600s TTL: a forever-cache would still return jwt-1.
    clock += 20 * 60 * 1000;
    expect(await provider.getAccessToken()).toBe("jwt-2");
    expect(calls).toHaveLength(2);
  });

  it("collapses concurrent first-mint calls into a single request", async () => {
    let minted = 0;
    const { provider, calls } = providerWith(async () => {
      minted += 1;
      // Resolve on a later microtask so the second caller arrives mid-flight.
      await Promise.resolve();
      return mintResponse(`jwt-${minted}`);
    });
    const [a, b, c] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect([a, b, c]).toEqual(["jwt-1", "jwt-1", "jwt-1"]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-http(s) auth host at construction", () => {
    expect(() => createTokenProvider({ authHost: "not a url", sessionToken: SESSION })).toThrow(
      CliError,
    );
  });
});

describe("decodeJwtClaims", () => {
  it("extracts claims from an unverified JWT payload", () => {
    const payload = Buffer.from(JSON.stringify({ email: "a@b.c", sub: "u-1" })).toString(
      "base64url",
    );
    expect(decodeJwtClaims(`h.${payload}.sig`)).toEqual({ email: "a@b.c", sub: "u-1" });
  });

  it("returns null for garbage", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
    expect(decodeJwtClaims("a.!!!.c")).toBeNull();
  });
});
