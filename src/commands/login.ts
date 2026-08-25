import { createInterface } from "node:readline";
import type { Command } from "commander";
import {
  type ApiClient,
  type ApiClientOptions,
  type Whoami,
  type WorkspaceList,
  createApiClient,
} from "../api/client.js";
import { type CredentialEntry, readCredential, writeCredential } from "../auth/credentials.js";
import { type DeviceFlowDeps, type DeviceFlowResult, runDeviceFlow } from "../auth/deviceFlow.js";
import { createTokenProvider, decodeJwtClaims } from "../auth/token.js";
import { loadConfigOrThrow, writeConfig as realWriteConfig } from "../config/manager.js";
import type { AuthSource, ResolvedCredential } from "../config/resolve.js";
import type { Config } from "../config/schema.js";
import { CliError, ExitCode, type Writers, defaultWriters, logInfo, writeJson } from "../output.js";
import { apiKeyLabel, identity } from "../render/identity.js";
import { createStyler } from "../render/style.js";
import { DEFAULT_HOST } from "./constants.js";
import { contextFromCommand } from "./shared.js";

/** Dependencies for {@link runLogin}; production wiring lives in {@link registerLogin}. */
export interface LoginDeps {
  /** The credential resolved from the full precedence chain (may be `none`). */
  credential: ResolvedCredential;
  /** The host resolved from the same precedence chain, if any. */
  resolvedHost?: string;
  /** Provenance of the resolved host. An explicit override (`flag`/`env`/
   * `env-file`) signals intent to change the host and bypasses the
   * already-logged-in warning even when the credential is persisted. */
  hostSource: AuthSource;
  /** The device/mint host (auth-host resolution result); defaults to the host. */
  authHost?: string;
  json: boolean;
  isInteractive: boolean;
  /** Prompts for a yes/no answer; resolves `false` on empty input or EOF. */
  promptConfirm: (question: string) => Promise<boolean>;
  createClient: (opts: ApiClientOptions) => ApiClient;
  readConfig: () => Config | null;
  writeConfig: (config: Config) => void;
  /** Session-store accessors, keyed by API host. */
  readCredentialEntry: (host: string) => CredentialEntry | null;
  writeCredentialEntry: (host: string, entry: CredentialEntry) => void;
  /** The RFC 8628 flow; injectable for tests. */
  deviceFlow: (deps: DeviceFlowDeps) => Promise<DeviceFlowResult>;
  /** Mints an access JWT from a fresh session token (identity display). */
  mintAccessToken: (args: {
    authHost: string;
    sessionToken: string;
    timeoutMs?: number;
  }) => Promise<string>;
  /** Environment for CI detection in the device flow; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable timestamp for the stored entry's created_at. */
  nowIso?: () => string;
  /** Per-request network timeout (ms) so credential validation can't hang. */
  timeoutMs?: number;
  writers: Writers;
}

/**
 * Timeout for the courtesy `whoami` that enriches the already-logged-in
 * warning. It is only informational, so a slow/unreachable host degrades to the
 * host-only fallback quickly rather than hanging the command.
 */
export const WHOAMI_WARNING_TIMEOUT_MS = 5000;

/**
 * Establishes credentials. The default is the browser device flow (RFC 8628):
 * sign in on the web app, approve the code, and the CLI stores the resulting
 * session token (keyed by host) in the home-directory credentials file. When an
 * API key is explicitly supplied (flag/env/env-file), the legacy key login runs
 * instead: validate via `whoami`, then persist to the project config. A
 * persisted credential (config key or stored session) triggers an
 * already-logged-in warning first. No secret is ever printed.
 */
export async function runLogin(deps: LoginDeps): Promise<void> {
  const host = deps.resolvedHost?.trim() || DEFAULT_HOST;

  // An explicit host override (flag/env/env-file) is deliberate intent to
  // switch hosts, not a bare re-invocation — skip the already-logged-in check.
  const hostOverridden =
    deps.hostSource === "flag" || deps.hostSource === "env" || deps.hostSource === "env-file";

  const persistedSource =
    deps.credential.source === "config" || deps.credential.source === "credentials-file";
  if (deps.credential.value !== undefined && persistedSource && !hostOverridden) {
    // The recovery the CLI prescribes for a revoked session is `traceroot
    // login`. In non-interactive mode the already-logged-in warning would just
    // exit 0 and no-op — so when a stored SESSION is actually dead, re-run the
    // device flow instead of pretending everything is fine.
    if (!deps.isInteractive && deps.credential.kind === "session") {
      const alive = await sessionIsAlive(deps, host, deps.credential.value);
      if (!alive) {
        await deviceLogin(deps, host);
        return;
      }
    }
    const outcome = await reportAlreadyLoggedIn(deps, host);
    if (outcome === "exit") {
      return;
    }
    // User opted to re-login: fall through to the device flow (the default
    // login method) regardless of which credential kind was persisted.
    await deviceLogin(deps, host);
    return;
  }

  // Any resolved API key at this point is either explicitly supplied
  // (flag/env/env-file/auto-.env) or a persisted key being re-pointed at an
  // explicitly overridden host — both mean key login. A session token from the
  // environment is not a login request; the device flow below replaces it.
  if (deps.credential.kind === "api-key" && deps.credential.value !== undefined) {
    await apiKeyLogin(deps, deps.credential.value, host);
    return;
  }

  await deviceLogin(deps, host);
}

/**
 * Probes whether a stored session still authenticates by attempting a mint. A
 * mint success means alive; an auth error (401/403 → the session was revoked or
 * expired) means dead. Any other failure (network, rate limit) is inconclusive,
 * so it's treated as alive — we never force a re-login we can't justify.
 */
async function sessionIsAlive(
  deps: LoginDeps,
  host: string,
  sessionToken: string,
): Promise<boolean> {
  try {
    await deps.mintAccessToken({
      authHost: deps.authHost?.trim() || host,
      sessionToken,
      timeoutMs: deps.timeoutMs,
    });
    return true;
  } catch (err) {
    return !(err instanceof CliError && err.exitCode === ExitCode.auth);
  }
}

/** The legacy key login: validate via `whoami`, persist only on success. */
async function apiKeyLogin(deps: LoginDeps, apiKey: string, host: string): Promise<void> {
  const { writers } = deps;
  const client = deps.createClient({
    host,
    auth: { kind: "api-key", key: apiKey },
    timeoutMs: deps.timeoutMs,
  });
  // Validate before persisting; a failure throws and leaves config untouched.
  const who = await client.whoami();

  deps.writeConfig({ ...(deps.readConfig() ?? {}), api_key: apiKey, host_url: host });

  if (deps.json) {
    writeJson(
      {
        project_id: who.project_id,
        project_name: who.project_name,
        workspace_id: who.workspace_id,
        workspace_name: who.workspace_name,
        key_name: who.key_name,
        key_hint: who.key_hint,
        host: who.host,
        ui_base_url: who.ui_base_url,
      },
      writers,
    );
  } else {
    const styler = createStyler(writers.out);
    const lines = [
      `Logged in to ${styler.dim(who.host)}`,
      `  ${styler.bold("Workspace:")} ${identity(who.workspace_name, who.workspace_id, styler)}`,
      `  ${styler.bold("Project:")}   ${identity(who.project_name, who.project_id, styler)}`,
      `  ${styler.bold("API key:")}   ${apiKeyLabel(who.key_name, who.key_hint, styler)}`,
    ];
    writers.out.write(`${lines.join("\n")}\n`);
  }

  printNextHints(writers);
}

/** The default login: browser device flow → store the session token. */
async function deviceLogin(deps: LoginDeps, host: string): Promise<void> {
  const { writers } = deps;
  const authHost = deps.authHost?.trim() || host;

  const { sessionToken } = await deps.deviceFlow({
    authHost,
    timeoutMs: deps.timeoutMs,
    env: deps.env,
    writers,
  });

  // Identity is a courtesy: the session came from the server moments ago, so a
  // mint hiccup (e.g. rate limit) must not fail the login that just succeeded.
  let email: string | undefined;
  let accessToken: string | undefined;
  try {
    accessToken = await deps.mintAccessToken({
      authHost,
      sessionToken,
      timeoutMs: deps.timeoutMs,
    });
    const claims = decodeJwtClaims(accessToken);
    email = typeof claims?.email === "string" ? claims.email : undefined;
  } catch (err) {
    const message = err instanceof CliError ? err.message : "could not mint an access token";
    logInfo(`Signed in, but couldn't verify the new session yet: ${message}`, writers);
  }

  let workspaces: WorkspaceList | null = null;
  if (accessToken !== undefined) {
    const jwt = accessToken;
    try {
      workspaces = await deps
        .createClient({
          host,
          // A fixed just-minted JWT: invalidate has nothing to drop (a retry
          // would re-serve the same token, and this call is informational).
          auth: {
            kind: "token-provider",
            getAccessToken: () => Promise.resolve(jwt),
            invalidate: () => {},
          },
          timeoutMs: deps.timeoutMs,
        })
        .listWorkspaces();
    } catch {
      // Informational only.
    }
  }

  const entry: CredentialEntry = { session_token: sessionToken };
  if (authHost !== host) {
    entry.auth_host = authHost;
  }
  if (email !== undefined) {
    entry.email = email;
  }
  const createdAt = deps.nowIso?.() ?? new Date().toISOString();
  entry.created_at = createdAt;
  deps.writeCredentialEntry(host, entry);

  // Persist an explicitly overridden host so subsequent reads resolve it
  // without re-passing the flag. A bare production login writes no config — but
  // an explicit --host to the default must still overwrite a stale config
  // host_url, or the next command would resolve the old host and miss the
  // session just stored under the default.
  const hostOverridden =
    deps.hostSource === "flag" || deps.hostSource === "env" || deps.hostSource === "env-file";
  const existingConfig = deps.readConfig() ?? {};
  if (hostOverridden && (host !== DEFAULT_HOST || existingConfig.host_url !== undefined)) {
    deps.writeConfig({ ...existingConfig, host_url: host });
  }

  if (deps.json) {
    writeJson(
      {
        status: "logged_in",
        host,
        auth_host: authHost,
        email: email ?? null,
        workspaces: workspaces?.data ?? null,
      },
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  const lines = [
    `Logged in to ${styler.dim(host)}${email !== undefined ? ` as ${styler.bold(email)}` : ""}`,
  ];
  if (workspaces !== null && workspaces.data.length > 0) {
    lines.push(`  ${styler.bold("Workspaces:")} ${workspaces.data.map((w) => w.name).join(", ")}`);
  }
  writers.out.write(`${lines.join("\n")}\n`);
  printNextHints(writers);
}

function printNextHints(writers: Writers): void {
  logInfo("\nNext: run `traceroot status` to confirm your identity.", writers);
  logInfo("Next: run `traceroot traces list` to see your traces.", writers);
}

/**
 * Handles a bare `login` while a credential is already persisted (config API
 * key or stored session): warns who the saved credential belongs to and,
 * interactively, asks whether to re-login. The identity lookup is best-effort
 * and never throws; no secret is ever printed. Returns `"relogin"` only when an
 * interactive user opts to switch; every other path (no TTY, `--json`, or a
 * declined prompt) returns `"exit"`, leaving everything untouched.
 */
async function reportAlreadyLoggedIn(deps: LoginDeps, host: string): Promise<"exit" | "relogin"> {
  const { writers } = deps;
  const styler = createStyler(writers.err);
  const isSession = deps.credential.kind === "session";

  let who: Whoami | null = null;
  let email: string | undefined;
  if (isSession) {
    email = deps.readCredentialEntry(host)?.email;
  } else if (deps.credential.value !== undefined) {
    try {
      const client = deps.createClient({
        host,
        auth: { kind: "api-key", key: deps.credential.value },
        timeoutMs: WHOAMI_WARNING_TIMEOUT_MS,
      });
      who = await client.whoami();
    } catch {
      who = null;
    }
  }

  if (deps.json) {
    if (isSession) {
      writeJson(
        { status: "already_logged_in", credential: "session", host, email: email ?? null },
        writers,
      );
    } else {
      writeJson(
        who !== null
          ? {
              status: "already_logged_in",
              credential: "api-key",
              verified: true,
              host: who.host,
              workspace_id: who.workspace_id,
              workspace_name: who.workspace_name,
              project_id: who.project_id,
              project_name: who.project_name,
            }
          : { status: "already_logged_in", credential: "api-key", verified: false, host },
        writers,
      );
    }
    return "exit";
  }

  if (isSession) {
    const asWho = email !== undefined ? ` as ${styler.bold(email)}` : "";
    logInfo(`${styler.warn("WARNING:")} Already logged in to ${styler.dim(host)}${asWho}`, writers);
  } else if (who !== null) {
    const lines = [
      `${styler.warn("WARNING:")} Already logged in:`,
      `  ${styler.bold("Workspace:")} ${identity(who.workspace_name, who.workspace_id, styler)}`,
      `  ${styler.bold("Project:")}   ${identity(who.project_name, who.project_id, styler)}`,
      `  ${styler.bold("Host:")}      ${styler.dim(who.host)}`,
    ];
    logInfo(lines.join("\n"), writers);
  } else {
    // Reached only for an API key whose courtesy whoami failed (every session
    // credential returns above), so name the credential kind accurately.
    logInfo(`${styler.warn("WARNING:")} Already logged in to ${styler.dim(host)}`, writers);
    logInfo("  (couldn't verify the saved credentials).", writers);
  }

  if (!deps.isInteractive) {
    logInfo("Run `traceroot login` interactively, or pass --host/--api-key to switch.", writers);
    return "exit";
  }

  const proceed = await deps.promptConfirm("Re-login with a different account? (y/N): ");
  if (!proceed) {
    logInfo("Keeping current session.", writers);
    return "exit";
  }
  return "relogin";
}

/** Reads a visible yes/no answer; returns `true` only for an explicit y/yes. */
function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Sign in with the browser (device flow), or persist an explicit --api-key")
    .action(async (_opts, command: Command) => {
      // Reuse the standard resolution chain so `login` honors flags, --env-file,
      // env vars, an existing config, and a working-directory .env identically
      // to the read commands.
      const ctx = contextFromCommand(command);
      await runLogin({
        credential: ctx.auth.credential,
        resolvedHost: ctx.auth.hostUrl.value,
        hostSource: ctx.auth.hostUrl.source,
        authHost: ctx.auth.authHost.value,
        json: ctx.json,
        isInteractive: process.stdin.isTTY === true,
        promptConfirm,
        createClient: createApiClient,
        readConfig: loadConfigOrThrow,
        writeConfig: realWriteConfig,
        readCredentialEntry: readCredential,
        writeCredentialEntry: writeCredential,
        deviceFlow: runDeviceFlow,
        mintAccessToken: ({ authHost, sessionToken, timeoutMs }) =>
          createTokenProvider({ authHost, sessionToken, timeoutMs }).getAccessToken(),
        timeoutMs: ctx.timeoutMs,
        writers: defaultWriters,
      });
    });
}
