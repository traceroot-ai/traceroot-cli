import type { Command } from "commander";
import { normalizeBaseUrl } from "../api/client.js";
import { deleteCredential } from "../auth/credentials.js";
import { loadConfigOrThrow, writeConfig as realWriteConfig } from "../config/manager.js";
import type { Config } from "../config/schema.js";
import { CliError, ExitCode, type Writers, defaultWriters, logInfo, writeJson } from "../output.js";
import { createStyler } from "../render/style.js";
import { getVersion } from "../version.js";
import { DEFAULT_HOST } from "./constants.js";
import { contextFromCommand } from "./shared.js";

/** Dependencies for {@link runLogout}; production wiring lives in {@link registerLogout}. */
export interface LogoutDeps {
  /** The API host the stored credential is keyed by. */
  host: string;
  /** The resolved auth host to send the revoke call to (flag > env > entry > host). */
  authHost: string;
  json: boolean;
  /**
   * The resolved active session token (the CLI's refresh credential), if the
   * resolved credential is a session. Undefined for api-key or no credential.
   */
  sessionToken?: string;
  /**
   * Whether the resolved session came from the credentials file (so logout can
   * delete it) rather than the `TRACEROOT_TOKEN` env var (which it cannot).
   */
  sessionFromFile: boolean;
  /**
   * True when the resolved credential is an API key from an AMBIENT source
   * (flag/env/env-file/auto-.env) rather than the config file. Logout must not
   * delete a lower-priority stored key the user is not even using — mirroring
   * how an env session leaves the stored session entry untouched.
   */
  apiKeyFromEnv: boolean;
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
 * Ends the session. With a resolved session credential: revoke it server-side
 * (`POST {auth}/api/cli/logout`, bearer = session token) and delete the local
 * credential when there is nothing left to revoke — a 200 (revoked true or
 * false, both meaning the row is gone), a 401 (the session no longer
 * authenticates: already dead), or a 404 (the server has no logout route —
 * version skew / pre-deploy — so a CLI-side revoke is impossible and keeping
 * the credential would strand the user locally forever). Only a rate-limit /
 * server-error / network failure keeps the credential: there the revoke
 * genuinely did not happen and CAN succeed on retry, so logout fails loudly.
 * Without a session, a persisted config API key is removed instead. Never
 * prints a secret.
 */
export async function runLogout(deps: LogoutDeps): Promise<void> {
  const { writers } = deps;

  if (deps.sessionToken !== undefined) {
    const outcome = await revokeSession(deps, deps.sessionToken);
    if (outcome === "unconfirmed") {
      // The server never confirmed but a retry can still work: keep the
      // credential so the revoke can be retried, and fail loudly rather than
      // pretend the session is gone.
      throw new CliError(
        `Could not revoke the session at ${deps.authHost} — it is still active. Run \`traceroot logout\` again to retry, or revoke it from Account → Active sessions in the web app.`,
        ExitCode.network,
      );
    }
    // Nothing left for the CLI to revoke. Delete the local entry when we own
    // it; an env-var credential we can only tell the user to clear.
    if (deps.sessionFromFile) {
      deps.deleteCredentialEntry(deps.host);
    }
    reportSessionLogout(deps, outcome);
    return;
  }

  if (deps.apiKeyFromEnv) {
    // The active key comes from a flag or the environment — there is nothing
    // the CLI can delete, and a lower-priority key stored in config belongs to
    // a credential the user is not even using right now.
    if (deps.json) {
      writeJson({ status: "env_credential", credential: "api-key", host: deps.host }, writers);
    } else {
      writers.out.write(
        "The active API key comes from a flag or the environment — unset TRACEROOT_API_KEY (or drop --api-key) to log out. Stored credentials were left untouched.\n",
      );
    }
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
 * What the server-side revoke attempt established.
 *
 * - `revoked`: the server confirmed it revoked the session just now.
 * - `gone`: nothing left to revoke — the route's idempotent `revoked:false`,
 *   a 401 (the session no longer authenticates), or a 200 whose body could not
 *   be read (the server still processed the logout).
 * - `unsupported`: the route 404s (version skew / pre-deploy backend) — a
 *   CLI-side revoke is impossible, so the local credential must not be held
 *   hostage to it.
 * - `unconfirmed`: the revoke genuinely failed but can succeed on retry
 *   (429/5xx/network) — the only outcome that keeps the credential.
 */
type RevokeOutcome = "revoked" | "gone" | "unsupported" | "unconfirmed";

/**
 * Attempts the server-side revoke and classifies the answer (see
 * {@link RevokeOutcome}). Throws only for a malformed auth host (usage error,
 * before any request); otherwise never throws and never leaks the token.
 */
async function revokeSession(deps: LogoutDeps, sessionToken: string): Promise<RevokeOutcome> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  // Same validation as the API client and device flow: a malformed/non-http(s)
  // auth host is a usage error before any request — not a "retryable" network
  // failure that would keep the credential hostage to a bad flag value.
  const base = normalizeBaseUrl(deps.authHost);
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      accept: "application/json",
      "user-agent": `traceroot-cli/${getVersion()}`,
    },
  };
  if (deps.timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(deps.timeoutMs);
  }
  try {
    const res = await fetchImpl(`${base}/api/cli/logout`, init);
    // On every status-only return the body is never read: cancel it so its
    // stream/socket can't hold the process open until the server closes it.
    const dropBody = async (outcome: RevokeOutcome): Promise<RevokeOutcome> => {
      await res.body?.cancel().catch(() => {});
      return outcome;
    };
    if (res.status === 404) {
      // The route is not deployed (older/self-hosted backend): a CLI-side
      // revoke is impossible, not merely failed.
      return dropBody("unsupported");
    }
    if (res.status === 401) {
      // The session no longer authenticates — already expired or revoked.
      return dropBody("gone");
    }
    if (res.status !== 200) {
      // The route's contract is a plain 200; any other status — including an
      // off-contract 2xx like 202 Accepted — did not CONFIRM the revoke.
      return dropBody("unconfirmed");
    }
    // A 200 means the server processed the logout; a body that cannot be read
    // (empty, malformed, or JSON `null`) must not strand the credential locally.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return "gone";
    }
    return typeof body === "object" &&
      body !== null &&
      (body as { revoked?: unknown }).revoked === true
      ? "revoked"
      : "gone";
  } catch {
    return "unconfirmed";
  }
}

function reportSessionLogout(
  deps: LogoutDeps,
  outcome: Exclude<RevokeOutcome, "unconfirmed">,
): void {
  const { writers } = deps;
  if (deps.json) {
    writeJson(
      {
        status: "logged_out",
        credential: "session",
        revoked: outcome === "revoked",
        host: deps.host,
        // An env-var credential is revoked but still present in the shell.
        env_credential: !deps.sessionFromFile,
        ...(outcome === "unsupported"
          ? {
              warning:
                "the server has no logout route; if the session is still active, revoke it from Account → Active sessions in the web app",
            }
          : {}),
      },
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  // Access JWTs verify offline, so revocation stops future mints — a just-minted
  // token stays valid until its ~10-minute expiry. `gone` means the session no
  // longer resolved server-side; `unsupported` means the server cannot revoke
  // from the CLI at all, so only the local credential was cleared.
  const detail =
    outcome === "revoked"
      ? "The session is revoked; a short-lived access token may remain valid for up to 10 minutes."
      : outcome === "gone"
        ? "The session was already expired or revoked server-side."
        : "The server has no logout route (older backend) — the local credential is cleared, but if the session is still active, revoke it from Account → Active sessions in the web app.";
  writers.out.write(`Logged out of ${styler.dim(deps.host)}. ${detail}\n`);
  if (!deps.sessionFromFile) {
    logInfo(
      "Note: the session came from TRACEROOT_TOKEN — unset it where it is set (shell or --env-file) to finish logging out.",
      writers,
    );
  }
}

export function registerLogout(program: Command): void {
  program
    .command("logout")
    .description("Log out: revoke the active session server-side and remove the local credential")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const host = ctx.auth.hostUrl.value ?? DEFAULT_HOST;
      const credential = ctx.auth.credential;
      await runLogout({
        host,
        authHost: ctx.auth.authHost.value ?? host,
        json: ctx.json,
        sessionToken: credential.kind === "session" ? credential.value : undefined,
        sessionFromFile: credential.source === "credentials-file",
        apiKeyFromEnv: credential.kind === "api-key" && credential.source !== "config",
        deleteCredentialEntry: deleteCredential,
        readConfig: loadConfigOrThrow,
        writeConfig: realWriteConfig,
        timeoutMs: ctx.timeoutMs,
        writers: defaultWriters,
      });
    });
}
