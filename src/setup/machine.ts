import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { displaySkillPath, requireAgent } from "../agents/index.js";
import { type ApiClient, type ApiClientOptions, createApiClient } from "../api/client.js";
import {
  BackendUnavailableError,
  type CreatedApiKey,
  type ProjectSummary,
  type SetupApi,
  SetupApiError,
  createSetupApi,
} from "../api/setup.js";
import {
  type CredentialEntry,
  deleteCredential,
  readCredential,
  writeCredential,
} from "../auth/credentials.js";
import {
  type DeviceFlowDeps,
  type DeviceFlowResult,
  openBrowserForPlatform,
  runDeviceFlow,
} from "../auth/deviceFlow.js";
import {
  type TokenProvider,
  type TokenProviderOptions,
  createTokenProvider,
  decodeJwtClaims,
} from "../auth/token.js";
import { DEFAULT_HOST } from "../commands/constants.js";
import { loadOptionalEnvFileFromDisk } from "../config/envFile.js";
import { writeConfig as realWriteConfig } from "../config/manager.js";
import { type ResolvedAuth, normalizeApiKey } from "../config/resolve.js";
import type { Writers } from "../output.js";
import type { Prompt } from "../prompt.js";
import { bundledSkillDir } from "../skills/bundled.js";
import { installBundledSkill } from "../skills/install.js";
import { sleep } from "../util/sleep.js";
import { createActivityParser } from "./activity.js";
import { detectAgents, selectAgent } from "./agents.js";
import { relativeToRoot } from "./artifacts.js";
import { hasCompleted, markComplete, writeCheckpoint } from "./checkpoint.js";
import { ensureIgnored, upsertEnvFile } from "./envWrite.js";
import { SetupError, backendUnsupported } from "./errors.js";
import type { RunProcess } from "./exec.js";
import { changedSince, readGitState } from "./git.js";
import { buildInvocation, launchAgent } from "./launch.js";
import { detectEnvFiles, detectPythonEnvironment } from "./python.js";
import { writeSetupReport } from "./report.js";
import {
  type ImportCheck,
  type ResolvedSdk,
  type SdkPackage,
  importCheck,
  installCommand,
  resolveSdkVersion,
  sdkPackageFor,
} from "./sdk.js";
import { type Secret, makeSecret } from "./secret.js";
import { type SelectFn, interactiveSelect } from "./select.js";
import { startLineSpinner } from "./spinner.js";
import { detectStack, normalizeLanguage } from "./stack.js";
import { buildSetupTask, manualInstructions, parseCompletion } from "./task.js";
import { pollForTrace } from "./trace.js";
import { discardTypeAhead } from "./tty.js";
import type {
  DetectedAgent,
  DetectedService,
  DetectedStack,
  InstrumentMethod,
  ProjectCredential,
  ProjectSelection,
  SetupContext,
  SetupResult,
  SetupStage,
  SetupStageOutcome,
  SetupStageStatus,
  StackLanguage,
} from "./types.js";
import { verifyApplication } from "./verify.js";
import {
  wizardAside,
  wizardEmphasis,
  wizardLine,
  wizardMutedLink,
  wizardNote,
  wizardProgress,
  wizardStepLine,
  wizardValue,
  wizardWarn,
} from "./wizard.js";

/** The environment variable an instrumented application reads its key from. */
const KEY_ENV = "TRACEROOT_API_KEY";
const HOST_ENV = "TRACEROOT_HOST_URL";
/**
 * Credentials are written here — never to `.env`, which is often committed.
 *
 * Named after this tool rather than after Next.js. `.env.local` is a framework
 * convention, which means it is a file the user's own project
 * may already own and already load: setup appending a credential to it puts our
 * value into their file, and a rerun has no way to tell which lines are ours.
 * `.env.traceroot` belongs to us, says so, and collides with nothing.
 */
const ENV_FILE = ".env.traceroot";
const SKILL_NAME = "traceroot-instrument-repo";

/**
 * Every side-effecting collaborator the machine needs, injected rather than
 * imported at the call site. This is the pattern the CLI's existing commands
 * already use (`RunDoctorDeps`, `RunInstrumentDeps`), and it is what makes the
 * whole flow — browser polling, agent launching, test running, trace polling —
 * runnable offline in a unit test with no module mocking.
 */
export interface SetupDeps {
  resolvedAuth: ResolvedAuth;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  runProcess: RunProcess;
  createClient: (opts: ApiClientOptions) => ApiClient;
  createSetupApi: (opts: {
    host: string;
    apiKey?: string;
    tokenProvider?: TokenProvider;
    timeoutMs?: number;
  }) => SetupApi;
  /** Returns false when the browser could not be opened; the URL is still printed. */
  openBrowser: (url: string) => Promise<boolean>;
  prompt: Prompt;
  promptHidden: (question: string) => Promise<string>;
  resolveSdk: (pkg: SdkPackage) => Promise<ResolvedSdk>;
  writeConfig: (config: { api_key: string; host_url: string }) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Interactive single choice; injected so stages stay testable without a TTY. */
  select: SelectFn;
  /** Temp directory for the agent task; removed when the run ends. */
  makeTempDir: () => string;
  /**
   * Probes a candidate host for a TraceRoot API. Used ONLY to turn a dead-end
   * error into an actionable one — never to pick a host on the user's behalf.
   */
  probeHost: (host: string) => Promise<boolean>;
  /** The user-scoped CLI token store, keyed by host. */
  readCredential: (host: string) => CredentialEntry | null;
  writeCredential: (host: string, entry: CredentialEntry) => void;
  deleteCredential: (host: string) => boolean;
  /**
   * The shared RFC 8628 device flow. Owned by `src/auth/`, so `setup` and
   * `login` sign a user in the same way rather than each having its own.
   */
  runDeviceFlow: (deps: DeviceFlowDeps) => Promise<DeviceFlowResult>;
  createTokenProvider: (opts: TokenProviderOptions) => TokenProvider;
}

/** Production wiring. */
export function defaultSetupDeps(resolvedAuth: ResolvedAuth): SetupDeps {
  return {
    resolvedAuth,
    env: process.env,
    now: () => new Date(),
    runProcess: (options) => import("./exec.js").then((m) => m.runProcess(options)),
    createClient: createApiClient,
    createSetupApi: (opts) =>
      createSetupApi({
        host: opts.host,
        apiKey: opts.apiKey,
        tokenProvider: opts.tokenProvider,
        timeoutMs: opts.timeoutMs,
      }),
    // The device flow's own opener, not a second one. Setup's copy claimed to
    // launch detached and then waited on a captured child with a 10s timeout,
    // and it reached for `cmd /c start` on Windows — the form `deviceFlow`
    // avoids because cmd.exe re-parses its command line. Nothing ever read the
    // captured output: the only consumer treats the boolean as "say the URL out
    // loud as well", so there was nothing to keep.
    openBrowser: openBrowserForPlatform,
    // Both readline prompts drain first, for the same reason every `select`
    // does (see `discardTypeAhead`). The two closing acknowledgements are
    // consecutive questions with a block of prose between them, so a spare
    // Enter at the first scrolls the second past a user who never read it.
    prompt: async (question) => {
      await discardTypeAhead(process.stdin);
      return (await import("../prompt.js")).readLine(question);
    },
    promptHidden: async (question) => {
      const { createInterface } = await import("node:readline");
      await discardTypeAhead(process.stdin);
      return new Promise((resolve) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });
        const mutable = rl as unknown as { _writeToOutput?: (s: string) => void };
        const original = mutable._writeToOutput?.bind(rl);
        mutable._writeToOutput = (chunk: string): void => {
          if (chunk.includes(question)) {
            original?.(chunk);
          } else {
            process.stdout.write("*");
          }
        };
        rl.question(question, (answer) => {
          rl.close();
          process.stdout.write("\n");
          resolve(answer);
        });
      });
    },
    resolveSdk: (pkg) => resolveSdkVersion(pkg),
    writeConfig: realWriteConfig,
    sleep,
    select: interactiveSelect,
    makeTempDir: () => mkdtempSync(join(tmpdir(), "traceroot-setup-")),
    readCredential: (host) => readCredential(host),
    writeCredential: (host, entry) => writeCredential(host, entry),
    deleteCredential: (host) => deleteCredential(host),
    runDeviceFlow: (deviceDeps) => runDeviceFlow(deviceDeps),
    createTokenProvider: (opts) => createTokenProvider(opts),
    probeHost: async (candidate) => {
      try {
        // Any HTTP answer means something is listening and speaking this API's
        // shape; a 401 is the expected reply to an unauthenticated whoami.
        const res = await fetch(`${candidate}/api/v1/public/whoami`, {
          signal: AbortSignal.timeout(1500),
        });
        return res.status > 0;
      } catch {
        return false;
      }
    },
  };
}

/** One stage: a satisfaction predicate plus the work. */
interface StageDefinition {
  stage: SetupStage;
  /** True when this run has already established the stage's output. */
  isSatisfied(ctx: SetupContext, deps: SetupDeps): boolean;
  run(ctx: SetupContext, deps: SetupDeps): Promise<SetupStageStatus>;
  /**
   * Rehydrates this stage's output from the checkpoint on `--resume`.
   *
   * Only stages whose work is *durable* implement this. Authentication, project
   * selection and stack detection deliberately do not: their outputs live in
   * memory and are needed by later stages, and re-establishing them is cheap and
   * safer than trusting a stale record. Instrumentation, by contrast, has
   * already edited the repository — re-running an agent over an
   * already-instrumented service is exactly the duplicate work the whole flow is
   * built to avoid.
   */
  restore?(ctx: SetupContext): void;
}

/** Errors that mean "these credentials are wrong", as opposed to "the network is down". */
function isAuthRejection(err: unknown): boolean {
  // A real status beats sniffing a message. The regex below stays for the
  // clients that only ever surface a string (`whoami`, transport errors), but
  // anything that knows its status should be judged on it.
  if (err instanceof SetupApiError) {
    return err.status === 401 || err.status === 403;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /401|403|unauthor|invalid api key|forbidden/i.test(message);
}

/** Whether the credential resolved from an explicit, user-controlled source. */
function isExplicitSource(source: ResolvedAuth["credential"]["source"]): boolean {
  return source === "flag" || source === "env" || source === "env-file";
}

// ── PRECHECK ────────────────────────────────────────────────────────────────

const precheck: StageDefinition = {
  stage: "precheck",
  isSatisfied: () => false, // always re-read: the worktree may have changed
  async run(ctx, deps) {
    const git = await readGitState({ cwd: ctx.cwd, runProcess: deps.runProcess, env: deps.env });
    ctx.inGitRepo = git.inRepo;
    if (git.root !== null) {
      ctx.root = git.root;
    }
    // Stashed on the context so INSTRUMENT can diff against it afterwards and
    // report what the agent actually changed, rather than what it claims.
    baselineChanges.set(ctx, git.changedFiles);

    if (!git.inRepo) {
      wizardWarn(
        ctx,
        "not inside a git repository — an agent will edit files in this directory with no version control to fall back on",
      );
    } else if (git.dirty) {
      await confirmDirtyWorktree(ctx, deps, git.changedFiles);
    }
    return "ok";
  },
};

/** Longest list of pre-existing changes shown before it is summarised. */
const MAX_LISTED_CHANGES = 10;

/**
 * Asks whether to proceed over uncommitted work, and defaults to no.
 *
 * Setup is about to point a coding agent at this repository. Afterwards, `git
 * diff` is the only way to see what it did — and if the worktree was already
 * dirty, that diff is a mixture of the agent's edits and the user's own,
 * impossible to separate and impossible to revert selectively. A warning is not
 * enough for that: it scrolls past, and by the time it matters the run is over.
 *
 * The default is No because the safe answer costs one `git stash` and the unsafe
 * one costs an afternoon untangling a diff. This is the one place in the flow
 * where the recommended answer is to stop.
 *
 * Unattended runs are deliberately unchanged. A blocking prompt in CI is a hang
 * with nothing in the log to explain it, and an unsupervised run was never going
 * to have anyone read the diff anyway — it warns and proceeds, as before.
 */
async function confirmDirtyWorktree(
  ctx: SetupContext,
  deps: SetupDeps,
  changedFiles: readonly string[],
): Promise<void> {
  if (!ctx.canPrompt) {
    wizardProgress(
      ctx,
      `Worktree has ${changedFiles.length} uncommitted change(s); they will be left exactly as they are.`,
    );
    return;
  }

  const shown = changedFiles.slice(0, MAX_LISTED_CHANGES);
  const remaining = changedFiles.length - shown.length;
  wizardNote(
    ctx.writers,
    [
      "Git changes detected. This repository already has local changes:",
      "",
      ...shown.map((path, index) => `${index + 1}. ${path}`),
      ...(remaining > 0 ? [`… and ${remaining} more`] : []),
    ],
    // The paths are context for the question, not the question. Dimming them
    // keeps the sentence that matters at full contrast.
    { dimFrom: 1 },
  );

  const answer = await deps.select({
    stage: "precheck",
    // The whole question in one place. Split across a note and a bare
    // "Continue?", the reason to care scrolled away from the thing being asked.
    //
    // Only the question is bold. Keeping the whole sentence at one weight made
    // a paragraph out of a prompt: the explanation is what the user reads once,
    // the question is what they answer, and the eye needs to be able to find
    // the second without re-reading the first. So the ask is bold and the
    // reasoning is left plain.
    message: `Setup can continue, but its edits will be mixed with these changes. ${wizardEmphasis("Continue?")}`,
    options: [
      { value: "no", label: "No", hint: "cancel setup and close the wizard" },
      { value: "yes", label: "Yes", hint: "mix setup's edits with these changes" },
    ],
    initialValue: "no",
  });

  if (answer !== "yes") {
    // Exit 0. Declining a question the tool asked is a decision, not a fault,
    // and a non-zero code here would make a deliberate stop look like a bug to
    // every script that wraps this command.
    throw new SetupError({
      stage: "precheck",
      code: "CANCELLED",
      message: "Setup cancelled — the repository has uncommitted changes.",
      remedy: "Commit or stash them, then rerun `traceroot setup`.",
    });
  }
}

/** Per-run baseline of changed files, keyed by context (no global state). */
const baselineChanges = new WeakMap<SetupContext, string[]>();

// ── AUTHENTICATE ────────────────────────────────────────────────────────────

/**
 * The resolved credential, but only when it is a project API key.
 *
 * A session credential lives in the same slot and is useless to the paths that
 * want a key — they hand it to `whoami` or write it into `.env.traceroot`, and
 * neither means anything for a session token.
 */
function apiKeyFrom(auth: SetupDeps["resolvedAuth"]): string | undefined {
  return auth.credential.kind === "api-key" ? auth.credential.value : undefined;
}

const authenticate: StageDefinition = {
  stage: "authenticate",
  isSatisfied: (ctx) => ctx.session !== undefined,
  async run(ctx, deps) {
    const host = deps.resolvedAuth.hostUrl.value ?? DEFAULT_HOST;
    const existing = apiKeyFrom(deps.resolvedAuth);

    if (existing !== undefined && existing !== "") {
      const client = deps.createClient({
        host,
        auth: { kind: "api-key", key: existing },
        timeoutMs: 15_000,
      });
      try {
        const who = await client.whoami();
        ctx.session = {
          host: who.host === "" ? host : host,
          uiBaseUrl: who.ui_base_url,
          userKey: makeSecret(existing),
          workspaceId: who.workspace_id,
          workspaceName: who.workspace_name,
          via: isExplicitSource(deps.resolvedAuth.credential.source)
            ? deps.resolvedAuth.credential.source === "flag"
              ? "flag"
              : "env"
            : "existing-config",
        };
        // The key already implies a project (TraceRoot keys are project-scoped
        // today), so record it as the default selection. SELECT_CONTEXT may
        // still override it from `--project`.
        ctx.project = {
          projectId: who.project_id,
          projectName: who.project_name ?? who.project_id,
          workspaceId: who.workspace_id,
          origin: "from-whoami",
        };
        ctx.checkpoint.host = host;
        ctx.checkpoint.uiBaseUrl = who.ui_base_url;
        ctx.checkpoint.workspaceId = who.workspace_id;
        recordProject(ctx);
        // Every way into this stage now opens with its own sentence, because
        // the generic "Sign in to TraceRoot" heading is gone. Without one this
        // path — the fastest of the four — would pass in silence, and a step
        // that prints nothing reads as a step that failed to print.
        wizardNote(
          ctx.writers,
          [
            wizardEmphasis("Signed in with the TraceRoot credential already configured."),
            "",
            wizardAside(`Workspace ${who.workspace_name ?? who.workspace_id} — no browser needed.`),
          ],
          { settled: true },
        );
        return "ok";
      } catch (err) {
        if (!isAuthRejection(err)) {
          // A credential that cannot be *verified* is not the same as a
          // credential that is wrong. Replacing it here would destroy working
          // configuration because the network happened to be down.
          throw new SetupError({
            stage: "authenticate",
            code: "UNSAFE_OVERWRITE",
            message: `Could not reach ${host} to verify the existing TraceRoot credential, so setup stopped rather than replacing it.`,
            remedy: "Check your connection and rerun `traceroot setup`.",
          });
        }
        wizardWarn(ctx, "the existing TraceRoot credential was rejected; signing in again");
      }
    }

    // A stored credential means this user already signed in on this machine, so
    // there is nothing to prove again. Tried before the browser handoff because
    // skipping it is the entire reason the credential is kept.
    const stored = deps.readCredential(host);
    // A configured `TRACEROOT_TOKEN` is the same kind of credential as a saved
    // login, so it drives the same sign-in: without this it was resolved, ignored,
    // and the run failed NOT_AUTHENTICATED with a usable token in hand.
    const resolved = deps.resolvedAuth.credential;
    const entry: CredentialEntry | null =
      stored ??
      (resolved.kind === "session" && resolved.value !== undefined
        ? { session_token: resolved.value, created_at: deps.now().toISOString() }
        : null);
    if (entry !== null) {
      const signedIn = await userCredentialSignIn(ctx, deps, host, entry, {
        announce: true,
        persisted: stored !== null,
      });
      if (signedIn) {
        return "ok";
      }
      // The credential was rejected; fall through and sign in properly.
    }

    if (ctx.flags.browser && ctx.canPrompt) {
      return await browserSignIn(ctx, deps, host);
    }

    if (!ctx.canPrompt) {
      throw new SetupError({
        stage: "authenticate",
        code: "NOT_AUTHENTICATED",
        message: "No TraceRoot credential is configured and setup cannot prompt for one.",
        remedy: [
          "Provide a key non-interactively:",
          "  traceroot setup --api-key <key>",
          "or set TRACEROOT_API_KEY, or run `traceroot login` first.",
        ].join("\n"),
      });
    }

    // `--no-browser`: the paste path, which is also today's `login` behaviour.
    wizardNote(
      ctx.writers,
      [
        wizardEmphasis("Sign in to continue the setup. Paste a TraceRoot API key below."),
        "",
        wizardAside("What you type is not echoed."),
      ],
      { settled: true },
    );
    // Normalised, not merely trimmed. The interface hands the user
    // `TRACEROOT_API_KEY="tr-…"` to copy, and this is the one prompt whose whole
    // purpose is taking that paste — so the wrapper the flags, environment and
    // config all tolerate has to be tolerated here too, or the server answers
    // `Invalid API key` for a key that is perfectly valid. Before the empty
    // check, so pasting a bare `TRACEROOT_API_KEY=` is caught here rather than
    // sent.
    const pasted = normalizeApiKey(await deps.promptHidden("TraceRoot API key: "));
    if (pasted === "") {
      throw new SetupError({
        stage: "authenticate",
        code: "NOT_AUTHENTICATED",
        message: "No API key was entered.",
      });
    }
    const client = deps.createClient({
      host,
      auth: { kind: "api-key", key: pasted },
      timeoutMs: 15_000,
    });
    const who = await client.whoami();
    deps.writeConfig({ api_key: pasted, host_url: host });
    ctx.session = {
      host,
      uiBaseUrl: who.ui_base_url,
      userKey: makeSecret(pasted),
      workspaceId: who.workspace_id,
      workspaceName: who.workspace_name,
      via: "pasted-key",
    };
    ctx.project = {
      projectId: who.project_id,
      projectName: who.project_name ?? who.project_id,
      workspaceId: who.workspace_id,
      origin: "from-whoami",
    };
    ctx.checkpoint.host = host;
    ctx.checkpoint.uiBaseUrl = who.ui_base_url;
    ctx.checkpoint.workspaceId = who.workspace_id;
    recordProject(ctx);
    return "ok";
  },
};

/** Hosts checked when the default deployment turns out not to support setup. */
const LOCAL_HOST_CANDIDATES = ["http://localhost:8000", "http://localhost:3000"];

/**
 * Builds the remedy for "this deployment cannot do browser sign-in".
 *
 * When the CLI fell back to the default host and a TraceRoot API is answering
 * on a local port, the overwhelmingly likely truth is that the developer meant
 * their own stack — so the message names it and gives the exact command. It
 * still never switches hosts on its own: silently retargeting where a
 * credential gets minted is precisely the kind of helpfulness nobody wants from
 * a security-adjacent tool.
 */
async function signInFallbackHint(host: string, deps: SetupDeps): Promise<string> {
  const lines: string[] = [];

  if (host === DEFAULT_HOST) {
    for (const candidate of LOCAL_HOST_CANDIDATES) {
      if (await deps.probeHost(candidate)) {
        lines.push(
          `A TraceRoot API is responding at ${candidate} — if that is your deployment, use it:`,
          `  traceroot setup --host ${candidate}`,
          "",
        );
        break;
      }
    }
  }

  lines.push(
    "If you meant a different deployment, point the CLI at it:",
    "  traceroot setup --host <url>        (or set TRACEROOT_HOST_URL)",
    "",
    "Otherwise sign in with a key instead:",
    "  traceroot setup --no-browser",
    "or set TRACEROOT_API_KEY before running setup.",
  );
  return lines.join("\n");
}

/**
 * A {@link Writers} whose stderr lands on the wizard's rail.
 *
 * The shared device flow narrates itself — the code to confirm, the URL, the
 * wait — and it does so with `logInfo`, which writes bare lines to stderr. Bare
 * lines would fall outside the frame this command has drawn around everything
 * else. Rather than reimplement the flow to get control of its output, or
 * duplicate its wording here and drift from `login`, its lines are intercepted
 * and re-emitted on the rail.
 */
function railWriters(ctx: SetupContext): Writers {
  let pending = "";
  const emit = (line: string): void => {
    if (line.trim() === "") {
      return;
    }
    // A URL on its own line is a link; everything else is prose.
    const url = /^Open (https?:\/\/\S+)$/.exec(line)?.[1];
    wizardLine(ctx, url === undefined ? line : wizardMutedLink(url));
  };
  return {
    out: ctx.writers.out,
    err: {
      write(chunk: string): boolean {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          emit(line);
        }
        return true;
      },
    },
  };
}

/**
 * The browser handoff.
 *
 * The flow itself belongs to `src/auth/deviceFlow.ts`, shared with `login`, so
 * a user signs in exactly one way whichever command they reached first. This
 * function supplies the wizard's framing around it and decides what to do with
 * what comes back.
 *
 * What comes back is identity and nothing else. Choosing a project and minting
 * its key are the same work a returning user's run does, so this hands off to
 * `userCredentialSignIn` rather than duplicating it — the two paths differ only
 * in how the credential was obtained.
 */
async function browserSignIn(
  ctx: SetupContext,
  deps: SetupDeps,
  host: string,
): Promise<SetupStageStatus> {
  // Device login and token mint talk to the app, which is not always the API
  // host — a split local stack runs them on different ports.
  const authHost = deps.resolvedAuth.authHost.value ?? host;

  // Said before the flow narrates itself, because "Continue in your browser" is
  // the instruction and everything the flow prints is detail underneath it.
  // "Continue", not "Sign in": a user with no account reads "sign in" as a
  // precondition they do not meet, and the CLI cannot know which they are —
  // detecting account existence would be an email-enumeration oracle.
  wizardNote(
    ctx.writers,
    [
      wizardEmphasis("Continue in your browser to finish setup."),
      "",
      wizardAside("Sign in — or create a free account — and approve this terminal."),
    ],
    { settled: true },
  );

  let credential: DeviceFlowResult;
  try {
    credential = await deps.runDeviceFlow({
      authHost,
      writers: railWriters(ctx),
      openBrowser: deps.openBrowser,
      env: deps.env,
    });
  } catch (err) {
    // A deployment that does not serve the device endpoints at all is a
    // different problem from a sign-in that failed, and it has a different
    // answer: you are probably pointed at the wrong host. The shared flow
    // reports the status in its message rather than as a field, so that is what
    // there is to match on.
    const message = err instanceof Error ? err.message : String(err);
    if (/\(status (?:404|501)\)/.test(message)) {
      throw backendUnsupported(
        "authenticate",
        "Browser sign-in",
        await signInFallbackHint(host, deps),
        host,
      );
    }
    // Names the branch a first-time user is most likely on. "Sign-in did not
    // complete" tells someone halfway through creating an account nothing about
    // what to do next, and the answer — finish verifying, run it again — is not
    // guessable from it.
    wizardWarn(
      ctx,
      "Setup didn't complete in the browser. If you were creating an account, verify your email and run `traceroot setup` again.",
    );
    throw err;
  }

  // Mint once, to learn who signed in. `whoami` is API-key-only server-side, so
  // the access token's `email` claim is the only identity a user credential
  // has. Best-effort: a mint failure here costs a display name, not a run.
  let email: string | undefined;
  try {
    const jwt = await deps
      .createTokenProvider({ authHost, sessionToken: credential.sessionToken })
      .getAccessToken();
    const claims = decodeJwtClaims(jwt);
    const claimed = claims?.email;
    email = typeof claimed === "string" && claimed !== "" ? claimed : undefined;
  } catch {
    // Nothing to say: the credential is good enough to continue with, and the
    // next call will surface a real problem if there is one.
  }

  // Keep the credential. This is the only moment it is available, and storing
  // it is what lets the next repository skip this handoff. A failure to store
  // must not fail a sign-in that otherwise worked — the cost is one more
  // browser trip later.
  const entry: CredentialEntry = {
    session_token: credential.sessionToken,
    created_at: deps.now().toISOString(),
  };
  if (authHost !== host) {
    entry.auth_host = authHost;
  }
  if (email !== undefined) {
    entry.email = email;
  }
  try {
    deps.writeCredential(host, entry);
  } catch {
    wizardWarn(ctx, "could not save the TraceRoot sign-in for future runs");
  }

  wizardNote(
    ctx.writers,
    [wizardStepLine(email === undefined ? "Signed in." : `Signed in as ${wizardValue(email)}.`)],
    { settled: true },
  );

  const signedIn = await userCredentialSignIn(ctx, deps, host, entry, { announce: false });
  if (!signedIn) {
    throw new SetupError({
      stage: "authenticate",
      code: "NOT_AUTHENTICATED",
      message: "The credential from browser sign-in was rejected immediately.",
      remedy: "Run `traceroot setup` again.",
    });
  }
  return "ok";
}

/**
 * Sign-in from a user credential — one just obtained in the browser, or one
 * already on disk from a previous run.
 *
 * Produces the state every later stage expects: session, project and project
 * credential all settled, so the stages after this one see a finished
 * authentication regardless of which path reached it.
 *
 * The credential is a session token, and it is never sent to the API. It buys a
 * ten-minute access JWT from the mint route, and the API client re-mints on its
 * own as the run outlives each one.
 *
 * Returns false when the credential turns out not to work, so the caller can
 * fall back to the browser. That is the *only* failure treated as recoverable:
 * an expired or revoked session is an ordinary thing that should cost the user
 * one extra sign-in, whereas an ambiguous project or a refused mint is a real
 * decision they need to see.
 */
async function userCredentialSignIn(
  ctx: SetupContext,
  deps: SetupDeps,
  host: string,
  stored: CredentialEntry,
  options: {
    /**
     * Whether to announce a skipped browser. False on the path that just used
     * one — saying "no browser needed" directly under a browser handoff reads
     * as a contradiction.
     */
    announce: boolean;
    /**
     * Whether the credential came off disk. A rejected environment token must not
     * be "deleted" — there is nothing to delete — and calling it a saved sign-in
     * that expired would be wrong.
     */
    persisted?: boolean;
    /**
     * Set when the caller already established which workspace this is for.
     * Without it the server refuses to guess across several workspaces.
     */
    workspaceId?: string;
  } = { announce: true },
): Promise<boolean> {
  // Reads go to the API host; the mint goes to the app. A split local stack
  // runs them on different ports, and the stored entry remembers which.
  const authHost = stored.auth_host ?? deps.resolvedAuth.authHost.value ?? host;
  const tokenProvider = deps.createTokenProvider({
    authHost,
    sessionToken: stored.session_token,
  });
  const api = deps.createSetupApi({ host, tokenProvider });

  let projects: ProjectSummary[];
  try {
    projects = await api.listProjects(options.workspaceId);
  } catch (err) {
    if (isAuthRejection(err)) {
      // Forget it now: a credential known not to work would otherwise cost a
      // wasted round trip on every future run. The shared token provider raises
      // an auth-class error for a revoked or expired session, which is exactly
      // this case.
      if (options.persisted !== false) {
        deps.deleteCredential(host);
        wizardWarn(ctx, "the saved TraceRoot sign-in has expired; signing in again");
      } else {
        wizardWarn(ctx, "the configured TraceRoot token was rejected; signing in again");
      }
      return false;
    }
    if (err instanceof BackendUnavailableError) {
      // A deployment that predates account-scope listing. Not a broken session.
      return false;
    }
    throw err;
  }

  if (options.announce) {
    // Said here rather than at the end of this function. With no generic stage
    // heading above it, a returning user's very first sight of this stage would
    // otherwise be a bare "Which project should receive these traces?" — a
    // question with nothing above it saying which section of the run it belongs
    // to.
    wizardNote(ctx.writers, [wizardEmphasis("Signed in as a returning user. No browser needed.")], {
      settled: true,
    });
  }

  const chosen = await chooseProject(ctx, deps, api, projects, "authenticate", options.workspaceId);

  const created = await mintProjectKey(ctx, deps, api, chosen.project.projectId);
  const key = makeSecret(created.key);

  // Verify before persisting, exactly as the browser path does. `whoami` is
  // also where `ui_base_url` comes from — the deployment's own answer for where
  // trace links live, which nothing else on this path knows.
  const who = await deps
    .createClient({ host, auth: { kind: "api-key", key: key.reveal() }, timeoutMs: 15_000 })
    .whoami();

  deps.writeConfig({ api_key: created.key, host_url: host });

  ctx.session = {
    host,
    uiBaseUrl: who.ui_base_url,
    userKey: key,
    workspaceId: chosen.project.workspaceId,
    workspaceName: who.workspace_name,
    via: "user-credential",
  };
  ctx.project = {
    ...chosen.project,
    // "settled during authentication", which is what actually happened, and
    // which stops SELECT_CONTEXT from asking again.
    origin: "from-session",
  };
  ctx.credential = {
    key,
    keyId: created.id,
    keyName: created.name,
    projectId: chosen.project.projectId,
    expiresAt: created.expires_at,
    origin: "minted",
  };
  ctx.checkpoint.host = host;
  ctx.checkpoint.uiBaseUrl = who.ui_base_url;
  ctx.checkpoint.workspaceId = chosen.project.workspaceId;
  ctx.checkpoint.projectKeyId = created.id;
  ctx.checkpoint.projectKeyHint = key.hint;
  recordProject(ctx);

  wizardProgress(ctx, `Project ${chosen.project.projectName}.`);
  return true;
}

/**
 * Mints this repository's key, naming it after the repository.
 *
 * A name collision means setup already ran here. The old key's secret is
 * unrecoverable by design, so there is nothing to reuse — the only options are
 * to mint a distinguishable sibling or to fail a rerun outright, and failing a
 * rerun would be absurd. The suffix is the run date, which keeps the key list
 * readable rather than filling it with opaque ids.
 */
async function mintProjectKey(
  ctx: SetupContext,
  deps: SetupDeps,
  api: SetupApi,
  projectId: string,
): Promise<CreatedApiKey> {
  const base = `traceroot-${basename(ctx.root)}`;
  const mint = (name: string) =>
    api.createProjectApiKey({
      projectId,
      name,
      // The CLI reads traces back to verify the first one arrived, which an
      // ingest-only key cannot do.
      scope: "admin",
      expiresInDays: null,
    });

  try {
    return await mint(base);
  } catch (err) {
    if (!isNameConflict(err)) {
      throw err;
    }
    return await mint(`${base}-${deps.now().toISOString().slice(0, 10)}`);
  }
}

/** A 409 from the key-minting route: the name is taken. */
function isNameConflict(err: unknown): boolean {
  return err instanceof SetupApiError && err.status === 409;
}

// ── SELECT_CONTEXT ──────────────────────────────────────────────────────────

const selectContext: StageDefinition = {
  stage: "select_context",
  isSatisfied: (ctx) =>
    ctx.project !== undefined &&
    (ctx.project.origin === "from-session" || ctx.flags.project === undefined),
  async run(ctx, deps) {
    const session = requireSession(ctx);
    const wanted = ctx.flags.project;
    const api = deps.createSetupApi({ host: session.host, apiKey: session.userKey.reveal() });

    let projects: Awaited<ReturnType<SetupApi["listProjects"]>>;
    try {
      projects = await api.listProjects();
    } catch (err) {
      if (!(err instanceof BackendUnavailableError)) {
        throw err;
      }
      // No projects API on this deployment. The credential already resolves to
      // exactly one project, which is the only honest answer available.
      if (ctx.project === undefined) {
        throw backendUnsupported(
          "select_context",
          "Project selection",
          "Use a project-scoped API key: `traceroot setup --api-key <project key>`.",
        );
      }
      if (
        wanted !== undefined &&
        wanted !== ctx.project.projectId &&
        wanted !== ctx.project.projectName
      ) {
        throw backendUnsupported(
          "select_context",
          `Selecting the project '${wanted}'`,
          `This deployment resolves the project from the API key. Use a key scoped to '${wanted}', or drop --project.`,
        );
      }
      wizardProgress(ctx, `Project: ${ctx.project.projectName} (from the API key)`);
      recordProject(ctx);
      return "skipped";
    }

    const chosen = await chooseProject(ctx, deps, api, projects, "select_context");
    ctx.project = { ...chosen.project, origin: chosen.origin };
    recordProject(ctx);
    return "ok";
  },
};

/**
 * Resolves which workspace a new project belongs in.
 *
 * Only reached when the account has no projects yet, which is the one case the
 * caller cannot answer from a project list. One workspace is used without
 * asking; several are offered; none is a real dead end and says so.
 *
 * Workspaces the user can only view are filtered out — offering a destination
 * the server will refuse with a 403 wastes the question. If that leaves nothing,
 * the message says the account has no workspace they can create in, which is
 * the actual problem.
 */
async function chooseWorkspace(
  ctx: SetupContext,
  deps: SetupDeps,
  api: SetupApi,
  stage: SetupStage,
): Promise<string> {
  const workspaces = (await api.listWorkspaces()).filter((w) => w.role.toLowerCase() !== "viewer");

  const only = workspaces[0];
  if (only === undefined) {
    throw new SetupError({
      stage,
      code: "AMBIGUOUS",
      message: "This account has no workspace you can create a project in.",
      remedy: "Ask a workspace admin for access, or create a workspace in the TraceRoot dashboard.",
    });
  }
  if (workspaces.length === 1) {
    return only.id;
  }

  if (!ctx.canPrompt) {
    throw new SetupError({
      stage,
      code: "AMBIGUOUS",
      message: `You belong to ${workspaces.length} workspaces, so setup cannot pick one for you.`,
      remedy: `Create the project in the TraceRoot dashboard and rerun with --project, for example:\n  traceroot setup --project ${basename(ctx.root)}`,
    });
  }

  const answer = await deps.select({
    stage,
    message: "Which workspace should this project live in?",
    options: workspaces.map((w) => ({ value: w.id, label: w.name })),
  });
  return workspaces.find((w) => w.id === answer)?.id ?? only.id;
}

/**
 * Picks the project a repository will report to, given everything the caller
 * can already see.
 *
 * Shared by both sign-in paths because the decision is identical whichever
 * credential got us the list: honour `--project`, take the only one if there is
 * only one, offer a choice when a human is present, and refuse to guess when
 * one is not. The `stage` parameter exists so the error blames the stage the
 * user is actually in.
 */
async function chooseProject(
  ctx: SetupContext,
  deps: SetupDeps,
  api: SetupApi,
  projects: readonly ProjectSummary[],
  stage: SetupStage,
  /** Where a newly created project goes, when the caller already knows. */
  workspaceId?: string,
): Promise<{
  project: { projectId: string; projectName: string; workspaceId: string };
  origin: ProjectSelection["origin"];
}> {
  const wanted = ctx.flags.project;

  const summarize = (p: ProjectSummary) => ({
    projectId: p.project_id,
    projectName: p.project_name,
    workspaceId: p.workspace_id,
  });

  if (wanted !== undefined) {
    const match = projects.find((p) => p.project_id === wanted || p.project_name === wanted);
    if (match === undefined) {
      throw new SetupError({
        stage,
        code: "AMBIGUOUS",
        message: `No project named '${wanted}' was found in this workspace.`,
        remedy:
          projects.length === 0
            ? "Create one in the TraceRoot dashboard, then rerun setup."
            : `Available projects: ${projects.map((p) => p.project_name).join(", ")}`,
      });
    }
    return { project: summarize(match), origin: "from-flag" };
  }

  const first = projects[0];

  if (projects.length === 1 && first !== undefined) {
    return { project: summarize(first), origin: "existing" };
  }

  if (first === undefined) {
    if (!ctx.canPrompt) {
      throw new SetupError({
        stage,
        code: "AMBIGUOUS",
        message: "This workspace has no projects yet.",
        remedy: "Create one with `traceroot setup --project <name>` in an interactive terminal.",
      });
    }
    // Which workspace to create it in. The caller supplies one only when it
    // already knows; the device flow does not, because it returns identity and
    // nothing else — so for a brand-new account this is where the question gets
    // asked. Without it the server refuses any user who belongs to more than one
    // workspace, and the CLI would have no way to answer.
    const targetWorkspace = workspaceId ?? (await chooseWorkspace(ctx, deps, api, stage));
    const name = (await deps.prompt(`New project name [${basename(ctx.root)}]: `)).trim();
    const created = await api.createProject(
      name === "" ? basename(ctx.root) : name,
      targetWorkspace,
    );
    return { project: summarize(created), origin: "created" };
  }

  if (!ctx.canPrompt) {
    throw new SetupError({
      stage,
      code: "AMBIGUOUS",
      message: `This workspace has ${projects.length} projects, so setup cannot pick one for you.`,
      remedy: `Choose one with --project, for example:\n  traceroot setup --project ${first.project_name}`,
    });
  }

  const answer = await deps.select({
    stage,
    message: "Which project should receive these traces?",
    options: projects.map((p) => ({ value: p.project_id, label: p.project_name })),
  });
  const picked = projects.find((p) => p.project_id === answer);
  if (picked === undefined) {
    throw new SetupError({
      stage,
      code: "AMBIGUOUS",
      message: `'${answer}' is not one of the listed projects.`,
    });
  }
  return { project: summarize(picked), origin: "existing" };
}

function recordProject(ctx: SetupContext): void {
  if (ctx.project !== undefined) {
    ctx.checkpoint.projectId = ctx.project.projectId;
    ctx.checkpoint.projectName = ctx.project.projectName;
  }
}

// ── ACQUIRE_PROJECT_KEY ─────────────────────────────────────────────────────

const acquireProjectKey: StageDefinition = {
  stage: "acquire_project_key",
  isSatisfied: (ctx) => ctx.credential !== undefined,
  async run(ctx, deps) {
    const session = requireSession(ctx);
    const project = requireProject(ctx);

    // The user's own key is already scoped to this project (the single-credential
    // shape TraceRoot ships today). Minting a second key would be pure noise.
    if (ctx.project?.origin === "from-whoami" || ctx.project?.origin === "existing") {
      const userKey = session.userKey;
      const client = deps.createClient({
        host: session.host,
        auth: { kind: "api-key", key: userKey.reveal() },
        timeoutMs: 15_000,
      });
      try {
        const who = await client.whoami();
        if (who.project_id === project.projectId) {
          ctx.credential = {
            key: userKey,
            keyId: null,
            keyName: who.key_name,
            projectId: project.projectId,
            expiresAt: null,
            origin: "existing-config",
          };
          ctx.checkpoint.projectKeyHint = userKey.hint;
          wizardProgress(ctx, "Using the existing project-scoped API key.");
          return "skipped";
        }
      } catch {
        // Fall through to the reuse/mint path below.
      }
    }

    const api = deps.createSetupApi({ host: session.host, apiKey: session.userKey.reveal() });

    // Reuse before minting: a key already in `.env.traceroot` that authenticates to
    // the selected project is the right key, and a rerun of setup must not
    // accumulate a new credential every time.
    const reused = await reuseExistingKey(ctx, deps, project.projectId);
    if (reused !== null) {
      ctx.credential = reused;
      ctx.checkpoint.projectKeyHint = reused.key.hint;
      wizardProgress(ctx, "Reusing the existing project API key.");
      return "skipped";
    }

    let existingNames: string[];
    try {
      // Names are nullable server-side; only named keys can collide with the
      // name we are about to dedupe, so unnamed ones are simply not candidates.
      existingNames = (await api.listApiKeys(project.projectId))
        .map((key) => key.name)
        .filter((name): name is string => name !== null);
    } catch (err) {
      if (err instanceof BackendUnavailableError) {
        throw backendUnsupported(
          "acquire_project_key",
          "Creating a project API key",
          [
            "Provide a project key instead:",
            "  traceroot setup --api-key <project key>",
            `or add ${KEY_ENV}=<project key> to ${ENV_FILE} and rerun setup.`,
          ].join("\n"),
        );
      }
      throw err;
    }

    const name = uniqueKeyName(`traceroot-setup-${basename(ctx.root)}`, existingNames);
    const created = await api.createApiKey({
      name,
      projectId: project.projectId,
      expiresInDays: null,
    });
    ctx.credential = {
      key: makeSecret(created.key),
      keyId: created.id,
      keyName: created.name,
      projectId: project.projectId,
      expiresAt: created.expires_at,
      origin: "minted",
    };
    ctx.checkpoint.projectKeyId = created.id;
    ctx.checkpoint.projectKeyHint = ctx.credential.key.hint;
    mintedKeys.set(ctx, created.id);
    // The plaintext key is deliberately not printed. It goes into the child's
    // environment and into `.env.traceroot`; putting it on the terminal would leave a
    // live credential in scrollback and in any captured output.
    wizardProgress(ctx, `Created project API key '${created.name}' (${ctx.credential.key.hint}).`);
    return "ok";
  },
};

/** Keys minted by this run, so a later failure can revoke them. */
const mintedKeys = new WeakMap<SetupContext, string>();

/**
 * Looks for a key that already belongs to this repository and project.
 *
 * Only a key that both authenticates *and* resolves to the selected project is
 * reused. A key that authenticates to a different project is neither reused nor
 * overwritten — that is a conflict the user has to see, because silently
 * replacing it would break whatever else is using it.
 */
async function reuseExistingKey(
  ctx: SetupContext,
  deps: SetupDeps,
  projectId: string,
): Promise<ProjectCredential | null> {
  const envPath = join(ctx.artifactDir, ENV_FILE);
  if (!existsSync(envPath)) {
    return null;
  }
  const candidate = envFileKey(envPath);
  if (candidate === undefined || candidate.trim() === "") {
    return null;
  }

  const session = requireSession(ctx);
  const client = deps.createClient({
    host: session.host,
    auth: { kind: "api-key", key: candidate.trim() },
    timeoutMs: 15_000,
  });
  let who: Awaited<ReturnType<ApiClient["whoami"]>>;
  try {
    who = await client.whoami();
  } catch (err) {
    if (isAuthRejection(err)) {
      // A dead key is safe to replace.
      return null;
    }
    throw new SetupError({
      stage: "acquire_project_key",
      code: "UNSAFE_OVERWRITE",
      message: `A TraceRoot key is already present in ${ENV_FILE} but could not be verified (${session.host} was unreachable), so setup stopped rather than replacing it.`,
      remedy: "Check your connection and rerun `traceroot setup`.",
    });
  }

  if (who.project_id !== projectId) {
    throw new SetupError({
      stage: "acquire_project_key",
      code: "UNSAFE_OVERWRITE",
      message: `${ENV_FILE} already contains a working TraceRoot key for project '${who.project_name ?? who.project_id}', but setup selected '${ctx.project?.projectName}'.`,
      remedy: [
        "Run setup for that project instead:",
        `  traceroot setup --project ${who.project_name ?? who.project_id}`,
        `or remove ${KEY_ENV} from ${ENV_FILE} if it is stale.`,
      ].join("\n"),
    });
  }

  return {
    key: makeSecret(candidate.trim()),
    keyId: ctx.checkpoint.projectKeyId ?? null,
    keyName: who.key_name,
    projectId,
    expiresAt: null,
    origin: "reused",
  };
}

/**
 * Appends a numeric suffix until the name is unused.
 *
 * The base name is the repository's directory name, which is not unique: two
 * checkouts of the same repo, or a second run after a key was already minted,
 * both arrive here asking for a name that is taken. Suffixing keeps the name
 * recognisable — the point of naming a key after its repository is that someone
 * auditing the dashboard can tell where it came from — where a random or
 * timestamped one would not.
 */
export function uniqueKeyName(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) {
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

// ── CONFIGURE_REPOSITORY ────────────────────────────────────────────────────

/** Whether `candidate` is the same key once its env-assignment wrapper is off. */
function holdsKey(candidate: string | undefined, key: string): boolean {
  return candidate !== undefined && normalizeApiKey(candidate) === key;
}

/**
 * Whether the instrumented application will find *this* credential on its own.
 *
 * Only two sources can mean yes. `env` is a variable already exported in the
 * shell the user will start their application from, and `auto-env-file` is a
 * `.env` beside it — the file an application's own dotenv loader reads. For
 * those, writing a second copy adds nothing.
 *
 * Every other source is the CLI's and not the application's. `flag` lasts for
 * one invocation. `env-file` is a file named for the CLI with `--env-file` and
 * may sit anywhere, including outside the repository. `config` and
 * `credentials-file` are the CLI's own stores under the user's home directory,
 * which no SDK reads — so a `traceroot login` followed by `traceroot setup`
 * lands here. And `none` is a key typed at setup's own prompt, which until this
 * stage runs exists in no file the application could open.
 *
 * The source alone is not taken as proof. It is a label computed in
 * `resolveAuth`, and this is the stage whose skip leaves a user with no usable
 * credential at all — the one place in the run that should check rather than
 * infer. So the value is read back out of wherever the label says it lives and
 * compared with the credential the run settled on. A label without the matching
 * value behind it writes, which is the safe direction.
 */
function applicationCanResolve(ctx: SetupContext, deps: SetupDeps, key: string): boolean {
  switch (deps.resolvedAuth.credential.source) {
    case "env":
      return holdsKey(deps.env[KEY_ENV], key);
    case "auto-env-file":
      // The same file `resolveAuth` auto-discovered: the `.env` beside where the
      // command was run, which is `ctx.cwd` rather than `ctx.root` — a service
      // in a monorepo has its own, and the root's is not it.
      return holdsKey(envFileKey(join(ctx.cwd, ".env")), key);
    default:
      return false;
  }
}

const configureRepository: StageDefinition = {
  stage: "configure_repository",
  isSatisfied: (ctx, deps) =>
    // Skip only when the application really will find the credential without
    // this stage writing it.
    //
    // `origin === "existing-config"` is not that claim. The fast path in
    // `acquire_project_key` stamps that origin on the user's own key whatever
    // its provenance, so a key pasted at the prompt, passed as `--api-key`, or
    // read from the CLI's config in the home directory all arrive here looking
    // like a key already in the environment — and the stage that writes the
    // only file the application can read is skipped for all three. `setup` then
    // closes by telling the user to run an application that cannot
    // authenticate.
    //
    // `resolvedAuth` never lost the distinction, so the guard asks it rather
    // than re-deriving one from the origin. See {@link applicationCanResolve}.
    ctx.credential !== undefined &&
    ctx.credential.origin === "existing-config" &&
    applicationCanResolve(ctx, deps, ctx.credential.key.reveal()),
  async run(ctx, deps) {
    const credential = requireCredential(ctx);
    const session = requireSession(ctx);
    const envPath = join(ctx.artifactDir, ENV_FILE);
    // The same file named from the repository root, which is what both git and
    // `.gitignore` want. `.env.traceroot` at the root and `api/.env.traceroot`
    // are different files, and asking git about the wrong one is how a tracked
    // credential gets written to anyway.
    const envEntry = relativeToRoot(ctx.root, envPath);

    if (ctx.inGitRepo) {
      const tracked = await deps.runProcess({
        program: "git",
        args: ["ls-files", "--", envEntry],
        cwd: ctx.root,
        env: deps.env,
        stdio: "capture",
        timeoutMs: 15_000,
      });
      if (tracked.exitCode === 0 && tracked.output.trim() !== "") {
        // Writing a live credential into a tracked file would put it one `git
        // commit -a` away from a public repository. Degrade instead of failing:
        // the child environment handoff still works for this run.
        wizardWarn(
          ctx,
          `${ENV_FILE} is tracked by git, so the API key was not written to it. The key is available to this setup run only; add it to an untracked env file to persist it.`,
        );
        return "skipped";
      }
    }

    const updates: Record<string, string> = { [KEY_ENV]: credential.key.reveal() };
    if (session.host !== DEFAULT_HOST) {
      updates[HOST_ENV] = session.host;
    }
    const result = upsertEnvFile(envPath, updates);
    wroteEnvKeys.set(ctx, result.written);

    if (result.written.length === 0) {
      wizardProgress(ctx, `${ENV_FILE} already up to date.`);
      return "skipped";
    }
    if (ctx.inGitRepo) {
      // The entry is the path from the repository root, not the bare filename.
      // A bare `.env.traceroot` in the root ignore file would in fact cover a
      // nested one — an unanchored pattern matches at any depth — but the
      // reverse reading is the dangerous one, and naming the actual path is the
      // only version that is right no matter how the user's ignore file is
      // already written.
      const ignored = ensureIgnored(ctx.root, envEntry);
      if (ignored === "appended") {
        wizardProgress(ctx, `Added ${envEntry} to .gitignore.`);
      }
    }
    wizardProgress(ctx, `Wrote ${result.written.join(", ")} to ${envEntry} (0600).`);
    return "ok";
  },
};

/** Env keys this run wrote, so a failure can roll them back. */
const wroteEnvKeys = new WeakMap<SetupContext, string[]>();

/**
 * The credential file, named relative to a directory, or null when there is
 * none on disk.
 *
 * Asked of the filesystem rather than of what this run did, because both
 * answers have to be right and only one of them is about this run.
 * `configure_repository` writes nothing when the file already holds the right
 * value, writes nothing when the file is tracked by git, and does not run at
 * all when the key already resolves from the user's own config — and in two of
 * those three the file is there and should be loaded. Pointing an entry point
 * at a file that is absent, meanwhile, trades a missing credential for an
 * exception on startup, so the check is the file itself.
 */
/**
 * The key an env file holds, or undefined when the file cannot be read at all.
 *
 * `loadOptionalEnvFileFromDisk` swallows a missing file and rethrows
 * everything else — `EACCES`, a directory carrying that name, a parse failure.
 * Both callers ask a yes-or-no question about a file they otherwise ignore, and
 * for neither is an exception a useful answer: one would fail the stage that
 * acquires a key, the other the stage that builds the agent's task, in both
 * cases over a file whose only consequence was whether it could be used.
 */
function envFileKey(path: string): string | undefined {
  try {
    return loadOptionalEnvFileFromDisk(path)[KEY_ENV];
  } catch {
    return undefined;
  }
}

function credentialEnvFile(ctx: SetupContext, from: string): string | null {
  const path = join(ctx.artifactDir, ENV_FILE);
  // Existing is not enough: `configure_repository` also writes nothing when git
  // tracks the file, and then what is on disk is whatever was committed — a
  // different project's key, or a placeholder. Advertising it there hands the
  // agent a path that loads the wrong credential, which fails later and further
  // away than not naming it at all. The file earns its mention by holding the
  // credential this run selected.
  if (
    !existsSync(path) ||
    ctx.credential === undefined ||
    !holdsKey(envFileKey(path), ctx.credential.key.reveal())
  ) {
    return null;
  }
  // Forward slashes: this becomes a path inside a Python string literal in the
  // task, where a Windows separator would read as an escape.
  const rel = relative(from, path).replaceAll("\\", "/");
  return rel.startsWith("..") ? rel : `./${rel}`;
}

// ── DETECT_STACK ────────────────────────────────────────────────────────────

const detectStackStage: StageDefinition = {
  stage: "detect_stack",
  isSatisfied: (ctx) => ctx.stack?.selected != null,
  async run(ctx, deps) {
    // Running from a subdirectory means that subdirectory.
    //
    // `ctx.root` is the git root, because that is where the checkpoint belongs
    // and where `--resume` must find it. It must not double as the
    // instrumentation target: run from a service inside a monorepo, that would
    // hand the agent the entire repository above it — one it was not asked
    // about, full of unrelated services, possibly one already instrumented —
    // from which the agent reasonably concludes there is nothing to do.
    //
    // Only when the directory holds something instrumentable, so running from
    // `docs/` still falls back to the repository.
    const here = relative(ctx.root, ctx.cwd) || ".";
    const impliedService =
      here !== "." && detectStack(ctx.root, { service: here }).selected !== null ? here : undefined;

    const stack = detectStack(ctx.root, {
      language: ctx.flags.language,
      service: ctx.flags.service ?? impliedService,
    });
    ctx.stack = stack;

    if (stack.selected === null) {
      if (stack.services.length === 0) {
        // No dependency manifest anywhere. Detection deliberately does not
        // infer a service from loose scripts — a stray file is not evidence —
        // but the answer to "no manifest" is to ask, listing what is actually
        // there, not to stop with a suggestion the user cannot act on, since
        // following that suggestion would only reproduce this very error.
        return await askForLanguage(ctx, deps, stack);
      }
      // More than one candidate. Choosing silently would produce a confident,
      // wrong success — an instrumented service nobody asked about, and no
      // traces from the one they cared about. So ask when we can, and only
      // refuse when there is nobody to ask.

      // More than one candidate. Ask which *language* here and leave the
      // service to the agent: choosing between directories is the part the
      // agent does better.
      return await askForLanguage(ctx, deps, stack);
    }

    const selected = requireService(ctx);
    ctx.checkpoint.service = {
      path: selected.path,
      language: selected.language,
      framework: selected.framework,
    };
    wizardProgress(
      ctx,
      `Service: ${selected.path} (${selected.language}${selected.framework === null ? "" : `, ${selected.framework}`})`,
    );
    if (stack.existingInstrumentation.present) {
      wizardProgress(
        ctx,
        `TraceRoot already partly present: ${stack.existingInstrumentation.evidence.join("; ")}`,
      );
    }
    return "ok";
  },
};

/**
 * No manifest anywhere: ask which directory to instrument, listing what is
 * there.
 *
 * Nothing is inferred from loose hints: the candidate services, paths and
 * languages that were found are listed, and the user picks exactly one.
 * Detection stays dumb; the question is where the intelligence goes.
 *
 * Nothing here selects anything on the user's behalf — a directory is only ever
 * offered, and instrumenting it requires them to name it.
 */
/**
 * Ask which language to instrument, and let the coding agent settle which
 * service.
 *
 * *Languages* are detected from manifest filenames and used only to pre-check a
 * "Which language(s) to instrument?" selection. Directories are never asked
 * about and paths are never printed: which service to instrument is delegated
 * to the agent, which can read the repository and hold a conversation about it.
 * A static list can do neither.
 *
 * Language is what the CLI genuinely needs: it picks the SDK, the install
 * command and the initialization snippet. The service is the agent's problem.
 */
async function askForLanguage(
  ctx: SetupContext,
  deps: SetupDeps,
  stack: DetectedStack,
): Promise<SetupStageStatus> {
  const unsupported =
    stack.unsupportedLanguages.length > 0
      ? ` Found ${stack.unsupportedLanguages.join(", ")}, which the TraceRoot SDK does not support yet.`
      : "";

  // A repository we simply cannot instrument is not a question. Offering
  // "Python or TypeScript?" for a Go service invites an answer that must then
  // fail, which is worse than saying so now.
  if (stack.services.length === 0 && stack.unsupportedLanguages.length > 0) {
    throw new SetupError({
      stage: "detect_stack",
      code: "UNSUPPORTED",
      message: `No Python or TypeScript/JavaScript application was found in ${ctx.root}.${unsupported}`,
      remedy: [
        "Run setup from the directory that holds a supported application, or point at it:",
        "  traceroot setup --service <path> --language <python|typescript>",
      ].join("\n"),
    });
  }

  // Detected languages pre-select the answer. With nothing detected, the user
  // simply chooses.
  const detected = [...new Set(stack.services.map((svc) => svc.language))];
  const asked = normalizeLanguage(ctx.flags.language ?? "");

  let language: StackLanguage | null = asked;

  if (language === null && detected.length === 1) {
    language = detected[0] as StackLanguage;
  }

  if (language === null) {
    if (!ctx.canPrompt) {
      throw new SetupError({
        stage: "detect_stack",
        code: "AMBIGUOUS",
        message:
          detected.length > 1
            ? `This repository has ${detected.join(" and ")} applications, so setup cannot tell which to instrument.${unsupported}`
            : `No Python or TypeScript/JavaScript application was detected in ${ctx.root}.${unsupported}`,
        remedy: [
          "Say which language to instrument:",
          "  traceroot setup --language python",
          "  traceroot setup --language typescript",
        ].join("\n"),
      });
    }

    const answer = await deps.select({
      stage: "detect_stack",
      message: "Which language should TraceRoot instrument?",
      options: [
        { value: "python", label: "Python" },
        { value: "typescript", label: "TypeScript / JavaScript" },
      ],
    });
    language = normalizeLanguage(answer);
  }

  if (language === null) {
    throw new SetupError({
      stage: "detect_stack",
      code: "AMBIGUOUS",
      message: "No language was chosen.",
      remedy: "Rerun with --language python or --language typescript.",
    });
  }

  // Prefer a detected service in that language; otherwise hand the agent the
  // repository root and let it find the service, which is what the task
  // instructs it to do.
  const inLanguage = stack.services.filter((svc) =>
    language === "python" ? svc.language === "python" : svc.language !== "python",
  );

  const resolved =
    inLanguage.length === 1
      ? detectStack(ctx.root, { language, service: inLanguage[0]?.path })
      : detectStack(ctx.root, { language, service: "." });

  if (resolved.selected === null) {
    throw new SetupError({
      stage: "detect_stack",
      code: "UNSUPPORTED",
      message: `Could not prepare ${ctx.root} as a ${language} service.`,
      remedy: "Point at the application directory with --service <path>.",
    });
  }

  ctx.stack = resolved;
  wizardProgress(
    ctx,
    `Language: ${resolved.selected.language}${
      resolved.selected.path === "." ? " — the agent will identify the service" : ""
    }`,
  );
  return "ok";
}

// ── SELECT_AGENT ────────────────────────────────────────────────────────────

const selectAgentStage: StageDefinition = {
  stage: "select_agent",
  isSatisfied: (ctx) => ctx.agent !== undefined,
  async run(ctx, deps) {
    const detected = detectAgents({ cwd: ctx.root, env: deps.env });
    const chosen = await chooseInstrumentation(ctx, deps, detected);
    ctx.method = chosen.method;
    ctx.agent = chosen.agent;
    ctx.checkpoint.agentId = chosen.agent.id;

    if (chosen.method !== "agent") {
      return "skipped";
    }
    wizardProgress(ctx, `Agent: ${chosen.agent.displayName}`);
    return "ok";
  },
};

/** How the SDK will be added, and which agent that implies. */
interface InstrumentationChoice {
  method: InstrumentMethod;
  agent: DetectedAgent;
}

/**
 * The agent id a route that runs nothing still needs.
 *
 * `task-file` and `manual` both render a skill path, and a skill path is
 * per-agent — so an agent has to be named even though none will be launched.
 * `runnable: false` is the load-bearing part: nothing downstream may mistake
 * this for a binary that exists.
 */
function unlaunchedAgent(ctx: SetupContext): DetectedAgent {
  const adapter = requireAgent(ctx.flags.agent ?? "claude");
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    runnable: false,
    configured: false,
    evidence: [],
  };
}

/**
 * Decides how the SDK gets added, and — where that means running an agent —
 * which one, in a single question.
 *
 * "Which coding agent?" and "how should TraceRoot be added?" are one decision,
 * not two. Split, a user who has Claude Code installed and wants it to do the
 * work is asked to say so twice, and a user who wants the task file is made to
 * name an agent first as though it mattered. Worse, splitting them allows
 * offering "run a coding agent for me" and then failing on the next line
 * because none is on PATH — an option that was never available presented as
 * though it were.
 *
 * So the runnable agents *are* the run options. One installed agent means one
 * such option and no follow-up question; none installed means the option is
 * simply not there, which is the honest rendering of that machine.
 *
 * The default when nobody can be asked is deliberately NOT "run an agent". A CI
 * job, a `--json` consumer, or a piped invocation must never discover after the
 * fact that something rewrote its repository; launching a code-editing agent is
 * a decision a human takes, so an unattended run gets the task file instead and
 * says so.
 */
async function chooseInstrumentation(
  ctx: SetupContext,
  deps: SetupDeps,
  detected: DetectedAgent[],
): Promise<InstrumentationChoice> {
  const withAgent = async (): Promise<InstrumentationChoice> => ({
    method: "agent",
    // Still the resolution ladder, because a flag-driven run has not been
    // asked anything: `--agent` wins, one runnable agent auto-selects, several
    // prompt, none is an error naming `--no-instrument`.
    agent: await selectAgent({
      detected,
      requested: ctx.flags.agent,
      canPrompt: ctx.canPrompt,
      select: deps.select,
      warn: (message) => wizardWarn(ctx, message),
    }),
  });

  if (ctx.flags.method !== undefined) {
    return ctx.flags.method === "agent"
      ? await withAgent()
      : { method: ctx.flags.method, agent: unlaunchedAgent(ctx) };
  }
  // `--no-instrument` predates the three-way choice and means "do not run one".
  if (!ctx.flags.instrument) {
    return { method: "task-file", agent: unlaunchedAgent(ctx) };
  }
  // An explicit `--agent` is an unambiguous request to launch that agent.
  if (ctx.flags.agent !== undefined) {
    return await withAgent();
  }
  if (!ctx.canPrompt) {
    return { method: "task-file", agent: unlaunchedAgent(ctx) };
  }

  const runnable = detected.filter((agent) => agent.runnable);
  const answer = await deps.select({
    stage: "select_agent",
    message: "How should TraceRoot be added to this service?",
    options: [
      ...runnable.map((agent) => ({
        value: `agent:${agent.id}`,
        label: `Run ${agent.displayName} for me`,
        hint: "edits your code",
      })),
      { value: "task-file", label: "Write the task — I'll run my own agent", hint: "no edits" },
      { value: "manual", label: "Show me manual instructions", hint: "no edits" },
    ],
  });

  const picked = runnable.find((agent) => `agent:${agent.id}` === answer);
  if (picked !== undefined) {
    return { method: "agent", agent: picked };
  }
  if (answer !== "task-file" && answer !== "manual") {
    throw new SetupError({
      stage: "select_agent",
      code: "AMBIGUOUS",
      message: `'${answer}' is not one of the offered ways to instrument this service.`,
    });
  }
  return { method: answer, agent: unlaunchedAgent(ctx) };
}

// ── INSTALL_AGENT_CONTEXT ───────────────────────────────────────────────────

const installAgentContext: StageDefinition = {
  stage: "install_agent_context",
  isSatisfied: () => false, // cheap, and always refreshes to the shipped version
  async run(ctx) {
    const agent = requireAgent(requireDetectedAgent(ctx).id);
    let status: SetupStageStatus = "ok";

    const targetDir = agent.getSkillInstallPath(ctx.root, SKILL_NAME);
    try {
      // `force` is safe here: the target is our own skill directory, and the
      // shipped copy is the version the generated task refers to.
      //
      // Silent when it works. Copying a directory into place is bookkeeping:
      // the user did not ask for it, cannot answer anything about it, and has
      // no use for the path — the generated task is what refers to the skill,
      // and it resolves the path itself. A line here bought a section heading
      // and a file path in exchange for nothing the reader can act on.
      installBundledSkill({
        sourceDir: bundledSkillDir(SKILL_NAME),
        targetDir,
        force: true,
        dryRun: false,
      });
    } catch (err) {
      // The task prompt is self-contained, so a failed skill install degrades
      // the run rather than ending it.
      wizardWarn(
        ctx,
        `could not install the TraceRoot skill (${err instanceof Error ? err.message : String(err)}); continuing`,
      );
      status = "skipped";
    }

    return status;
  },
};

// ── INSTRUMENT ──────────────────────────────────────────────────────────────

/**
 * Proves the SDK is importable, rather than taking the agent's word for it.
 *
 * An agent can run for a minute, report that it finished, and have installed
 * nothing — an install command that cannot succeed on this interpreter is
 * retried rather than abandoned, and the transcript still ends in a completion
 * notice. Nothing downstream notices: the next stage runs the application,
 * which fails on `import traceroot`, and reports the only thing it can see,
 * that no trace arrived. The true cause is one stage back and never named.
 *
 * So the one command that distinguishes the two is run here. It does not fix
 * the install or retry it; it turns a silent failure into a named one.
 *
 * The interpreter is resolved again rather than reused from before the launch.
 * A service with no virtualenv resolves to none, and creating one is exactly
 * what the agent is told to do when the install needs it — so checking against
 * the pre-launch answer would fail a run that had in fact succeeded, in the one
 * case the check exists for.
 *
 * Which command to run is {@link importCheck}'s decision, because it is the
 * same decision {@link installCommand} makes and the two must not disagree
 * about where the package went. Null from it means there is nothing to check,
 * and the stage passes — see that function for which cases those are and why.
 */
async function checkSdkImportable(
  ctx: SetupContext,
  deps: SetupDeps,
  service: DetectedService,
  sdk: ResolvedSdk,
  cwd: string,
): Promise<{ check: ImportCheck; interpreter: string; importable: boolean } | null> {
  const interpreter =
    detectPythonEnvironment(ctx.root, service.path, deps.env).interpreter ?? "python3";
  const check = importCheck(sdk, service, interpreter);
  if (check === null) {
    return null;
  }
  const result = await deps.runProcess({
    program: check.program,
    args: check.args,
    cwd,
    env: deps.env,
    stdio: "capture",
    timeoutMs: 60_000,
    signal: ctx.signal,
  });
  return {
    check,
    interpreter,
    // A spawn failure is not an answer about the SDK — but it is not a working
    // service either, since this is how the application gets run.
    importable: !result.spawnFailed && result.exitCode === 0,
  };
}

const instrument: StageDefinition = {
  stage: "instrument",
  isSatisfied: (ctx) => ctx.instrumentation !== undefined,
  restore(ctx) {
    // The repository has already been edited by a previous run. Record that as
    // a restored result rather than launching an agent over it again.
    const agentId = ctx.checkpoint.agentId ?? ctx.agent?.id;
    if (agentId === undefined) {
      return;
    }
    ctx.instrumentation = {
      agentId,
      mode: "background",
      exitCode: 0,
      durationMs: 0,
      reported: null,
      observedChangedFiles: [],
      promptPath: null,
    };
  },
  async run(ctx, deps) {
    const service = requireService(ctx);
    const agent = requireDetectedAgent(ctx);
    const credential = requireCredential(ctx);
    const session = requireSession(ctx);
    const adapter = requireAgent(agent.id);

    const sdk = await deps.resolveSdk(sdkPackageFor(service));
    ctx.checkpoint.sdkVersion = sdk.version;
    if (sdk.source === "bundled") {
      wizardWarn(
        ctx,
        `could not reach the package registry; pinning the SDK version shipped with this CLI (${sdk.version})`,
      );
    }

    const method = ctx.method ?? "task-file";
    // The agent is always run captured, never handed the terminal. Handing it
    // over makes the wizard's own interface vanish for the longest step of the
    // run, at the one point where a user most wants to see what is happening.
    // Captured, its tool calls arrive as an activity feed instead. The
    // consequence is that the agent cannot ask questions, so the task must tell
    // it to stop rather than guess.
    // Where the agent will stand. Every relative path in the task has to be
    // resolvable from here, which is the whole reason this is computed once
    // and shared rather than derived twice.
    const agentCwd = service.path === "." ? ctx.root : join(ctx.root, service.path);
    // Found once and used twice: the task names it as the interpreter to use,
    // and the launch has to allow the agent to actually execute it.
    const pythonInterpreter =
      service.language === "python"
        ? detectPythonEnvironment(ctx.root, service.path, deps.env).interpreter
        : null;

    const task = buildSetupTask({
      service,
      root: ctx.root,
      sdk,
      // Relative to the agent's cwd, not the repository root.
      //
      // The skill installs at the root — `<root>/.claude/skills/<name>` — while
      // the agent starts in the service directory, so a path rendered relative
      // to the root points at nothing. The first instruction in the task is
      // "read this file"; an agent that cannot open it has no source of truth
      // for the SDK's API and spends the run guessing.
      skillPath: displaySkillPath(agentCwd, adapter.getSkillInstallPath(ctx.root, SKILL_NAME)),
      verifyCommand: service.testCommand,
      interactive: false,
      existingInstrumentation: ctx.stack?.existingInstrumentation.evidence ?? [],
      // Found here rather than by the agent. Working out which Python a
      // service runs on is slow for an agent to establish, and all of it
      // happens before the first edit.
      pythonInterpreter,
      envFiles: detectEnvFiles(ctx.root, service.path),
      // The credential file this run wrote, so the entry point loads it.
      //
      // `detectEnvFiles` cannot supply this and should not be widened to: it
      // answers "which files hold the application's own secrets", which is a
      // different question with a different answer in the task, and the file
      // setup wrote is not one of them. It also only ever finds files that
      // existed before setup ran, which `.env.traceroot` on a fresh project by
      // definition did not.
      //
      // Named relative to where the agent stands, like every other path in the
      // task. The artefacts follow the service but the service is chosen later
      // — a run started at the root of a monorepo writes the credential at the
      // root and instruments `api/`, so this is `../.env.traceroot` as often as
      // it is `./.env.traceroot`, and it is computed rather than assumed.
      credentialEnvFile: credentialEnvFile(ctx, agentCwd),
    });

    if (method === "manual") {
      // The manual route prints paths for a human standing at the repository
      // root, which is where they ran `traceroot setup`.
      const instructions = manualInstructions({
        service,
        sdk,
        skillPath: displaySkillPath(ctx.root, adapter.getSkillInstallPath(ctx.root, SKILL_NAME)),
      });
      wizardLine(ctx, `\n${instructions}`);
      ctx.instrumentation = {
        agentId: agent.id,
        mode: "prompt-only",
        exitCode: 0,
        durationMs: 0,
        reported: null,
        observedChangedFiles: [],
        promptPath: null,
      };
      return "skipped";
    }

    if (method === "task-file") {
      // The task is handed over instead of run. The rest of the flow still
      // works, so "instrument it yourself, then `setup --resume`" is a
      // first-class path rather than a dead end.
      const promptPath = join(ctx.root, ".traceroot", "prompts", "setup-instrument.md");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(ctx.root, ".traceroot", "prompts"), { recursive: true });
      writeFileSync(promptPath, task, "utf8");
      ctx.instrumentation = {
        agentId: agent.id,
        mode: "prompt-only",
        exitCode: 0,
        durationMs: 0,
        reported: null,
        observedChangedFiles: [],
        promptPath,
      };
      wizardLine(
        ctx,
        `\nWrote the instrumentation task to ${displaySkillPath(ctx.root, promptPath)}.\nRun it in ${adapter.displayName}, then rerun \`traceroot setup --resume\`.`,
      );
      return "skipped";
    }

    await confirmAgentLaunch(ctx, deps, adapter.displayName);

    const tempDir = deps.makeTempDir();
    try {
      // This is the longest step of the run by a wide margin, and the only one
      // where something other than the CLI is editing the user's repository. So
      // it shows what the agent is doing — one line per tool call, accumulating
      // above a spinner that stays on the bottom carrying the agent's name and
      // the elapsed seconds — and then takes the whole feed away again when it
      // is over.
      // A blank rail line first: this block is the longest thing in the run and
      // ran straight into the confirmation prompt above it.
      wizardLine(ctx, "");
      const started = deps.now().getTime();

      // No feed for a `--json` run: stdout is an event stream there and nobody
      // is watching stderr animate, so the parse is not even paid for.
      const feed = ctx.json
        ? null
        : startLineSpinner({
            sink: ctx.writers.err,
            message: `Running ${adapter.displayName}`,
            // Enough to see what it is doing, few enough that the block stays a
            // fixed size instead of pushing the run off the top of the screen.
            maxFeedLines: 8,
          });
      // No "Starting agent..." row above the spinner.
      //
      // It said what the spinner beneath it already said, and it was the one
      // row of the block that could be left behind. The feed is erased by
      // rewinding over the rows it drew, which reaches only what is still on
      // screen — so on a terminal already scrolled to the bottom, the block's
      // oldest row goes into scrollback and stays there after everything under
      // it is gone. The first line written is the first to be stranded, and
      // "Starting agent..." was always the first line written.
      const parseActivity = createActivityParser();

      let result: Awaited<ReturnType<typeof launchAgent>>;
      let observedChangedFiles: string[];
      try {
        result = await launchAgent({
          invocation: buildInvocation({
            agentId: agent.id,
            task,
            interactive: false,
            // The repository root, whenever the agent is standing somewhere
            // else. That is where the skill and its reference files live.
            readableDirs: agentCwd === ctx.root ? [] : [ctx.root],
            // Exactly the programs this task names, plus the manifest tools
            // it will reach for. An interpreter it cannot execute leaves it
            // able to write instrumentation and unable to prove any of it.
            allowedPrograms: [
              ...(pythonInterpreter === null ? [] : [pythonInterpreter]),
              "python3",
              "python",
              "uv",
              "npm",
              "pnpm",
              "yarn",
              "node",
              "ls",
              "cat",
              "grep",
            ],
          }),
          task,
          // The service, not the repository root.
          //
          // An agent started at the root of a multi-service repository spends
          // its opening minutes reading the repository: listing sibling
          // projects, reading unrelated example applications and grepping the
          // SDK's own source, none of which touches the service being
          // instrumented.
          //
          // Starting in the service makes the default working set the right
          // one. Nothing is fenced off — an agent that genuinely needs the root
          // can still walk up, and `verify_application` has always run here
          // (see the verify stage below), so this makes the two agree.
          cwd: agentCwd,
          parentEnv: deps.env,
          credential: credential.key,
          signal: ctx.signal,
          host: session.host,
          runProcess: deps.runProcess,
          onData:
            feed === null
              ? undefined
              : (chunk) => {
                  for (const line of parseActivity(chunk)) {
                    feed.writeAbove(`${line.verb}: ${line.detail}`);
                  }
                },
        });

        const git = await readGitState({
          cwd: ctx.root,
          runProcess: deps.runProcess,
          env: deps.env,
        });
        observedChangedFiles = changedSince(baselineChanges.get(ctx) ?? [], git.changedFiles);
      } catch (err) {
        // A spinner left animating over an error is the worst of both: the run
        // has stopped and the screen still says it is working.
        feed?.stop(`${adapter.displayName} stopped.`);
        throw err;
      }

      if (result.spawnFailed || result.exitCode !== 0) {
        // A failure keeps its transcript. Those lines are the only account of
        // what the agent was doing when it died, and the error thrown below
        // sends the user to read them.
        feed?.stop(`${adapter.displayName} exited with status ${result.exitCode}.`);
      } else {
        // The transcript was progress, not a record: what changed is in `git
        // diff` and in the setup report, so the block collapses to the one line
        // that is still true afterwards.
        feed?.stopAndClear(wizardStepLine(`${adapter.displayName} finished.`));
      }

      ctx.instrumentation = {
        agentId: agent.id,
        mode: "background",
        exitCode: result.exitCode,
        durationMs: deps.now().getTime() - started,
        reported: parseCompletion(result.output),
        observedChangedFiles,
        promptPath: null,
      };

      if (result.spawnFailed) {
        throw new SetupError({
          stage: "instrument",
          code: "UNSUPPORTED",
          message: `Could not start ${adapter.displayName}.`,
          remedy: [
            "Install it and rerun `traceroot setup --resume`, or generate the task instead:",
            "  traceroot setup --no-instrument",
          ].join("\n"),
        });
      }
      if (result.exitCode !== 0) {
        const changed =
          observedChangedFiles.length === 0
            ? "No files were changed."
            : `Files changed: ${observedChangedFiles.join(", ")}`;
        throw new SetupError({
          stage: "instrument",
          code: "AGENT_FAILED",
          message: `${adapter.displayName} exited with status ${result.exitCode}. ${changed}`,
          remedy:
            "Nothing was reverted — your changes are intact. Fix the issue and rerun `traceroot setup --resume`.",
        });
      }

      const sdkCheck = await checkSdkImportable(ctx, deps, service, sdk, agentCwd);
      if (sdkCheck !== null && !sdkCheck.importable) {
        const install = installCommand(sdk, service, service.language, sdkCheck.interpreter);
        throw new SetupError({
          stage: "instrument",
          code: "AGENT_FAILED",
          message: `${adapter.displayName} finished, but \`import ${sdkCheck.check.module}\` fails under ${sdkCheck.check.display} — the ${sdk.package} SDK was not installed, so the instrumented code cannot run.`,
          remedy: [
            "Install it yourself, then rerun `traceroot setup --resume`:",
            `  ${install}`,
            // Only for the `pip` form. `uv` and `poetry` manage their own
            // environment, so PEP 668 cannot be what stopped them and saying so
            // sends the reader after the wrong cause.
            ...(install.includes("-m pip install")
              ? [
                  "",
                  "If that reports `externally-managed-environment`, the interpreter is a",
                  "system one and needs a virtualenv first:",
                  "  python3 -m venv .venv && ./.venv/bin/python -m pip install …",
                ]
              : []),
          ].join("\n"),
        });
      }

      return "ok";
    } finally {
      // The staging directory never lives in the repository, so a failed run
      // leaves no setup litter behind for the user to clean up.
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  },
};

/**
 * The last thing asked before an LLM starts editing the user's code.
 *
 * Everything up to here was reversible — a key, a line in `.env.traceroot`, a
 * skill directory. This is the step that is not, and a user who has been
 * pressing Enter through a wizard should be stopped once and told, in one
 * sentence, what is about to happen to their repository.
 *
 * The default is Confirm, unlike the uncommitted-changes gate. By this point
 * the user has already chosen to run an agent — from `--agent`, or by picking
 * "run a coding agent for me" — so this is a checkpoint on a decision they made
 * rather than a new question, and defaulting to Abort would make the common
 * path require two answers to the same thing.
 *
 * The wording is deliberately narrow, and never claims "full permissions".
 * The invocation this builds runs the agent with edits accepted and its normal
 * approval flow otherwise — never a bypass-all switch (see `launch.ts`) — and
 * claiming more authority than is actually granted, in the one prompt whose
 * whole job is to be believed, would be the worst possible place to round up.
 *
 * Unattended runs never reach here: with nobody to ask, the method resolves to
 * writing a task file rather than launching anything.
 */
async function confirmAgentLaunch(
  ctx: SetupContext,
  deps: SetupDeps,
  agentName: string,
): Promise<void> {
  if (!ctx.canPrompt) {
    return;
  }

  const answer = await deps.select({
    stage: "instrument",
    message: `Setup will now run ${agentName} with permission to edit files in this repository. Proceed?`,
    options: [
      { value: "confirm", label: "Confirm", hint: `run ${agentName}` },
      { value: "abort", label: "Abort", hint: "change nothing" },
    ],
    initialValue: "confirm",
  });

  if (answer !== "confirm") {
    throw new SetupError({
      stage: "instrument",
      code: "CANCELLED",
      message: `Setup cancelled — ${agentName} was not run and nothing was changed.`,
      remedy: [
        "To get the same instructions without an agent editing anything:",
        "  traceroot setup --no-instrument     writes the task for your own agent",
        "  traceroot setup --manual            prints the steps",
      ].join("\n"),
    });
  }
}

// ── VERIFY_APPLICATION ──────────────────────────────────────────────────────

const verifyApplicationStage: StageDefinition = {
  stage: "verify_application",
  isSatisfied: (ctx) => ctx.application?.passed === true,
  restore(ctx) {
    if (ctx.checkpoint.application !== undefined) {
      ctx.application = ctx.checkpoint.application;
    }
  },
  async run(ctx, deps) {
    const service = requireService(ctx);
    const credential = requireCredential(ctx);
    const session = requireSession(ctx);
    const command = service.testCommand;

    if (command === null) {
      ctx.application = {
        command: null,
        withCredentials: { ran: false, exitCode: null, durationMs: 0 },
        withoutCredentials: { ran: false, exitCode: null, durationMs: 0 },
        passed: false,
        skippedReason: "no test or health command was detected",
      };
      ctx.checkpoint.application = ctx.application;
      // Nothing is printed. There is nothing here for the user to fix — this
      // repository has no test script, which is a fact about it rather than a
      // fault — and a run that says so out loud spends a line reporting that a
      // step it never promised did not happen. It survives where it matters:
      // `skippedReason` above rides into the JSON result, and the trace-wait
      // failure path below says it in the one place it explains something.
      return "skipped";
    }

    wizardProgress(ctx, `Verifying the application: ${command}`);
    const { verification, failure } = await verifyApplication({
      command,
      cwd: service.path === "." ? ctx.root : join(ctx.root, service.path),
      parentEnv: deps.env,
      credential: credential.key,
      host: session.host,
      runProcess: deps.runProcess,
      signal: ctx.signal,
    });
    ctx.application = verification;
    ctx.checkpoint.application = verification;

    if (!verification.passed) {
      // Only the tail of the failing run's output: enough to see the error,
      // little enough that a chatty test suite does not bury the remedy.
      const tail =
        failure === null ? "" : `\n\n${failure.output.split("\n").slice(-25).join("\n").trim()}`;
      const message =
        failure?.phase === "without"
          ? `\`${command}\` passed with TraceRoot configured but failed with ${KEY_ENV} removed. The application must keep working when TraceRoot is absent.${tail}`
          : `\`${command}\` failed after instrumentation.${tail}`;
      throw new SetupError({
        stage: "verify_application",
        code: "APP_VERIFICATION_FAILED",
        message,
        remedy:
          "Nothing was reverted. Fix the failure, then rerun `traceroot setup --resume` to finish verification.",
      });
    }

    wizardProgress(ctx, "Application passes its checks, with and without TraceRoot.");
    return "ok";
  },
};

// ── VERIFY_TRACE ────────────────────────────────────────────────────────────

const verifyTrace: StageDefinition = {
  stage: "verify_trace",
  isSatisfied: (ctx) => ctx.trace !== undefined,
  restore(ctx) {
    if (ctx.checkpoint.trace !== undefined) {
      ctx.trace = ctx.checkpoint.trace;
    }
  },
  async run(ctx, deps) {
    const credential = requireCredential(ctx);
    const session = requireSession(ctx);
    // The wizard's own client, not the generated one. The single read this
    // stage makes must not depend on which operations the tool registry chooses
    // to expose — it is the same public endpoint either way.
    const client = deps.createSetupApi({
      host: session.host,
      apiKey: credential.key.reveal(),
      timeoutMs: 15_000,
    });

    // Nothing ran the application, so nothing can have emitted a trace.
    //
    // Waiting the full timeout here is the wizard patiently hoping for
    // something it already knows cannot happen — two minutes of a spinner and
    // then a timeout, when the answer was available immediately. The agent may
    // still have run the code itself while instrumenting, so this takes one
    // look before giving up rather than assuming.
    const somethingRan = ctx.application?.withCredentials.ran === true;
    const timeoutMs = somethingRan ? ctx.flags.traceTimeoutSec * 1000 : 0;
    // The other long unattended wait. Nothing arrives to report on until the
    // trace does, so the elapsed counter is the whole of what a user can be
    // told — and it is the difference between waiting and suspecting a hang.
    const waiting =
      ctx.json || !somethingRan
        ? null
        : startLineSpinner({
            sink: ctx.writers.err,
            message: `Waiting for your first trace (up to ${ctx.flags.traceTimeoutSec}s)`,
          });

    let outcome: Awaited<ReturnType<typeof pollForTrace>>;
    try {
      outcome = await pollForTrace({
        client,
        startedAt: new Date(ctx.checkpoint.startedAt),
        timeoutMs,
        signal: ctx.signal,
        sleep: deps.sleep,
        now: () => deps.now().getTime(),
      });
    } catch (err) {
      waiting?.stop("Stopped waiting for a trace.");
      throw err;
    }
    waiting?.stop(
      outcome.found
        ? "First trace received."
        : `No trace after ${Math.round(outcome.waitedMs / 1000)}s.`,
    );

    if (!outcome.found && !somethingRan) {
      // Say the actual reason rather than reporting a timeout that never
      // really elapsed. Nothing exercised the code, so there is nothing to
      // have waited for.
      throw new SetupError({
        stage: "verify_trace",
        code: "TRACE_TIMEOUT",
        message:
          "No trace yet, and nothing has run your application — setup found no test or health command to run, so the instrumented code was never executed.",
        remedy: ["Run your application once, then:", "  traceroot setup --resume"].join("\n"),
      });
    }

    if (!outcome.found) {
      throw new SetupError({
        stage: "verify_trace",
        code: "TRACE_TIMEOUT",
        message: `No trace arrived within ${Math.round(outcome.waitedMs / 1000)}s.${outcome.lastError === null ? "" : ` Last error: ${outcome.lastError}`}`,
        remedy: [
          "The most common cause is that the instrumented code path never ran.",
          "Run your application once, then:",
          "  traceroot setup --resume",
          "To investigate:",
          "  traceroot setup doctor",
          "  traceroot traces list --limit 5",
        ].join("\n"),
      });
    }

    ctx.trace = outcome.trace;
    ctx.checkpoint.trace = outcome.trace;
    return "ok";
  },
};

// ── COMPLETE ────────────────────────────────────────────────────────────────

const complete: StageDefinition = {
  stage: "complete",
  isSatisfied: () => false,
  async run(ctx, deps) {
    const trace = ctx.trace;
    if (trace === undefined) {
      return "skipped";
    }
    if (ctx.json) {
      // stdout belongs to the event stream in JSON mode; the `result` event
      // already carries `trace_url`, so there is nothing further to say.
      return "ok";
    }
    // What the run established is said by the two closing blocks in
    // `commands/setup.ts`, inside the frame. Nothing is written to stdout here:
    // a summary sentence printed from this stage would fall outside the box the
    // wizard has just drawn, and would carry a claim, a caveat and a URL on one
    // line.
    // Written, not announced. The report is there for whoever goes looking
    // after the fact; saying so on the last screen spends the user's attention
    // on a file they did not ask for, one line above the thing they did.
    writeSetupReport(ctx, deps.now());
    return "ok";
  },
};

/** The pipeline, in the only order it runs. */
export const SETUP_PIPELINE: readonly StageDefinition[] = [
  precheck,
  authenticate,
  selectContext,
  acquireProjectKey,
  configureRepository,
  detectStackStage,
  selectAgentStage,
  installAgentContext,
  instrument,
  verifyApplicationStage,
  verifyTrace,
  complete,
];

// ── runner ──────────────────────────────────────────────────────────────────

/**
 * Drives the pipeline.
 *
 * On failure the checkpoint records where and why, then the run undoes only what
 * it created itself — a key it minted, an env value it wrote. It never touches
 * the user's source: those edits are the agent's work in the user's worktree, and
 * reverting them would destroy the very thing the user wants to inspect.
 */
export async function runSetupMachine(ctx: SetupContext, deps: SetupDeps): Promise<SetupResult> {
  const stagesRun: SetupStageOutcome[] = [];

  for (const definition of SETUP_PIPELINE) {
    const { stage } = definition;

    // `--resume` rehydrates a durable stage's output from the checkpoint before
    // asking whether it still needs doing, so a rerun after a successful setup
    // is a cheap no-op rather than a second instrumentation pass.
    if (ctx.flags.resume && hasCompleted(ctx.checkpoint, stage)) {
      definition.restore?.(ctx);
    }
    if (definition.isSatisfied(ctx, deps)) {
      stagesRun.push({ stage, status: "skipped", durationMs: 0 });
      ctx.emit({ event: "stage", stage, status: "skipped", durationMs: 0 });
      markComplete(ctx.checkpoint, stage);
      continue;
    }

    ctx.emit({ event: "stage", stage, status: "start" });
    const started = deps.now().getTime();
    try {
      const status = await definition.run(ctx, deps);
      const durationMs = deps.now().getTime() - started;
      stagesRun.push({ stage, status, durationMs });
      markComplete(ctx.checkpoint, stage);
      ctx.emit({
        event: "stage",
        stage,
        status,
        durationMs,
        data: stageData(ctx, stage),
      });
      writeCheckpoint(ctx.artifactDir, ctx.checkpoint);
    } catch (err) {
      const durationMs = deps.now().getTime() - started;
      const error =
        err instanceof SetupError
          ? err
          : new SetupError({
              stage,
              code: "UNEXPECTED",
              message: err instanceof Error ? err.message : String(err),
            });
      stagesRun.push({ stage, status: "failed", durationMs });
      ctx.checkpoint.lastError = { stage, code: error.code, message: error.message };
      writeCheckpoint(ctx.artifactDir, ctx.checkpoint);
      ctx.emit({
        event: "stage",
        stage,
        status: "failed",
        durationMs,
        data: { code: error.code },
      });
      await rollback(ctx, deps);
      ctx.emit({
        event: "result",
        ok: false,
        data: resultData(ctx),
        error: { stage, code: error.code, message: error.message },
      });
      return { ok: false, stagesRun, checkpoint: ctx.checkpoint, trace: null, error };
    }
  }

  ctx.emit({ event: "result", ok: true, data: resultData(ctx) });
  return {
    ok: true,
    stagesRun,
    checkpoint: ctx.checkpoint,
    trace: ctx.trace ?? null,
    error: null,
  };
}

/**
 * Undoes only what this run created. `--resume` suppresses it: the user has
 * declared they intend to continue, so tearing down the credential they are
 * about to reuse would be actively unhelpful.
 */
async function rollback(ctx: SetupContext, deps: SetupDeps): Promise<void> {
  if (ctx.flags.resume) {
    return;
  }

  const keyId = mintedKeys.get(ctx);
  if (keyId !== undefined && ctx.session !== undefined) {
    try {
      const api = deps.createSetupApi({
        host: ctx.session.host,
        apiKey: ctx.session.userKey.reveal(),
      });
      await api.revokeApiKey(keyId);
      wizardProgress(ctx, "Revoked the API key created by this run.");
    } catch {
      // Best-effort: a key that outlives a failed setup is untidy, not unsafe,
      // and failing the failure path would only obscure the real error.
      wizardWarn(
        ctx,
        `could not revoke the API key created by this run (${ctx.checkpoint.projectKeyHint ?? "unknown"}); revoke it from the dashboard if it is unwanted`,
      );
    }
  }

  const written = wroteEnvKeys.get(ctx);
  if (written !== undefined && written.length > 0 && keyId !== undefined) {
    const { removeEnvKeys } = await import("./envWrite.js");
    try {
      removeEnvKeys(join(ctx.artifactDir, ENV_FILE), written);
    } catch {
      // best-effort
    }
  }
}

/** Non-secret per-stage payload for the JSON event stream. */
function stageData(ctx: SetupContext, stage: SetupStage): Record<string, unknown> | undefined {
  switch (stage) {
    // The only thing precheck decides, and the one a `--json` caller has to be
    // able to act on. "No version control to fall back on" is said in prose on
    // stderr, which is where diagnostics go and where an automated caller is
    // not reading; a run that is about to point an agent at an unversioned
    // directory should be refusable without parsing English out of a log.
    case "precheck":
      return { in_git_repo: ctx.inGitRepo };
    case "authenticate":
      return ctx.session === undefined
        ? undefined
        : {
            via: ctx.session.via,
            host: ctx.session.host,
            workspace_id: ctx.session.workspaceId,
            workspace_name: ctx.session.workspaceName,
          };
    case "select_context":
      return ctx.project === undefined
        ? undefined
        : {
            project_id: ctx.project.projectId,
            project_name: ctx.project.projectName,
            origin: ctx.project.origin,
          };
    case "acquire_project_key":
      return ctx.credential === undefined
        ? undefined
        : {
            origin: ctx.credential.origin,
            key_id: ctx.credential.keyId,
            key_hint: ctx.credential.key.hint,
            expires_at: ctx.credential.expiresAt,
          };
    case "detect_stack":
      return ctx.stack?.selected == null
        ? undefined
        : {
            service: ctx.stack.selected.path,
            language: ctx.stack.selected.language,
            framework: ctx.stack.selected.framework,
            existing_instrumentation: ctx.stack.existingInstrumentation.present,
          };
    case "select_agent":
      return ctx.agent === undefined ? undefined : { agent: ctx.agent.id };
    case "instrument":
      return ctx.instrumentation === undefined
        ? undefined
        : {
            agent: ctx.instrumentation.agentId,
            mode: ctx.instrumentation.mode,
            exit_code: ctx.instrumentation.exitCode,
            files_changed: ctx.instrumentation.observedChangedFiles,
            sdk_version: ctx.checkpoint.sdkVersion,
          };
    case "verify_application":
      return ctx.application === undefined
        ? undefined
        : {
            command: ctx.application.command,
            passed: ctx.application.passed,
            ran_without_credentials: ctx.application.withoutCredentials.ran,
            skipped_reason: ctx.application.skippedReason,
          };
    case "verify_trace":
      return ctx.trace === undefined
        ? undefined
        : {
            trace_id: ctx.trace.traceId,
            trace_url: ctx.trace.traceUrl,
            waited_ms: ctx.trace.waitedMs,
          };
    default:
      return undefined;
  }
}

/** Non-secret summary for the final `result` event. */
function resultData(ctx: SetupContext): Record<string, unknown> {
  return {
    project_id: ctx.project?.projectId ?? null,
    project_name: ctx.project?.projectName ?? null,
    service: ctx.stack?.selected?.path ?? null,
    agent: ctx.agent?.id ?? null,
    sdk_version: ctx.checkpoint.sdkVersion ?? null,
    application_passed: ctx.application?.passed ?? null,
    trace_id: ctx.trace?.traceId ?? null,
    trace_url: ctx.trace?.traceUrl ?? null,
    checkpoint_path: join(".traceroot", "setup.json"),
  };
}

// ── guards ──────────────────────────────────────────────────────────────────
// Each of these is unreachable given the pipeline order; they exist so a
// reordering mistake fails loudly at the boundary rather than as a
// `Cannot read properties of undefined` deep inside a stage.

function requireSession(ctx: SetupContext): NonNullable<SetupContext["session"]> {
  if (ctx.session === undefined) {
    throw new SetupError({
      stage: "authenticate",
      code: "UNEXPECTED",
      message: "internal: authentication stage did not produce a session",
    });
  }
  return ctx.session;
}

function requireProject(ctx: SetupContext): NonNullable<SetupContext["project"]> {
  if (ctx.project === undefined) {
    throw new SetupError({
      stage: "select_context",
      code: "UNEXPECTED",
      message: "internal: no project was selected",
    });
  }
  return ctx.project;
}

function requireCredential(ctx: SetupContext): NonNullable<SetupContext["credential"]> {
  if (ctx.credential === undefined) {
    throw new SetupError({
      stage: "acquire_project_key",
      code: "UNEXPECTED",
      message: "internal: no project credential was acquired",
    });
  }
  return ctx.credential;
}

function requireService(
  ctx: SetupContext,
): NonNullable<NonNullable<SetupContext["stack"]>["selected"]> {
  const selected = ctx.stack?.selected;
  if (selected == null) {
    throw new SetupError({
      stage: "detect_stack",
      code: "UNEXPECTED",
      message: "internal: no service was selected",
    });
  }
  return selected;
}

function requireDetectedAgent(ctx: SetupContext): NonNullable<SetupContext["agent"]> {
  if (ctx.agent === undefined) {
    throw new SetupError({
      stage: "select_agent",
      code: "UNEXPECTED",
      message: "internal: no agent was selected",
    });
  }
  return ctx.agent;
}

/** Exported for the doctor command, which reports on the same secret handling. */
export type { Secret };
