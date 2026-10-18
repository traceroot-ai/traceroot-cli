import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type ApiClient,
  type ApiClientOptions,
  DEFAULT_TIMEOUT_MS,
  type TraceList,
} from "../../src/api/client.js";
import type { SetupApi } from "../../src/api/setup.js";
import type { CredentialEntry } from "../../src/auth/credentials.js";
import type { DeviceFlowDeps, DeviceFlowResult } from "../../src/auth/deviceFlow.js";
import type { HandoffOutcome, HandoffRedeemOptions } from "../../src/auth/handoff.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import type { Context } from "../../src/context.js";
import type { Writers } from "../../src/output.js";
import type { RunProcessOptions, RunProcessResult } from "../../src/setup/exec.js";
import type { SetupDeps } from "../../src/setup/machine.js";
import type { ResolvedSdk } from "../../src/setup/sdk.js";
import { makeSecret } from "../../src/setup/secret.js";
import { detectStack, findTraceRootInitialization } from "../../src/setup/stack.js";
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
  /**
   * Result per git invocation, chosen from its arguments.
   *
   * `results` is keyed by program name, which cannot tell one git subcommand
   * from another — and setup now makes three different ones, where
   * `check-ignore` and `ls-files` have to be able to answer differently.
   * `status` is still served by `gitStatus` above.
   */
  git?: (args: readonly string[]) => Partial<RunProcessResult>;
  /**
   * Whether the fake coding agent instruments the service it is launched in.
   *
   * On by default, because that is what a real one does, and a suite whose
   * agent never wires anything up cannot tell a working run from the one bug
   * that matters most here: an agent that exits 0 having done nothing. It
   * appends the initialization `detectStack` looks for to the entry point in
   * the directory the agent was launched in — the smallest edit that makes the
   * service genuinely instrumented.
   *
   * `false` is for the tests about an agent that did not do its job.
   */
  instrument?: boolean;
}

/** The agents setup can actually launch; see `LAUNCHABLE_AGENT_IDS`. */
const AGENT_PROGRAMS = new Set(["claude", "codex"]);

/**
 * The one edit the fake agent makes: a real `initialize()` call in the entry
 * point, in the form the detector recognizes for that language.
 *
 * Which file that is, and whether it is already instrumented, are both asked of
 * the production detector rather than answered by a copy of its rules here. A
 * copy drifts in two directions and both produce a lying fixture: a different
 * entry point from the one `detect_stack` reads leaves the service the run
 * checks untouched, and a narrower idea of what counts as instrumentation (an
 * exact `traceroot.initialize(` and nothing else) appends a second
 * initialization to a fixture that was wired up with `traceroot.init()` or an
 * imported bare `initialize()`.
 *
 * Appended rather than written over, so a fixture that already carries
 * instrumentation (or any other content a test asserts on) keeps it.
 */
function instrumentEntryPoint(cwd: string): void {
  // The agent is launched in the service directory, so that is the root the
  // detector is asked about and the service is the one at `.`.
  const service = detectStack(cwd).selected;
  if (service === null || service.entryPoint === null) {
    return;
  }
  // By the detector's own rules, not a substring of one of them.
  if (findTraceRootInitialization(cwd, service) !== null) {
    return;
  }
  appendFileSync(
    join(cwd, service.entryPoint),
    service.language === "python"
      ? "\nimport traceroot\n\ntraceroot.initialize()\n"
      : '\nimport * as traceroot from "traceroot";\n\ntraceroot.initialize();\n',
    "utf8",
  );
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

    if (AGENT_PROGRAMS.has(o.program) && options.instrument !== false) {
      instrumentEntryPoint(o.cwd);
    }

    const override =
      o.program === "git" && options.git !== undefined
        ? options.git(o.args)
        : options.results?.[o.program];
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

/**
 * What `codex exec` prints for a task, in the layout codex-cli 0.163.0 printed
 * on a live run: a header, the task echoed under `user`, the reply under
 * `codex`, the token count, and the final message again.
 */
export function codexCapture(task: string, reply: string): string {
  return [
    "OpenAI Codex v0.163.0",
    "--------",
    "workdir: /repo",
    "approval: never",
    "sandbox: workspace-write [workdir, /tmp, $TMPDIR] (network access enabled)",
    "--------",
    "user",
    task,
    "codex",
    reply,
    "tokens used",
    "41,200",
    reply,
  ].join("\n");
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
}

/**
 * An {@link ApiClient} whose `whoami` is stubbed; its other method throws.
 *
 * Exactly the real interface. It used to carry `listTraces` and the registry's
 * reads as well, from before they moved off the client, and the trace tests
 * went on reading through a method the real client does not have — nothing
 * said so while `tsconfig.json` excluded `tests`. Setup reads traces through
 * {@link SetupApi.listTraces}, so that is where `traces` on {@link makeDeps}
 * serves them.
 */
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
    listWorkspaces: unsupported("listWorkspaces"),
  };
}

/** Trace rows, or a function called on every read so a test can count or throw. */
export type FakeTraces = unknown[] | (() => unknown[]);

/** A trace read that answers with `traces`, for a `TraceLister` or a {@link SetupApi}. */
export function listTracesFrom(traces: FakeTraces): SetupApi["listTraces"] {
  return async () => {
    const rows = typeof traces === "function" ? traces() : traces;
    // The REAL envelope from `PublicTraceListResponse` (openapi.json), not a
    // bare array. Returning the convenient shape here is what previously let a
    // response-unwrapping bug pass every test and still find zero traces
    // against the live API. Cast because a row carries only the fields the poll
    // reads (see `traceRow`), not the whole list item.
    return { data: rows, meta: { limit: rows.length } } as unknown as TraceList;
  };
}

/** A {@link SetupApi} where every method rejects unless overridden. */
export function fakeSetupApi(overrides: Partial<SetupApi> = {}): SetupApi {
  const reject = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected setup API call: ${name}`);
  };
  // No cast: a method `SetupApi` gains and this does not list fails to compile
  // here, rather than reaching a test as `undefined`.
  return {
    listTraces: reject("listTraces"),
    listWorkspaces: reject("listWorkspaces"),
    listProjects: reject("listProjects"),
    createProject: reject("createProject"),
    listApiKeys: reject("listApiKeys"),
    createApiKey: reject("createApiKey"),
    createProjectApiKey: reject("createProjectApiKey"),
    revokeApiKey: reject("revokeApiKey"),
    revokeProjectApiKey: reject("revokeProjectApiKey"),
    ...overrides,
  };
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
  /**
   * The setup API's account calls. Its trace read is always `traces`, so a
   * `listTraces` here could only be dead.
   */
  setupApi?: Omit<SetupApi, "listTraces">;
  /** What the setup API's trace read answers with; none by default. */
  traces?: FakeTraces;
  runProcess?: (o: RunProcessOptions) => Promise<RunProcessResult>;
  env?: NodeJS.ProcessEnv;
  answers?: string[];
  hiddenAnswers?: string[];
  sdk?: ResolvedSdk;
  onWriteConfig?: (config: { api_key: string; host_url: string }) => void;
  /** The CLI's config as an earlier run left it; none by default, as on a first run. */
  config?: { api_key?: string; host_url?: string } | null;
  tempDir?: string;
  /** Whether a local TraceRoot API answers, for the missing-endpoint hint. */
  localHostResponds?: boolean;
  /** A user credential already on disk for the host under test. */
  storedCredential?: CredentialEntry | null;
  onWriteCredential?: (host: string, entry: CredentialEntry) => void;
  onDeleteCredential?: (host: string) => boolean;
  /** Device-flow stubs. Default to a code that is approved on the first poll. */
  runDeviceFlow?: (deps: DeviceFlowDeps) => Promise<DeviceFlowResult>;
  /**
   * Handoff redemption. Unstubbed it throws, so a run that redeems without the
   * test saying what the server answers fails loudly rather than reaching the
   * network.
   */
  redeemHandoff?: (opts: HandoffRedeemOptions) => Promise<HandoffOutcome>;
  /**
   * Stands in for the user pressing Enter during the trace wait.
   *
   * `true` presses it as soon as the wait starts listening. Unset listens for a
   * key that never comes, which is what every test that is not about skipping
   * wants — and it must never reach `process.stdin`, which the real
   * implementation resumes.
   */
  skipTraceWait?: boolean;
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
    // The wizard polls for traces through the setup API, so that is what serves
    // `traces` — last, so the account half cannot replace it.
    createSetupApi: () => ({
      ...(options.setupApi ?? fakeSetupApi()),
      listTraces: listTracesFrom(options.traces ?? []),
    }),
    openBrowser: async () => true,
    // Consumes the same `answers` queue as the old text prompts: an entry may be
    // an option value, a 1-based index (how the numbered prompts were answered),
    // or empty to accept the default. Keeps existing tests meaningful.
    select: async ({ message, options, initialValue }) => {
      const answer = answers.shift();
      if (answer === undefined || answer === "") {
        const fallback = initialValue ?? options[0]?.value;
        if (fallback === undefined) {
          throw new Error(`a question with no options and no default: ${message}`);
        }
        return fallback;
      }
      const byValue = options.find((o) => o.value === answer);
      if (byValue !== undefined) {
        return byValue.value;
      }
      const index = Number.parseInt(answer, 10) - 1;
      return options[index]?.value ?? answer;
    },
    // Offered exactly as production offers it, and taken only when the test
    // says so. Returning a no-op stop function matters as much as the press:
    // the stage calls it in a `finally`, and a test that left a dangling
    // listener would be hiding the bug where the real one eats the keystroke
    // belonging to the closing acknowledgements.
    watchForSkip: (onSkip) => {
      if (options.skipTraceWait === true) {
        onSkip();
      }
      return () => undefined;
    },
    prompt: async () => answers.shift() ?? "",
    promptHidden: async () => hidden.shift() ?? "",
    resolveSdk: async () => options.sdk ?? TEST_SDK,
    writeConfig: options.onWriteConfig ?? (() => undefined),
    readConfig: () => options.config ?? null,
    // No file behind the config by default, so a rollback finds nothing to put back.
    readConfigText: () => null,
    restoreConfigText: () => undefined,
    sleep: async () => undefined,
    // A fresh directory per call, not a fixed path in the real `/tmp`. The
    // instrument stage deletes whatever this returns (`rmSync(tempDir,
    // { recursive: true, force: true })`), so one shared name means every
    // agent-launch test in the suite recursively deletes the same real
    // directory — a developer's own `/tmp/traceroot-setup-test` among them, and
    // each other's under a parallel run.
    makeTempDir: () => options.tempDir ?? mkdtempSync(join(tmpdir(), "traceroot-setup-test-")),
    probeHost: async () => options.localHostResponds ?? false,
    // Default: nothing stored, so tests exercise the browser/paste paths unless
    // they explicitly opt into a saved sign-in. Never touches a real home dir.
    readCredential: () => options.storedCredential ?? null,
    writeCredential: options.onWriteCredential ?? (() => undefined),
    deleteCredential: options.onDeleteCredential ?? (() => true),
    runDeviceFlow: options.runDeviceFlow ?? (async () => ({ sessionToken: "session-token-value" })),
    redeemHandoff:
      options.redeemHandoff ??
      (async () => {
        throw new Error("unexpected handoff redemption");
      }),
    // Refuses a missing token, because the real one sends it as the bearer and a
    // provider built from nothing can never sign anyone in. Accepting it let
    // every saved-sign-in test pass with the token `undefined`: their fixtures
    // spelled the field `sessionToken`, which `CredentialEntry` does not have,
    // and nothing noticed because `tsconfig.json` excludes `tests`.
    createTokenProvider: ({ sessionToken }) => {
      if (typeof sessionToken !== "string" || sessionToken === "") {
        throw new Error(
          `createTokenProvider was handed no session token (${String(sessionToken)})`,
        );
      }
      return {
        getAccessToken: async () => "access-jwt-value",
        invalidate: () => undefined,
      };
    },
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
