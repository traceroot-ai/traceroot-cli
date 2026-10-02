import { PassThrough } from "node:stream";
import { type ApiClient, type ApiClientOptions, DEFAULT_TIMEOUT_MS } from "../../src/api/client.js";
import type { SetupApi } from "../../src/api/setup.js";
import type { CredentialEntry } from "../../src/auth/credentials.js";
import type { DeviceFlowDeps, DeviceFlowResult } from "../../src/auth/deviceFlow.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import type { Context } from "../../src/context.js";
import type { Writers } from "../../src/output.js";
import type { RunProcessOptions, RunProcessResult } from "../../src/setup/exec.js";
import type { SetupDeps } from "../../src/setup/machine.js";
import type { ResolvedSdk } from "../../src/setup/sdk.js";
import { makeSecret } from "../../src/setup/secret.js";
import type { SetupFlags } from "../../src/setup/types.js";
import { StringSink } from "../helpers/stringSink.js";

/** A recorded child-process launch, for asserting argv and environment. */
export interface RecordedRun {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}

export interface FakeProcessOptions {
  /** Result per program name; anything unlisted exits 0 with no output. */
  results?: Record<string, Partial<RunProcessResult>>;
  /** `git status --porcelain -z` output, keyed by call order (last value repeats). */
  gitStatus?: string[];
}

/**
 * A process runner that records every launch instead of spawning anything, so
 * agent invocation, verification and git probing are all assertable offline.
 */
export function fakeRunProcess(options: FakeProcessOptions = {}): {
  run: (o: RunProcessOptions) => Promise<RunProcessResult>;
  runs: RecordedRun[];
} {
  const runs: RecordedRun[] = [];
  let gitCalls = 0;
  const run = async (o: RunProcessOptions): Promise<RunProcessResult> => {
    runs.push({
      program: o.program,
      args: [...o.args],
      cwd: o.cwd,
      env: { ...o.env },
      stdin: o.stdin,
    });

    // `includes`, not `args[0]`: the probe passes `--no-optional-locks` before the
    // subcommand so it cannot take `index.lock`.
    if (o.program === "git" && o.args.includes("status")) {
      const statuses = options.gitStatus ?? [""];
      const value = statuses[Math.min(gitCalls, statuses.length - 1)] ?? "";
      gitCalls += 1;
      return { exitCode: 0, output: value, durationMs: 1, timedOut: false, spawnFailed: false };
    }

    const override = options.results?.[o.program];
    // A real capture streams as it goes; replaying the canned output through
    // `onData` is what lets the activity feed be exercised without a process.
    if (override?.output !== undefined && override.output !== "") {
      o.onData?.(override.output);
    }
    return {
      exitCode: override?.exitCode ?? 0,
      output: override?.output ?? "",
      durationMs: override?.durationMs ?? 1,
      timedOut: override?.timedOut ?? false,
      spawnFailed: override?.spawnFailed ?? false,
    };
  };
  return { run, runs };
}

/** Minimal `whoami` payload; overridable per field. */
export function whoami(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: "p_1",
    project_name: "demo",
    workspace_id: "w_1",
    workspace_name: "acme",
    key_name: "cli",
    key_hint: "tr-…abcd",
    host: "https://api.example.test",
    ui_base_url: "https://app.example.test",
    ...overrides,
  };
}

export interface FakeClientOptions {
  whoamiResult?: Record<string, unknown> | (() => Promise<Record<string, unknown>>);
  traces?: unknown[] | (() => unknown[]);
}

/** An {@link ApiClient} whose methods are stubs; unused methods throw. */
export function fakeApiClient(options: FakeClientOptions = {}): ApiClient {
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    whoami: async () => {
      const result = options.whoamiResult ?? whoami();
      const value = typeof result === "function" ? await result() : result;
      return value as Awaited<ReturnType<ApiClient["whoami"]>>;
    },
    listTraces: async () => {
      const traces =
        typeof options.traces === "function" ? options.traces() : (options.traces ?? []);
      // The REAL envelope from `PublicTraceListResponse` (openapi.json), not a
      // bare array. Returning the convenient shape here is what previously let a
      // response-unwrapping bug pass every test and still find zero traces
      // against the live API.
      return { data: traces, meta: { limit: traces.length } } as unknown as Awaited<
        ReturnType<ApiClient["listTraces"]>
      >;
    },
    getTrace: unsupported("getTrace"),
    exportTrace: unsupported("exportTrace"),
    listDetectors: unsupported("listDetectors"),
    listFindings: unsupported("listFindings"),
    getFinding: unsupported("getFinding"),
    getFindingByTrace: unsupported("getFindingByTrace"),
  };
}

/** A {@link SetupApi} where every method rejects unless overridden. */
export function fakeSetupApi(overrides: Partial<SetupApi> = {}): SetupApi {
  const reject = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected setup API call: ${name}`);
  };
  return {
    listWorkspaces: reject("listWorkspaces"),
    listProjects: reject("listProjects"),
    createProject: reject("createProject"),
    listApiKeys: reject("listApiKeys"),
    createApiKey: reject("createApiKey"),
    createProjectApiKey: reject("createProjectApiKey"),
    revokeApiKey: reject("revokeApiKey"),
    ...overrides,
  } as SetupApi;
}

/** Resolved auth with a key already present (the "already logged in" case). */
export function authWithKey(key = "tr-existing-key-value"): ResolvedAuth {
  return {
    credential: { kind: "api-key", value: key, source: "config" },
    hostUrl: { value: "https://api.example.test", source: "config" },
    authHost: { value: "https://api.example.test", source: "default" },
    projectId: { value: undefined, source: "none" },
  };
}

/** Resolved auth holding a session credential from a browser login. */
export function authWithSession(token = "session-token-value"): ResolvedAuth {
  return {
    credential: { kind: "session", value: token, source: "credentials-file" },
    hostUrl: { value: "https://api.example.test", source: "config" },
    authHost: { value: "https://api.example.test", source: "default" },
    projectId: { value: undefined, source: "none" },
  };
}

/** Resolved auth with nothing configured. */
export function authEmpty(): ResolvedAuth {
  return {
    credential: { kind: "none", value: undefined, source: "none" },
    hostUrl: { value: "https://api.example.test", source: "config" },
    authHost: { value: "https://api.example.test", source: "default" },
    projectId: { value: undefined, source: "none" },
  };
}

export function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

export function makeContext(json = false): Context {
  // `timeoutMs` is required by `Context`. It was missing and nothing caught it:
  // `tsconfig.json` excludes `tests`, so a helper can drift from the interface
  // it claims to build.
  return { auth: authWithKey(), json, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export function defaultFlags(overrides: Partial<SetupFlags> = {}): SetupFlags {
  return {
    browser: false,
    instrument: true,
    resume: false,
    traceTimeoutSec: 5,
    ...overrides,
  };
}

export const TEST_SDK: ResolvedSdk = {
  package: "@traceroot-ai/traceroot",
  version: "1.2.3",
  source: "registry",
};

export interface MakeDepsOptions {
  auth?: ResolvedAuth;
  client?: ApiClient;
  setupApi?: SetupApi;
  runProcess?: (o: RunProcessOptions) => Promise<RunProcessResult>;
  env?: NodeJS.ProcessEnv;
  answers?: string[];
  hiddenAnswers?: string[];
  sdk?: ResolvedSdk;
  onWriteConfig?: (config: { api_key: string; host_url: string }) => void;
  tempDir?: string;
  /** Whether a local TraceRoot API answers, for the missing-endpoint hint. */
  localHostResponds?: boolean;
  /** A user credential already on disk for the host under test. */
  storedCredential?: CredentialEntry | null;
  onWriteCredential?: (host: string, entry: CredentialEntry) => void;
  onDeleteCredential?: (host: string) => boolean;
  /** Device-flow stubs. Default to a code that is approved on the first poll. */
  runDeviceFlow?: (deps: DeviceFlowDeps) => Promise<DeviceFlowResult>;
}

/**
 * Fully offline {@link SetupDeps}. Time advances by a fixed step per call so
 * durations are deterministic, and `sleep` returns immediately so poll loops run
 * at full speed.
 */
export function makeDeps(options: MakeDepsOptions = {}): SetupDeps {
  let clock = Date.parse("2026-07-26T12:00:00.000Z");
  const answers = [...(options.answers ?? [])];
  const hidden = [...(options.hiddenAnswers ?? [])];
  return {
    resolvedAuth: options.auth ?? authWithKey(),
    env: options.env ?? { PATH: "/usr/bin" },
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    runProcess: options.runProcess ?? fakeRunProcess().run,
    createClient: (_opts: ApiClientOptions) => options.client ?? fakeApiClient(),
    // The wizard polls for traces through its own client now. Tests still
    // describe the traces on the fake API client, so the default setup API
    // delegates that one read to it rather than making every test say it twice.
    createSetupApi: () =>
      ({
        listTraces: async (params: { limit?: number; startAfter?: string } | undefined) =>
          (await (options.client ?? fakeApiClient()).listTraces(params)) as Awaited<
            ReturnType<SetupApi["listTraces"]>
          >,
        ...(options.setupApi ?? fakeSetupApi()),
      }) as SetupApi,
    openBrowser: async () => true,
    // Consumes the same `answers` queue as the old text prompts: an entry may be
    // an option value, a 1-based index (how the numbered prompts were answered),
    // or empty to accept the default. Keeps existing tests meaningful.
    select: async ({ options, initialValue }) => {
      const answer = answers.shift();
      if (answer === undefined || answer === "") {
        return initialValue ?? options[0].value;
      }
      const byValue = options.find((o) => o.value === answer);
      if (byValue !== undefined) {
        return byValue.value;
      }
      const index = Number.parseInt(answer, 10) - 1;
      return options[index]?.value ?? answer;
    },
    prompt: async () => answers.shift() ?? "",
    promptHidden: async () => hidden.shift() ?? "",
    resolveSdk: async () => options.sdk ?? TEST_SDK,
    writeConfig: options.onWriteConfig ?? (() => undefined),
    sleep: async () => undefined,
    makeTempDir: () => options.tempDir ?? "/tmp/traceroot-setup-test",
    probeHost: async () => options.localHostResponds ?? false,
    // Default: nothing stored, so tests exercise the browser/paste paths unless
    // they explicitly opt into a saved sign-in. Never touches a real home dir.
    readCredential: () => options.storedCredential ?? null,
    writeCredential: options.onWriteCredential ?? (() => undefined),
    deleteCredential: options.onDeleteCredential ?? (() => true),
    runDeviceFlow: options.runDeviceFlow ?? (async () => ({ sessionToken: "session-token-value" })),
    createTokenProvider: () => ({
      getAccessToken: async () => "access-jwt-value",
      invalidate: () => undefined,
    }),
  };
}

/** A trace row shaped like the public API's list response. */
export function traceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: "t_1",
    trace_url: "https://app.example.test/trace/t_1",
    trace_start_time: "2026-07-26T12:00:30.000000",
    ...overrides,
  };
}

/** A stream clack will treat as a terminal it can read keystrokes from. */
export function fakeInput(): PassThrough & { isTTY: boolean; setRawMode: () => unknown } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => unknown;
  };
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  return stream;
}

/** Somewhere for a prompt to draw that no test ever reads. */
export function fakeOutput(): PassThrough {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
  stream.isTTY = true;
  stream.columns = 80;
  stream.on("data", () => {
    // drained so the stream never fills
  });
  return stream;
}
