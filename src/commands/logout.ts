import type { Command } from "commander";
import { type CredentialEntry, deleteCredential, readCredential } from "../auth/credentials.js";
import {
  readConfig as readConfigFromDisk,
  writeConfig as realWriteConfig,
} from "../config/manager.js";
import type { Config } from "../config/schema.js";
import { type Writers, defaultWriters, logInfo, writeJson } from "../output.js";
import { createStyler } from "../render/style.js";
import { getVersion } from "../version.js";
import { DEFAULT_HOST } from "./constants.js";
import { contextFromCommand } from "./shared.js";

/** Dependencies for {@link runLogout}; production wiring lives in {@link registerLogout}. */
export interface LogoutDeps {
  /** The API host the stored credential is keyed by. */
  host: string;
  /**
   * The host to send the revoke call to. Callers pass the RESOLVED auth host,
   * which already ranks an explicit --auth-host/TRACEROOT_AUTH_URL above the
   * entry's recorded auth_host above the API host — the same precedence every
   * other auth call uses.
   */
  authHost: string;
  json: boolean;
  readCredentialEntry: (host: string) => CredentialEntry | null;
  deleteCredentialEntry: (host: string) => boolean;
  readConfig: () => Config | null;
  writeConfig: (config: Config) => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** Per-request network timeout (ms) so the revoke call can't hang logout. */
  timeoutMs?: number;
  writers: Writers;
}

/**
 * Ends the local session. With a stored session credential: best-effort revoke
 * server-side (`POST {auth}/api/cli/logout`, bearer = session token), then
 * delete the local entry — logout always succeeds locally, with a warning when
 * the server call fails or the route isn't deployed yet. Without one, a
 * persisted config API key is removed instead. Never prints a secret.
 */
export async function runLogout(deps: LogoutDeps): Promise<void> {
  const { writers } = deps;
  const entry = deps.readCredentialEntry(deps.host);

  if (entry !== null) {
    const revoked = await revokeSession(deps, entry);
    deps.deleteCredentialEntry(deps.host);
    reportSessionLogout(deps, revoked);
    return;
  }

  const config = deps.readConfig();
  if (config?.api_key !== undefined) {
    const { api_key: _removed, ...rest } = config;
    deps.writeConfig(rest);
    if (deps.json) {
      writeJson({ status: "logged_out", credential: "api-key", host: deps.host }, writers);
    } else {
      writers.out.write("Removed the stored API key from the project config.\n");
    }
    return;
  }

  if (deps.json) {
    writeJson({ status: "not_logged_in", host: deps.host }, writers);
  } else {
    writers.out.write("Not logged in — nothing to do.\n");
  }
}

/**
 * Attempts the server-side revoke. Returns `true`/`false` for the route's
 * idempotent answer, or `null` when the call failed (network, 404 while the
 * route is not yet deployed, rate limit, …) — the caller degrades to a local
 * logout with a warning. Never throws and never leaks the token.
 */
async function revokeSession(deps: LogoutDeps, entry: CredentialEntry): Promise<boolean | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = deps.authHost.replace(/\/+$/, "");
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${entry.session_token}`,
      accept: "application/json",
      "user-agent": `traceroot-cli/${getVersion()}`,
    },
  };
  if (deps.timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(deps.timeoutMs);
  }
  try {
    const res = await fetchImpl(`${base}/api/cli/logout`, init);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { revoked?: unknown };
    return body.revoked === true ? true : body.revoked === false ? false : null;
  } catch {
    return null;
  }
}

function reportSessionLogout(deps: LogoutDeps, revoked: boolean | null): void {
  const { writers } = deps;
  if (deps.json) {
    writeJson({ status: "logged_out", credential: "session", revoked, host: deps.host }, writers);
    return;
  }

  const styler = createStyler(writers.out);
  if (revoked === true) {
    // Access JWTs verify offline, so revocation stops future mints — a
    // just-minted token stays valid until its ~10-minute expiry.
    writers.out.write(
      `Logged out of ${styler.dim(deps.host)}. The session is revoked; a short-lived access token may remain valid for up to 10 minutes.\n`,
    );
    return;
  }
  if (revoked === false) {
    // The route reports revoked:false when the token no longer resolves —
    // already expired or already revoked. Either way the goal state holds.
    writers.out.write(
      `Logged out of ${styler.dim(deps.host)}. The session was already expired or revoked server-side.\n`,
    );
    return;
  }
  writers.out.write(`Logged out of ${styler.dim(deps.host)} locally.\n`);
  logInfo(
    "WARNING: Your session is still active server-side — revoke it from Account → Active sessions in the web app.",
    writers,
  );
}

export function registerLogout(program: Command): void {
  program
    .command("logout")
    .description("Log out: revoke the session server-side and remove the local credential")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const host = ctx.auth.hostUrl.value ?? DEFAULT_HOST;
      await runLogout({
        host,
        authHost: ctx.auth.authHost.value ?? host,
        json: ctx.json,
        readCredentialEntry: readCredential,
        deleteCredentialEntry: deleteCredential,
        readConfig: () => {
          const result = readConfigFromDisk();
          return result.ok ? result.config : null;
        },
        writeConfig: realWriteConfig,
        timeoutMs: ctx.timeoutMs,
        writers: defaultWriters,
      });
    });
}
