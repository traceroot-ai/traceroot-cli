import { spawn } from "node:child_process";
import { CliError, ExitCode, type Writers, logInfo } from "../output.js";
import { getVersion } from "../version.js";

/** The allowlisted OAuth client id for this CLI (server-side allowlist). */
export const DEVICE_CLIENT_ID = "traceroot-cli";

/** Fallback poll interval (seconds) when the server does not send one. */
const DEFAULT_INTERVAL_S = 5;

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
      if (deps.timeoutMs !== undefined && err instanceof Error && err.name === "TimeoutError") {
        throw new CliError(
          `request to ${base} timed out after ${deps.timeoutMs / 1000}s`,
          ExitCode.network,
        );
      }
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

  // ---- Step 1: obtain a device + user code pair. -----------------------------
  const codeRes = await post("/api/auth/device/code", { client_id: DEVICE_CLIENT_ID });
  if (!codeRes.ok) {
    throw new CliError(
      `could not start device login (status ${codeRes.status}): ${await errorHint(codeRes)}`,
      ExitCode.auth,
    );
  }
  const code = (await codeRes.json().catch(() => ({}))) as DeviceCodeBody;
  const deviceCode = asString(code.device_code);
  const userCode = asString(code.user_code);
  const verifyUrl =
    asString(code.verification_uri_complete) ??
    (asString(code.verification_uri)
      ? `${asString(code.verification_uri)}?user_code=${encodeURIComponent(userCode ?? "")}`
      : undefined);
  if (deviceCode === undefined || userCode === undefined || verifyUrl === undefined) {
    throw new CliError("device login returned an incomplete response", ExitCode.internal);
  }
  const expiresInS = typeof code.expires_in === "number" ? code.expires_in : 30 * 60;
  let intervalS = typeof code.interval === "number" ? code.interval : DEFAULT_INTERVAL_S;

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
  while (true) {
    if (now() >= deadline) {
      throw new CliError(
        "device login expired before approval — run `traceroot login` again",
        ExitCode.auth,
      );
    }
    await sleep(intervalS * 1000);

    const res = await post("/api/auth/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: DEVICE_CLIENT_ID,
    });
    const body = (await res.json().catch(() => ({}))) as TokenPollBody;

    if (res.ok) {
      const sessionToken = asString(body.access_token);
      if (sessionToken === undefined) {
        throw new CliError("device login returned no session token", ExitCode.internal);
      }
      return { sessionToken };
    }

    const error = asString(body.error);
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalS += 5;
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
      ExitCode.auth,
    );
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Best-effort `error`/`error_description` extraction for a failure message. */
async function errorHint(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return asString(body.error_description) ?? asString(body.error) ?? "unexpected response";
  } catch {
    return "unexpected response";
  }
}

/**
 * Opens `url` with the platform opener, detached so the CLI's poll loop never
 * waits on the browser. Resolves `false` when the spawn fails synchronously.
 */
async function openBrowserForPlatform(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
