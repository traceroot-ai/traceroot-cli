import { describe, expect, it } from "vitest";
import type { CredentialEntry } from "../src/auth/credentials.js";
import { DEFAULT_HOST } from "../src/commands/constants.js";
import { EnvFileNotFoundError } from "../src/config/envFile.js";
import { type ResolveAuthOptions, resolveAuth } from "../src/config/resolve.js";

function withCredential(
  host: string,
  entry: CredentialEntry,
): (lookup: string) => CredentialEntry | null {
  const key = host.replace(/\/+$/, "");
  return (lookup) => (lookup.replace(/\/+$/, "") === key ? entry : null);
}

function resolve(options: ResolveAuthOptions = {}) {
  return resolveAuth({ readCredential: () => null, ...options });
}

describe("resolveAuth api_key normalization", () => {
  it("strips a pasted TRACEROOT_API_KEY= prefix from a flag", () => {
    const auth = resolve({ flags: { apiKey: "TRACEROOT_API_KEY=tr_abc" } });
    expect(auth.credential).toEqual({ kind: "api-key", value: "tr_abc", source: "flag" });
  });

  it("strips an `export ` prefix and surrounding quotes", () => {
    const auth = resolve({ flags: { apiKey: 'export TRACEROOT_API_KEY="tr_abc"' } });
    expect(auth.credential.value).toBe("tr_abc");
  });

  it("leaves a bare key untouched", () => {
    const auth = resolve({ flags: { apiKey: "tr_abc" } });
    expect(auth.credential.value).toBe("tr_abc");
  });
});

describe("resolveAuth credential precedence", () => {
  it("an explicit --api-key flag beats every session source", () => {
    const auth = resolve({
      flags: { apiKey: "tr_flag" },
      env: { TRACEROOT_TOKEN: "sess_env", TRACEROOT_API_KEY: "tr_env" },
      readCredential: withCredential(DEFAULT_HOST, { session_token: "sess_file" }),
    });
    expect(auth.credential).toEqual({ kind: "api-key", value: "tr_flag", source: "flag" });
  });

  it("an env-file TRACEROOT_TOKEN beats the process env and the credentials file", () => {
    const auth = resolve({
      flags: { envFile: "/tmp/x.env" },
      loadEnvFile: () => ({ TRACEROOT_TOKEN: "sess_envfile" }),
      env: { TRACEROOT_TOKEN: "sess_env", TRACEROOT_API_KEY: "tr_env" },
      readCredential: withCredential(DEFAULT_HOST, { session_token: "sess_file" }),
    });
    expect(auth.credential).toEqual({
      kind: "session",
      value: "sess_envfile",
      source: "env-file",
    });
  });

  it("within one env-file, TRACEROOT_TOKEN outranks TRACEROOT_API_KEY", () => {
    const auth = resolve({
      flags: { envFile: "/tmp/x.env" },
      loadEnvFile: () => ({ TRACEROOT_TOKEN: "sess_envfile", TRACEROOT_API_KEY: "tr_envfile" }),
    });
    expect(auth.credential).toEqual({ kind: "session", value: "sess_envfile", source: "env-file" });
  });

  it("an env-file TRACEROOT_API_KEY beats both process-env credentials", () => {
    const auth = resolve({
      flags: { envFile: "/tmp/x.env" },
      loadEnvFile: () => ({ TRACEROOT_API_KEY: "tr_envfile" }),
      // Both a session token AND a competing api key in the process env, so
      // this genuinely proves the env-file key outranks the process-env pair.
      env: { TRACEROOT_TOKEN: "sess_env", TRACEROOT_API_KEY: "tr_env" },
    });
    expect(auth.credential).toEqual({ kind: "api-key", value: "tr_envfile", source: "env-file" });
  });

  it("TRACEROOT_TOKEN env beats the credentials file and TRACEROOT_API_KEY env", () => {
    const auth = resolve({
      env: { TRACEROOT_TOKEN: "sess_env", TRACEROOT_API_KEY: "tr_env" },
      readCredential: withCredential(DEFAULT_HOST, { session_token: "sess_file" }),
    });
    expect(auth.credential).toEqual({ kind: "session", value: "sess_env", source: "env" });
  });

  it("a stored credential for the resolved host beats TRACEROOT_API_KEY env", () => {
    const auth = resolve({
      env: { TRACEROOT_API_KEY: "tr_env" },
      readCredential: withCredential(DEFAULT_HOST, { session_token: "sess_file" }),
    });
    expect(auth.credential).toEqual({
      kind: "session",
      value: "sess_file",
      source: "credentials-file",
    });
  });

  it("looks up the credentials file under the resolved host, not the default", () => {
    const auth = resolve({
      env: { TRACEROOT_HOST_URL: "https://other" },
      readCredential: withCredential("https://other", { session_token: "sess_other" }),
    });
    expect(auth.credential.value).toBe("sess_other");

    const miss = resolve({
      readCredential: withCredential("https://other", { session_token: "sess_other" }),
    });
    expect(miss.credential.value).toBeUndefined();
  });

  it("TRACEROOT_API_KEY env beats config", () => {
    const auth = resolve({
      env: { TRACEROOT_API_KEY: "tr_env" },
      readConfig: () => ({ api_key: "tr_config", host_url: "https://h" }),
    });
    expect(auth.credential).toEqual({ kind: "api-key", value: "tr_env", source: "env" });
  });

  it("config beats the auto-discovered .env", () => {
    const auth = resolve({
      readConfig: () => ({ api_key: "tr_config", host_url: "https://h" }),
      autoEnvFile: { TRACEROOT_API_KEY: "tr_auto" },
    });
    expect(auth.credential).toEqual({ kind: "api-key", value: "tr_config", source: "config" });
  });

  it("falls back to the auto-discovered .env when nothing else is set", () => {
    const auth = resolve({ autoEnvFile: { TRACEROOT_API_KEY: "tr_auto" } });
    expect(auth.credential).toEqual({
      kind: "api-key",
      value: "tr_auto",
      source: "auto-env-file",
    });
  });

  it("treats a tr_-shaped TRACEROOT_TOKEN as an API key, not a session", () => {
    const auth = resolve({ env: { TRACEROOT_TOKEN: "tr_looks_like_a_key" } });
    // Routed as an api-key (sent directly), never POSTed to the mint route.
    expect(auth.credential).toEqual({
      kind: "api-key",
      value: "tr_looks_like_a_key",
      source: "env",
    });
  });

  it("reports kind none when nothing resolves", () => {
    const auth = resolve();
    expect(auth.credential).toEqual({ kind: "none", value: undefined, source: "none" });
  });
});

describe("resolveAuth host resolution", () => {
  it("strips trailing slashes but preserves the protocol //", () => {
    const auth = resolve({ flags: { host: "https://api.example.com///" } });
    expect(auth.hostUrl).toEqual({ value: "https://api.example.com", source: "flag" });
  });

  it("defaults the host to production when nothing is set", () => {
    const auth = resolve();
    expect(auth.hostUrl).toEqual({ value: DEFAULT_HOST, source: "default" });
  });

  it("defaults when the only host candidate normalizes to empty", () => {
    const auth = resolve({ flags: { host: "///" } });
    expect(auth.hostUrl).toEqual({ value: DEFAULT_HOST, source: "default" });
  });
});

describe("resolveAuth auth host", () => {
  it("defaults to the API host", () => {
    const auth = resolve({ flags: { host: "https://api.example.com" } });
    expect(auth.authHost).toEqual({ value: "https://api.example.com", source: "default" });
  });

  it("honors --auth-host over env and the stored entry", () => {
    const auth = resolve({
      flags: { authHost: "https://ui.flag" },
      env: { TRACEROOT_AUTH_URL: "https://ui.env" },
      readCredential: withCredential(DEFAULT_HOST, {
        session_token: "s",
        auth_host: "https://ui.stored",
      }),
    });
    expect(auth.authHost).toEqual({ value: "https://ui.flag", source: "flag" });
  });

  it("honors TRACEROOT_AUTH_URL over the stored entry", () => {
    const auth = resolve({
      env: { TRACEROOT_AUTH_URL: "https://ui.env/" },
      readCredential: withCredential(DEFAULT_HOST, {
        session_token: "s",
        auth_host: "https://ui.stored",
      }),
    });
    expect(auth.authHost).toEqual({ value: "https://ui.env", source: "env" });
  });

  it("honors TRACEROOT_AUTH_URL from the auto-discovered .env before the host fallback", () => {
    const auth = resolve({ autoEnvFile: { TRACEROOT_AUTH_URL: "https://ui.auto" } });
    expect(auth.authHost).toEqual({ value: "https://ui.auto", source: "auto-env-file" });
  });

  it("uses the stored entry's auth_host when nothing overrides it", () => {
    const auth = resolve({
      readCredential: withCredential(DEFAULT_HOST, {
        session_token: "s",
        auth_host: "https://ui.stored",
      }),
    });
    expect(auth.authHost).toEqual({ value: "https://ui.stored", source: "credentials-file" });
  });

  it("ignores the stored auth_host when TRACEROOT_TOKEN outranks the stored session", () => {
    // The env token may come from a different auth server; minting it at the
    // stored session's auth host would send it to the wrong place.
    const auth = resolve({
      env: { TRACEROOT_TOKEN: "sess_env" },
      readCredential: withCredential(DEFAULT_HOST, {
        session_token: "sess_stored",
        auth_host: "https://ui.stored",
      }),
    });
    expect(auth.credential.source).toBe("env");
    expect(auth.authHost).toEqual({ value: DEFAULT_HOST, source: "default" });
  });
});

describe("resolveAuth project id", () => {
  it("resolves flag over env over config", () => {
    const flag = resolve({
      flags: { project: "p-flag" },
      env: { TRACEROOT_PROJECT_ID: "p-env" },
      readConfig: () => ({ project_id: "p-config" }),
    });
    expect(flag.projectId).toEqual({ value: "p-flag", source: "flag" });

    const env = resolve({
      env: { TRACEROOT_PROJECT_ID: "p-env" },
      readConfig: () => ({ project_id: "p-config" }),
    });
    expect(env.projectId).toEqual({ value: "p-env", source: "env" });

    const config = resolve({ readConfig: () => ({ project_id: "p-config" }) });
    expect(config.projectId).toEqual({ value: "p-config", source: "config" });
  });

  it("reports none when no project is configured", () => {
    expect(resolve().projectId).toEqual({ value: undefined, source: "none" });
  });
});

describe("resolveAuth per-field independence", () => {
  it("api_key from flag while host_url from config", () => {
    const auth = resolve({
      flags: { apiKey: "tr_flag" },
      readConfig: () => ({ api_key: "tr_config", host_url: "https://config-host" }),
    });
    expect(auth.credential.source).toBe("flag");
    expect(auth.hostUrl).toEqual({ value: "https://config-host", source: "config" });
  });
});

describe("resolveAuth env-file loading", () => {
  it("only calls loadEnvFile when --env-file is given", () => {
    let loads = 0;
    resolve({
      loadEnvFile: () => {
        loads += 1;
        return {};
      },
    });
    expect(loads).toBe(0);

    resolve({
      flags: { envFile: "/tmp/x.env" },
      loadEnvFile: () => {
        loads += 1;
        return {};
      },
    });
    expect(loads).toBe(1);
  });

  it("propagates EnvFileNotFoundError from a missing --env-file", () => {
    expect(() =>
      resolve({
        flags: { envFile: "/nope.env" },
        loadEnvFile: (p) => {
          throw new EnvFileNotFoundError(p);
        },
      }),
    ).toThrow(EnvFileNotFoundError);
  });

  it("treats an empty/whitespace flag as absent and falls through to config", () => {
    const auth = resolve({
      flags: { apiKey: "   " },
      readConfig: () => ({ api_key: "tr_config", host_url: "https://h" }),
    });
    expect(auth.credential).toEqual({ kind: "api-key", value: "tr_config", source: "config" });
  });
});
