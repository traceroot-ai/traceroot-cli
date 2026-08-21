import { spawn } from "node:child_process";
import { CliError, ExitCode, type Writers, logInfo } from "../output.js";
import { getVersion } from "../version.js";

/** The allowlisted OAuth client id for this CLI (server-side allowlist). */
export const DEVICE_CLIENT_ID = "traceroot-cli";

/** Fallback poll interval (seconds) when the server does not send one. */
const DEFAULT_INTERVAL_S = 5;

/** Upper bound on the backed-off poll interval (seconds), so repeated
 * `slow_down`/429 responses can't stretch the wait past the approval window. */
const MAX_INTERVAL_S = 20;

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
  const base = deps.authHost.replace(/\/+$/, "");
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
   * any non-object body (a `null`, an array, a parse failure) to an empty object
   * — so callers read fields off a real object and never hit a raw TypeError. */
  async function readBody<T>(res: Response): Promise<T> {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throwIfTimeout(err);
      return {} as T;
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
  const expiresInS = positiveNumber(code.expires_in) ?? 30 * 60;
  // A zero/negative/non-finite interval would otherwise busy-poll the token
  // endpoint; fall back to the default.
  let intervalS = positiveNumber(code.interval) ?? DEFAULT_INTERVAL_S;

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
    await sleep(intervalS * 1000);
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
      intervalS = Math.min(intervalS + 5, MAX_INTERVAL_S);
      continue;
    }

    const error = asString(body.error);
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalS = Math.min(intervalS + 5, MAX_INTERVAL_S);
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
    throw new CliError(
      `device login failed (status ${res.status})${error !== undefined ? `: ${error}` : ""}`,
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
