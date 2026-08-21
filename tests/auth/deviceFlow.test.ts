import { describe, expect, it } from "vitest";
import { browserOpenCommand, runDeviceFlow } from "../../src/auth/deviceFlow.js";
import { CliError, ExitCode } from "../../src/output.js";
import { type FetchCall, createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
import { StringSink } from "../helpers/stringSink.js";

const CODE_RESPONSE = {
  device_code: "dev-1",
  user_code: "ABCD-EFGH",
  verification_uri: "https://ui/device",
  verification_uri_complete: "https://ui/device?user_code=ABCD-EFGH",
  expires_in: 1800,
  interval: 5,
};

interface HarnessOptions {
  responder: (call: FetchCall, pollCount: number) => Response | Promise<Response>;
  env?: NodeJS.ProcessEnv;
  openBrowser?: (url: string) => Promise<boolean>;
}

function harness(opts: HarnessOptions) {
  let clock = 0;
  let polls = 0;
  const sleeps: number[] = [];
  const opened: string[] = [];
  const out = new StringSink();
  const err = new StringSink();
  const fake = createFakeFetch((call) => {
    if (call.url.endsWith("/api/auth/device/token")) {
      polls += 1;
    }
    return opts.responder(call, polls);
  });
  const run = () =>
    runDeviceFlow({
      authHost: "https://ui",
      fetchImpl: fake.fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      openBrowser:
        opts.openBrowser ??
        (async (url) => {
          opened.push(url);
          return true;
        }),
      env: opts.env ?? {},
      writers: { out, err },
    });
  return { run, calls: fake.calls, sleeps, opened, out, err };
}

function tokenPending() {
  return jsonResponse({ error: "authorization_pending" }, 400);
}

describe("runDeviceFlow", () => {
  it("requests a code, opens the browser, polls, and returns the session token", async () => {
    const h = harness({
      responder: (call, polls) => {
        if (call.url.endsWith("/api/auth/device/code")) {
          return jsonResponse(CODE_RESPONSE);
        }
        return polls < 3 ? tokenPending() : jsonResponse({ access_token: "sess-1" });
      },
    });
    const result = await h.run();
    expect(result.sessionToken).toBe("sess-1");

    // The code request carries the allowlisted client id.
    const codeCall = h.calls[0];
    expect(codeCall?.url).toBe("https://ui/api/auth/device/code");
    expect(JSON.parse(String(codeCall?.init.body))).toEqual({ client_id: "traceroot-cli" });
    expect(new Headers(codeCall?.init.headers).get("content-type")).toBe("application/json");

    // Poll requests carry the device_code grant.
    const pollCall = h.calls[1];
    expect(pollCall?.url).toBe("https://ui/api/auth/device/token");
    expect(JSON.parse(String(pollCall?.init.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dev-1",
      client_id: "traceroot-cli",
    });

    // Instructions go to stderr: the code and the full URL (SSH-friendly).
    expect(h.err.data).toContain("ABCD-EFGH");
    expect(h.err.data).toContain("https://ui/device?user_code=ABCD-EFGH");
    expect(h.out.data).toBe("");
    expect(h.opened).toEqual(["https://ui/device?user_code=ABCD-EFGH"]);

    // Honors the server interval between polls.
    expect(h.sleeps.every((ms) => ms >= 5000)).toBe(true);
  });

  it("adds five seconds to the interval on slow_down", async () => {
    const h = harness({
      responder: (call, polls) => {
        if (call.url.endsWith("/api/auth/device/code")) {
          return jsonResponse(CODE_RESPONSE);
        }
        if (polls === 1) {
          return jsonResponse({ error: "slow_down" }, 400);
        }
        return polls === 2 ? tokenPending() : jsonResponse({ access_token: "sess-1" });
      },
    });
    await h.run();
    expect(h.sleeps[0]).toBe(5000);
    expect(h.sleeps[1]).toBe(10000);
    expect(h.sleeps[2]).toBe(10000);
  });

  it("fails with an auth error when the user denies", async () => {
    const h = harness({
      responder: (call) =>
        call.url.endsWith("/api/auth/device/code")
          ? jsonResponse(CODE_RESPONSE)
          : jsonResponse({ error: "access_denied" }, 400),
    });
    const err = await h.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.auth);
    expect((err as CliError).message).toContain("denied");
  });

  it("fails with an auth error when the device code expires server-side", async () => {
    const h = harness({
      responder: (call) =>
        call.url.endsWith("/api/auth/device/code")
          ? jsonResponse(CODE_RESPONSE)
          : jsonResponse({ error: "expired_token" }, 400),
    });
    const err = await h.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.auth);
    expect((err as CliError).message).toContain("expired");
  });

  it("gives up when the window elapses while still pending", async () => {
    const h = harness({
      responder: (call) =>
        call.url.endsWith("/api/auth/device/code")
          ? jsonResponse({ ...CODE_RESPONSE, expires_in: 12 })
          : tokenPending(),
    });
    const err = await h.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.auth);
    expect((err as CliError).message).toContain("expired");
  });

  it("continues when the browser cannot be opened", async () => {
    const h = harness({
      responder: (call, polls) => {
        if (call.url.endsWith("/api/auth/device/code")) {
          return jsonResponse(CODE_RESPONSE);
        }
        return polls < 2 ? tokenPending() : jsonResponse({ access_token: "sess-1" });
      },
      openBrowser: async () => {
        throw new Error("no browser");
      },
    });
    const result = await h.run();
    expect(result.sessionToken).toBe("sess-1");
    expect(h.err.data).toContain("https://ui/device?user_code=ABCD-EFGH");
  });

  it("hints at API keys under CI=true, and only there", async () => {
    const responder = (call: FetchCall) =>
      call.url.endsWith("/api/auth/device/code")
        ? jsonResponse(CODE_RESPONSE)
        : jsonResponse({ access_token: "sess-1" });

    const ci = harness({ responder, env: { CI: "true" } });
    await ci.run();
    expect(ci.err.data).toContain("TRACEROOT_API_KEY");

    // No TTY but not CI (an attended agent over a pipe): no nag.
    const plain = harness({ responder, env: {} });
    await plain.run();
    expect(plain.err.data).not.toContain("TRACEROOT_API_KEY");
  });

  it("rejects a non-http verification URL without opening or polling", async () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      const h = harness({
        responder: (call) =>
          call.url.endsWith("/api/auth/device/code")
            ? jsonResponse({ ...CODE_RESPONSE, verification_uri_complete: bad })
            : jsonResponse({ access_token: "sess-1" }),
      });
      const err = await h.run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("verification URL");
      // Never printed, never handed to the opener, never polled.
      expect(h.opened).toEqual([]);
      expect(h.err.data).not.toContain(bad);
      expect(h.calls.some((c) => c.url.endsWith("/api/auth/device/token"))).toBe(false);
    }
  });

  it("surfaces a device/code failure as a CliError", async () => {
    const h = harness({
      responder: () => jsonResponse({ error: "invalid_client" }, 400),
    });
    const err = await h.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
  });
});

describe("browserOpenCommand", () => {
  it("never routes the URL through cmd.exe on Windows", () => {
    const [cmd, args] = browserOpenCommand("win32", "https://ui/device?user_code=A&b=2");
    // cmd.exe re-parses metacharacters (& | ^ etc.) → command injection. rundll32
    // receives the URL as a single non-shell argument, so it cannot.
    expect(cmd).not.toBe("cmd");
    expect(cmd).toBe("rundll32");
    expect(args).toEqual(["url.dll,FileProtocolHandler", "https://ui/device?user_code=A&b=2"]);
  });

  it("uses the native opener on macOS and Linux", () => {
    expect(browserOpenCommand("darwin", "https://ui/d")).toEqual(["open", ["https://ui/d"]]);
    expect(browserOpenCommand("linux", "https://ui/d")).toEqual(["xdg-open", ["https://ui/d"]]);
  });
});
