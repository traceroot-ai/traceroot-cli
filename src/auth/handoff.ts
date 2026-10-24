import {
  normalizeBaseUrl,
  redactSecret,
  timeoutMessage,
  transportFailureMessage,
} from "../api/client.js";
import { CliError, ExitCode } from "../output.js";
import { getVersion } from "../version.js";
import type { DeviceFlowResult } from "./deviceFlow.js";

/**
 * Redemption of a browser handoff code.
 *
 * Browser-first onboarding mints a one-shot code in the tab the user is already
 * in and prints it on the `setup` command. Exchanging it here is what lets that
 * run authenticate without sending the user to a second page — the device flow
 * (`./deviceFlow.ts`) remains the sign-in for terminal-first, and the fallback
 * for every way this can fail.
 *
 * What comes back is a session token: the same artifact the device flow returns
 * as `access_token`, stored the same way and minted against the same route by
 * `./token.ts`. The code itself authorizes exactly one call — this one — and is
 * dead the moment it is used.
 */

/** Options for {@link redeemHandoff}. */
export interface HandoffRedeemOptions {
  /** The host that issued the code (the Next.js app), not the API host. */
  authHost: string;
  /** The one-shot handoff code, `trh_` + 43 base64url characters. */
  code: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** Optional per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * What a redeemed code yields.
 *
 * Deliberately {@link DeviceFlowResult} plus one optional field: the credential
 * the two paths produce is the same artifact, so everything downstream — the
 * stored `CredentialEntry`, the token mint, `resolveAuth` — stays shared. The
 * `email` is a convenience the device flow has to mint a JWT to learn; the
 * response carries it, and callers must still tolerate its absence.
 */
export interface HandoffResult extends DeviceFlowResult {
  email?: string;
}

/**
 * The outcome of a redemption attempt.
 *
 * A refused code is a *value*, not a thrown auth error, because the caller's
 * whole job on refusal is to fall back to the device flow. Throwing would make
 * the one expected failure indistinguishable from the unexpected ones, and a
 * one-shot code that has already been spent is an ordinary thing.
 */
export type HandoffOutcome =
  | { kind: "redeemed"; credential: HandoffResult }
  /**
   * The server refused the code (401/403), or has no route to redeem it at
   * (404). Unknown, expired and already-redeemed are deliberately one answer —
   * the route is not an oracle, so there is nothing finer to report and nothing
   * to branch on — and a deployment that predates the route is recovered from
   * the same way.
   */
  | { kind: "rejected" };

/** Shape of a successful response from `POST /api/cli/handoff/redeem`. */
interface RedeemBody {
  sessionToken?: unknown;
  email?: unknown;
}

/**
 * Exchanges a handoff code for a session token at
 * `POST {authHost}/api/cli/handoff/redeem`.
 *
 * Resolves to `{ kind: "rejected" }` when the server refuses the code or has
 * no such route, so the caller can fall back. Everything else throws: a 429, a
 * 5xx or a timeout is a reachability problem and is reported as one
 * (`ExitCode.network`) rather than being dressed up as a bad code.
 */
export async function redeemHandoff(opts: HandoffRedeemOptions): Promise<HandoffOutcome> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  // Same validation as the API client: a malformed/non-http(s) auth host is a
  // usage error up front, not a garbage URL handed to fetch.
  const base = normalizeBaseUrl(opts.authHost);
  const code = opts.code.trim();
  if (code === "") {
    throw new CliError("--handoff needs a code", ExitCode.usage);
  }

  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": `traceroot-cli/${getVersion()}`,
    },
    body: JSON.stringify({ code }),
  };
  if (opts.timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(opts.timeoutMs);
  }

  // The timeout deadline covers the whole request, so it can fire while
  // connecting, reading headers, or streaming the body. Translate that one
  // cause into a network-class timeout wherever it surfaces.
  const throwIfTimeout = (err: unknown): void => {
    if (opts.timeoutMs !== undefined && err instanceof Error && err.name === "TimeoutError") {
      throw new CliError(timeoutMessage(base, opts.timeoutMs), ExitCode.network);
    }
  };

  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/cli/handoff/redeem`, init);
  } catch (err) {
    throwIfTimeout(err);
    const message = err instanceof Error ? err.message : String(err);
    // Never echo the code: a transport error quotes the request it failed on,
    // and the request body is the credential. Same redaction the API client
    // applies to a bearer token.
    throw new CliError(
      transportFailureMessage(base, redactSecret(message, code)),
      ExitCode.network,
    );
  }

  // Nothing below this is decided on anything but the status, so the body is
  // released once, here, rather than on each way out. An unread body holds its
  // stream — and the socket under it — until the server gives up, which is a
  // CLI that has printed its error and will not exit. Same discipline as
  // `commands/logout.ts` and the client's 401 retry, and structural rather than
  // repeated: a status branch added inside this block cannot forget it.
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});

    // One indistinguishable refusal for unknown / expired / already-redeemed.
    // Recoverable by contract: the caller signs in the ordinary way instead.
    //
    // A 404 too: a deployment that predates the route. Not a bad code, but the
    // ordinary sign-in still works there, where ending the run did not help.
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { kind: "rejected" };
    }
    if (res.status === 429) {
      throw new CliError(
        "handoff sign-in rate limited — wait a moment and try again",
        ExitCode.network,
      );
    }
    // A 5xx is the server failing to answer, which a retry may well fix; any
    // other status is an answer this CLI does not understand, which it will
    // not. One sentence either way, because the status is the whole of what is
    // known.
    throw new CliError(
      `handoff sign-in failed with status ${res.status}`,
      res.status >= 500 ? ExitCode.network : ExitCode.internal,
    );
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    // A stall streaming the body is a network timeout, not a malformed
    // response — match token.ts so the exit-code contract stays honest.
    throwIfTimeout(err);
    // The other two are not one failure either. Malformed JSON is the server's
    // answer and no retry changes it; a transport fault part-way through the
    // body is the opposite, and reporting it as an internal error sends the
    // reader to look for a bug rather than to try again. `runDeviceFlow`'s
    // `readBody` draws the line in the same place.
    if (err instanceof SyntaxError) {
      throw new CliError("handoff sign-in returned an unreadable response", ExitCode.internal);
    }
    throw new CliError(`request to ${base} failed while reading the response`, ExitCode.network);
  }
  // A JSON `null` or a non-object body is malformed — read fields only off a
  // real object so it never throws a raw TypeError.
  if (typeof parsed !== "object" || parsed === null) {
    throw new CliError("handoff sign-in returned a malformed response", ExitCode.internal);
  }
  const body = parsed as RedeemBody;
  if (typeof body.sessionToken !== "string" || body.sessionToken === "") {
    throw new CliError("handoff sign-in returned no session token", ExitCode.internal);
  }
  const email = typeof body.email === "string" && body.email !== "" ? body.email : undefined;
  const credential: HandoffResult = { sessionToken: body.sessionToken };
  if (email !== undefined) {
    credential.email = email;
  }
  return { kind: "redeemed", credential };
}
