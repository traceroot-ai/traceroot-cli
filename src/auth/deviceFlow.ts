import { spawn } from "node:child_process";
import { normalizeBaseUrl } from "../api/client.js";
import { CliError, ExitCode, type Writers, logInfo } from "../output.js";
import { getVersion } from "../version.js";

/** The allowlisted OAuth client id for this CLI (server-side allowlist). */
export const DEVICE_CLIENT_ID = "traceroot-cli";

/** Fallback poll interval (seconds) when the server does not send one. */
const DEFAULT_INTERVAL_S = 5;

/** Upper bound on the backed-off poll interval (seconds), so repeated
 * `slow_down`/429 responses can't stretch the wait past the approval window. */
const MAX_INTERVAL_S = 20;

/** Upper bound on the server-sent initial interval (seconds). Anything larger
 * is nonsense for a 30-minute approval window — and an oversized value would
 * overflow `setTimeout`'s 32-bit delay, which Node clamps to ~1ms, turning the
 * polite poll into a busy-loop hammering the token endpoint. */
const MAX_SERVER_INTERVAL_S = 900;

/** Upper bound on the server-sent approval window (seconds). The server's real
 * window is 30 minutes; a wildly larger value must not leave the local
 * deadline effectively unbounded. */
const MAX_EXPIRES_S = 24 * 60 * 60;

/**
 * The next interval after a `slow_down`/429: +5s, capped at
 * {@link MAX_INTERVAL_S} for ordinary intervals, and never below the current
 * interval — a server that asked for a long interval up front must not see its
 * backoff response shrink the wait, but still gets one honored +5s step.
 */
function backedOff(intervalS: number, initialIntervalS: number): number {
  // Honor the backoff request even above the small-interval cap: one +5s step
  // past the server's own initial interval, never past the global maximum, and
  // never a decrease.
  const cap = Math.min(Math.max(MAX_INTERVAL_S, initialIntervalS + 5), MAX_SERVER_INTERVAL_S);
  return Math.max(intervalS, Math.min(intervalS + 5, cap));
}

export interface DeviceFlowDeps {
  /** The host that runs the device-authorization endpoints (the Next.js app). */
  authHost: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** Optional per-request timeout in milliseconds (each poll is one request). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real timer sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Opens `url` in a browser; resolving `false` or rejecting means it couldn't.
   * Always non-fatal — the URL is printed regardless (SSH sessions).
   */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Environment for CI detection; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  writers: Writers;
}

export interface DeviceFlowResult {
  /** The long-lived session token — the credential to store. */
  sessionToken: string;
}

interface DeviceCodeBody {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

interface TokenPollBody {
  access_token?: unknown;
  error?: unknown;
}

/**
 * Runs the RFC 8628 device-authorization flow against `authHost`: requests a
 * code, shows the user code + verification URL (and tries to open a browser),
 * then polls for approval honoring the server interval and `slow_down`.
 * Boundary: host in, session token out — composable by the future `setup`
 * wizard as well as `login`.
 */
export async function runDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceFlowResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const openBrowser = deps.openBrowser ?? openBrowserForPlatform;
  const env = deps.env ?? process.env;
  // Same validation as the API client: reject malformed/non-http(s) hosts up
  // front (usage error) instead of handing fetch a garbage URL that surfaces
  // as a confusing network failure.
  const base = normalizeBaseUrl(deps.authHost);
  const { writers } = deps;

  // A timeout covers the whole request, so it can fire while connecting, reading
  // headers, or streaming the body — translate that one cause everywhere.
  const throwIfTimeout = (err: unknown): void => {
    if (deps.timeoutMs !== undefined && err instanceof Error && err.name === "TimeoutError") {
      throw new CliError(
        `request to ${base} timed out after ${deps.timeoutMs / 1000}s`,
        ExitCode.network,
      );
    }
  };

  async function post(path: string, body: Record<string, string>): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": `traceroot-cli/${getVersion()}`,
      },
      body: JSON.stringify(body),
    };
    if (deps.timeoutMs !== undefined) {
      init.signal = AbortSignal.timeout(deps.timeoutMs);
    }
    try {
      return await fetchImpl(`${base}${path}`, init);
    } catch (err) {
      throwIfTimeout(err);
      // A runtime error could echo request contents, and the poll body carries
      // the device_code (pre-approval, that plus the public client_id is enough
      // to claim the session) — redact every body value, matching the bearer
      // redaction in token.ts / client.ts.
      let message = err instanceof Error ? err.message : String(err);
      for (const value of Object.values(body)) {
        message = message.split(value).join("<redacted>");
      }
      throw new CliError(`request to ${base} failed: ${message}`, ExitCode.network);
    }
  }

  /** Reads a JSON body, mapping a body-phase timeout to the network timeout and
   * any non-object body (a `null`, an array, malformed JSON) to an empty object
   * — so callers read fields off a real object and never hit a raw TypeError.
   * A transport failure while STREAMING a SUCCESS body is different: that is a
   * retryable network fault, not a malformed server response. On an error
   * response it still degrades to `{}` so the status classification survives
   * (mirroring the registry executor's buffered-body contract). */
  async function readBody<T>(res: Response): Promise<T> {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throwIfTimeout(err);
      if (err instanceof SyntaxError || !res.ok) {
        return {} as T;
      }
      throw new CliError(`request to ${base} failed while reading the response`, ExitCode.network);
    }
    return (typeof parsed === "object" && parsed !== null ? parsed : {}) as T;
  }

  // ---- Step 1: obtain a device + user code pair. -----------------------------
  const codeRes = await post("/api/auth/device/code", { client_id: DEVICE_CLIENT_ID });
  if (!codeRes.ok) {
    // Read the error body through readBody so a body-phase timeout on the error
    // response stays a network error rather than being reported as an auth
    // failure. A 5xx/429 is a server/rate-limit failure, not an auth rejection.
    const errBody = await readBody<Record<string, unknown>>(codeRes);
    const hint =
      asString(errBody.error_description) ?? asString(errBody.error) ?? "unexpected response";
    throw new CliError(
      `could not start device login (status ${codeRes.status}): ${hint}`,
      codeRes.status >= 500 || codeRes.status === 429 ? ExitCode.network : ExitCode.auth,
    );
  }
  const code = await readBody<DeviceCodeBody>(codeRes);
  const deviceCode = asString(code.device_code);
  const userCode = asString(code.user_code);
  const verifyUrl =
    asString(code.verification_uri_complete) ?? withUserCode(code.verification_uri, userCode);
  if (deviceCode === undefined || userCode === undefined || verifyUrl === undefined) {
    throw new CliError("device login returned an incomplete response", ExitCode.internal);
  }
  // The verification URL is server-supplied and gets both printed and handed to
  // the OS browser opener, so reject anything that is not plain http(s) before
  // either happens: a file:/javascript:/custom-scheme URL (a compromised or
  // MITM'd auth host) must never be opened, and the http(s) gate plus the
  // shell-free opener below close the classic browser-opener injection.
  if (!isHttpUrl(verifyUrl)) {
    throw new CliError("device login returned an invalid verification URL", ExitCode.auth);
  }
  // Cap the approval window: an absurdly large expires_in would push the local
  // deadline effectively to "never", leaving the poll loop bounded only by the
  // server's own expiry response.
  const expiresInS = Math.min(positiveNumber(code.expires_in) ?? 30 * 60, MAX_EXPIRES_S);
  // Bound the poll interval on both sides: a zero/negative/non-finite value
  // falls back to the default, a sub-second one is raised to 1s (no hammering
  // the token endpoint with millisecond sleeps), and an absurdly large one is
  // clamped so it can't overflow setTimeout into a ~1ms busy-loop.
  const initialIntervalS = Math.min(
    Math.max(positiveNumber(code.interval) ?? DEFAULT_INTERVAL_S, 1),
    MAX_SERVER_INTERVAL_S,
  );
  let intervalS = initialIntervalS;

  // ---- Step 2: show instructions; the browser open is best-effort. -----------
  if (env.CI === "true") {
    // A device login in CI is almost always a misplaced credential choice —
    // sessions identify a person. Keyed on CI detection, NOT TTY absence:
    // agents driving the CLI over pipes are attended and must not be nagged.
    logInfo(
      "Running in CI — prefer a project API key (set TRACEROOT_API_KEY) over a personal login.",
      writers,
    );
  }
  logInfo(`Confirm this code in your browser: ${userCode}`, writers);
  logInfo(`Open ${verifyUrl}`, writers);
  try {
    await openBrowser(verifyUrl);
  } catch {
    // Non-fatal: the URL is already printed.
  }
  logInfo("Waiting for approval…", writers);

  // ---- Step 3: poll until approved, denied, or expired. ----------------------
  const deadline = now() + expiresInS * 1000;
  const expired = new CliError(
    "device login expired before approval — run `traceroot login` again",
    ExitCode.auth,
  );
  while (true) {
    // Sleep no longer than the time left in the window: a poll interval longer
    // than expires_in must fail at expiry, not interval-many seconds later.
    await sleep(Math.min(intervalS * 1000, Math.max(deadline - now(), 0)));
    // Re-check AFTER sleeping: an interval that steps past the deadline must not
    // send one more poll that could accept a token after expiry.
    if (now() >= deadline) {
      throw expired;
    }

    const res = await post("/api/auth/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: DEVICE_CLIENT_ID,
    });
    const body = await readBody<TokenPollBody>(res);

    if (res.ok) {
      const sessionToken = asString(body.access_token);
      if (sessionToken === undefined) {
        throw new CliError("device login returned no session token", ExitCode.internal);
      }
      return { sessionToken };
    }

    // A bare HTTP 429 (the endpoint's rate limiter) carries no `error` field —
    // back off and keep polling rather than treating it as a fatal failure.
    if (res.status === 429) {
      intervalS = backedOff(intervalS, initialIntervalS);
      continue;
    }

    const error = asString(body.error);
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalS = backedOff(intervalS, initialIntervalS);
      continue;
    }
    if (error === "access_denied") {
      throw new CliError("login denied in the browser", ExitCode.auth);
    }
    if (error === "expired_token") {
      throw new CliError(
        "device login expired before approval — run `traceroot login` again",
        ExitCode.auth,
      );
    }
    // The error text is server-provided; if it echoes the device_code back
    // (pre-approval it is enough to claim the session), redact it.
    const safeError = error?.split(deviceCode).join("<redacted>");
    throw new CliError(
      `device login failed (status ${res.status})${safeError !== undefined ? `: ${safeError}` : ""}`,
      res.status >= 500 ? ExitCode.network : ExitCode.auth,
    );
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A finite, strictly-positive number, or undefined for anything else. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Adds `user_code` to a verification URI via URL parsing, so a URI that already
 * carries a query or fragment gets the parameter set correctly (naive `?=`
 * concatenation would corrupt it). Returns undefined for an unusable input.
 */
function withUserCode(uri: unknown, userCode: string | undefined): string | undefined {
  const base = asString(uri);
  if (base === undefined || userCode === undefined) {
    return undefined;
  }
  try {
    const u = new URL(base);
    u.searchParams.set("user_code", userCode);
    return u.href;
  } catch {
    return undefined;
  }
}

/** True only for a parseable http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The opener command + argv for a platform. On Windows this deliberately avoids
 * `cmd /c start`: cmd.exe re-parses its command line and treats `& | ^ < >` as
 * shell metacharacters, which a hostile verification URL could exploit for
 * command injection. `rundll32 url.dll,FileProtocolHandler <url>` receives the
 * URL as one non-shell argument, so nothing re-interprets it. Exported for
 * tests; the URL is already validated as http(s) by the caller.
 */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") {
    return ["open", [url]];
  }
  if (platform === "win32") {
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}

/**
 * Opens `url` with the platform opener, detached so the CLI's poll loop never
 * waits on the browser. Resolves `false` when the spawn fails synchronously.
 */
async function openBrowserForPlatform(url: string): Promise<boolean> {
  const [cmd, args] = browserOpenCommand(process.platform, url);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
