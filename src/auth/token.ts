import { CliError, ExitCode } from "../output.js";
import { getVersion } from "../version.js";

/**
 * Refresh this long before the advertised expiry. The mint route returns
 * `expiresIn` (600s) as advisory; refreshing a minute early keeps a request
 * from going out with a JWT that expires mid-flight.
 */
const REFRESH_WINDOW_MS = 60_000;

/** Documented mint TTL, used when a response omits a positive `expiresIn`. */
const DEFAULT_EXPIRES_S = 600;

export interface TokenProviderOptions {
  /** The host that issued the session (the Next.js app) — mint calls go here. */
  authHost: string;
  /** The stored long-lived session token (refresh credential). Never sent on reads. */
  sessionToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** Optional per-request timeout in milliseconds for the mint call. */
  timeoutMs?: number;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface TokenProvider {
  /**
   * A currently-valid access JWT, minting or transparently refreshing as
   * needed. Everything that calls the API under user auth gets its bearer from
   * here — never the raw session token.
   */
  getAccessToken(): Promise<string>;
  /** Drops the cached token so the next {@link getAccessToken} re-mints. */
  invalidate(): void;
}

/** Shape of a successful mint response from `POST /api/cli/token`. */
interface MintBody {
  accessToken?: unknown;
  expiresIn?: unknown;
}

/**
 * Creates the access-token provider for a stored session token: exchanges it at
 * `POST {authHost}/api/cli/token` for a short-lived (10-min) EdDSA JWT, caches
 * the JWT in memory, and re-mints when within a minute of expiry. A 401 from
 * mint means the session was revoked or expired — surfaced as an auth error
 * prompting `traceroot login`.
 */
export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const base = opts.authHost.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new CliError(`invalid auth host URL: ${base}`, ExitCode.usage);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(
      `unsupported auth host scheme: ${parsed.protocol} (expected http or https)`,
      ExitCode.usage,
    );
  }

  let cached: { jwt: string; expiresAtMs: number } | null = null;

  async function mint(): Promise<string> {
    const url = `${base}/api/cli/token`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.sessionToken}`,
        accept: "application/json",
        "user-agent": `traceroot-cli/${getVersion()}`,
      },
    };
    if (opts.timeoutMs !== undefined) {
      init.signal = AbortSignal.timeout(opts.timeoutMs);
    }

    // The timeout deadline covers the whole request, so it can fire while
    // connecting, reading headers, or streaming the body. Translate that one
    // cause into a network-class timeout wherever it surfaces.
    const throwIfTimeout = (err: unknown): void => {
      if (opts.timeoutMs !== undefined && err instanceof Error && err.name === "TimeoutError") {
        throw new CliError(
          `request to ${base} timed out after ${opts.timeoutMs / 1000}s`,
          ExitCode.network,
        );
      }
    };

    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      throwIfTimeout(err);
      // Never echo the session token: redact it from whatever the runtime says.
      const message = err instanceof Error ? err.message : String(err);
      const safe = message.split(opts.sessionToken).join("<redacted>");
      throw new CliError(`request to ${base} failed: ${safe}`, ExitCode.network);
    }

    // 401 (revoked/expired) and 403 (no access) both mean the session can no
    // longer authenticate — re-login, per the CLI's auth exit-code class.
    if (res.status === 401 || res.status === 403) {
      throw new CliError(
        "session expired or revoked — run `traceroot login` to sign in again",
        ExitCode.auth,
      );
    }
    if (res.status === 429) {
      throw new CliError("token mint rate limited — wait a moment and try again", ExitCode.network);
    }
    if (!res.ok) {
      throw new CliError(`token mint failed with status ${res.status}`, ExitCode.internal);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      // A stall streaming the body is a network timeout, not a malformed
      // response — match client.ts so the exit-code contract stays honest.
      throwIfTimeout(err);
      throw new CliError("token mint returned an unreadable response", ExitCode.internal);
    }
    // A JSON `null` or a non-object body is malformed — read fields only off a
    // real object so it never throws a raw TypeError.
    if (typeof parsed !== "object" || parsed === null) {
      throw new CliError("token mint returned a malformed response", ExitCode.internal);
    }
    const body = parsed as MintBody;
    if (typeof body.accessToken !== "string" || body.accessToken === "") {
      throw new CliError("token mint returned no access token", ExitCode.internal);
    }
    // `expiresIn` is advisory; fall back to the documented default rather than
    // collapsing the cache to zero lifetime (which would re-mint every request).
    const expiresIn =
      typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn : DEFAULT_EXPIRES_S;
    cached = { jwt: body.accessToken, expiresAtMs: now() + expiresIn * 1000 };
    return body.accessToken;
  }

  // Collapses concurrent mints: the first caller starts the exchange and every
  // caller awaiting before it resolves shares that one request, so a burst of
  // parallel reads costs one mint, not N against the shared rate-limit bucket.
  let inflight: Promise<string> | null = null;

  return {
    async getAccessToken() {
      if (cached !== null && now() < cached.expiresAtMs - REFRESH_WINDOW_MS) {
        return cached.jwt;
      }
      if (inflight === null) {
        inflight = mint().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}

/**
 * Decodes a JWT's payload WITHOUT verifying its signature — display-only
 * identity (e.g. the `email` claim for `status`), never an auth decision.
 * Returns `null` for anything that doesn't parse as a JWT.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts[1] === undefined) {
    return null;
  }
  // Reject payloads that are not base64url before decoding: Buffer silently
  // skips invalid characters, which would turn garbage into garbage JSON.
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(parts[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
