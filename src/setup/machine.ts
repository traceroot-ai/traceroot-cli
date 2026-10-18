import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { displaySkillPath, isInsideDirectory, requireAgent } from "../agents/index.js";
import type { AgentAdapter } from "../agents/types.js";
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
import { type HandoffOutcome, type HandoffRedeemOptions, redeemHandoff } from "../auth/handoff.js";
import {
  type TokenProvider,
  type TokenProviderOptions,
  createTokenProvider,
  decodeJwtClaims,
} from "../auth/token.js";
import { DEFAULT_HOST } from "../commands/constants.js";
import { loadOptionalEnvFileFromDisk, parseEnvFile } from "../config/envFile.js";
import {
  readConfig as realReadConfig,
  readConfigText as realReadConfigText,
  restoreConfigText as realRestoreConfigText,
  writeConfig as realWriteConfig,
} from "../config/manager.js";
import { type ResolvedAuth, normalizeApiKey } from "../config/resolve.js";
import { ExitCode, type Writers } from "../output.js";
import { bundledSkillDir } from "../skills/bundled.js";
import { installBundledSkill } from "../skills/install.js";
import { sleep } from "../util/sleep.js";
import { createActivityParser } from "./activity.js";
import { detectAgents, detectConfiguredAgents, selectAgent } from "./agents.js";
import { relativeToRoot } from "./artifacts.js";
import { hasCompleted, markComplete, writeCheckpoint } from "./checkpoint.js";
import {
  HOST_ENV,
  KEY_ENV,
  applicationEnvKeys,
  chooseCredentialEnvFile,
  removeEnvKeys,
  upsertEnvFile,
} from "./envWrite.js";
import { SetupError, backendUnsupported } from "./errors.js";
import type { RunProcess } from "./exec.js";
import { changedSince, isPathIgnored, readGitState } from "./git.js";
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
import { type SelectFn, type SelectOption, interactiveSelect } from "./select.js";
import { type LineSpinner, startLineSpinner } from "./spinner.js";
import {
  detectStack,
  findTraceRootInitialization,
  normalizeLanguage,
  serviceEntryPath,
} from "./stack.js";
import { buildSetupTask, manualInstructions, parseCompletion, taskInterpreters } from "./task.js";
import { pollForTrace, spanPhrase } from "./trace.js";
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
import { runBaselineCheck, verifyApplication } from "./verify.js";
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

/**
 * The credential goes into a file the project already loads.
 *
 * There used to be a constant here — `.env.traceroot`, a name chosen so our
 * lines could never be confused with the user's. Everything awkward about this
 * stage followed from it. No runtime reads that name, so the agent's task had to
 * teach a loader; nothing ignores that name, so this stage had to edit the
 * user's `.gitignore`; and the file's own header invited the user to delete it,
 * which would have been fine for a file only this tool read.
 *
 * `applicationCanResolve` below already settles the argument: it returns true
 * for `auto-env-file` — a key in the project's own `.env` — and skips this stage
 * entirely. We agreed the project's env file was the right place and then wrote
 * somewhere else. The name is now chosen from what the project has; see
 * {@link chooseCredentialEnvFile}.
 */

/**
 * The project env file this run writes the credential into, absolute.
 *
 * Asked once per use rather than cached, and that is safe because the answer
 * cannot change under us: the chooser prefers an existing `.env.local`, then an
 * existing `.env`, and otherwise names the `.env` this stage is about to create
 * — and after that creation it returns the same `.env`. Every stage in the run
 * therefore reads and writes one file, which is what lets
 * `reuseExistingKey` find a key a previous run left behind.
 */
function credentialEnvPath(ctx: SetupContext): string {
  return join(ctx.artifactDir, chooseCredentialEnvFile(ctx.artifactDir).name);
}
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
  /**
   * The warning naming the repository-local hosts a `--handoff` run left out of
   * `resolvedAuth`, said once when authentication starts. See `setupContext`.
   */
  hostsSetAside?: string;
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
  /**
   * A typed answer. `stage` is the one an interrupt is blamed on, as a `select`
   * names its own; the closing acknowledgements, asked after the pipeline, name
   * `complete`.
   */
  prompt: (question: string, stage?: SetupStage) => Promise<string>;
  promptHidden: (question: string, stage: SetupStage) => Promise<string>;
  resolveSdk: (pkg: SdkPackage) => Promise<ResolvedSdk>;
  writeConfig: (config: { api_key: string; host_url: string }) => void;
  /**
   * The CLI's own config as an earlier run left it, or null when there is none:
   * where a rerun finds the CLI key it already has rather than minting another.
   */
  readConfig: () => { api_key?: string; host_url?: string } | null;
  /**
   * The same file's text as it is on disk, null when there is none; and putting
   * text back, null removing the file. Byte for byte, because a rollback that
   * revokes the key this run wrote there puts back exactly what it replaced.
   */
  readConfigText: () => string | null;
  restoreConfigText: (text: string | null) => void;
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
  /**
   * Exchanges browser-first onboarding's one-shot code for a session. Owned by
   * `src/auth/`, next to the device flow it stands in for.
   */
  redeemHandoff: (opts: HandoffRedeemOptions) => Promise<HandoffOutcome>;
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
    prompt: (question, stage) =>
      readAnswer({ input: process.stdin, output: process.stdout }, question, { stage }),
    promptHidden: (question, stage) =>
      readAnswer({ input: process.stdin, output: process.stdout }, question, {
        stage,
        masked: true,
      }),
    resolveSdk: (pkg) => resolveSdkVersion(pkg),
    writeConfig: realWriteConfig,
    readConfig: () => {
      const read = realReadConfig();
      return read.ok ? read.config : null;
    },
    readConfigText: () => realReadConfigText(),
    restoreConfigText: (text) => realRestoreConfigText(text),
    sleep,
    select: interactiveSelect,
    makeTempDir: () => mkdtempSync(join(tmpdir(), "traceroot-setup-")),
    readCredential: (host) => readCredential(host),
    writeCredential: (host, entry) => writeCredential(host, entry),
    deleteCredential: (host) => deleteCredential(host),
    runDeviceFlow: (deviceDeps) => runDeviceFlow(deviceDeps),
    redeemHandoff: (opts) => redeemHandoff(opts),
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

/**
 * One typed answer from the terminal: the production `prompt` and
 * `promptHidden`, against a given terminal so a test can press the keys.
 *
 * Its own readline rather than the shared `readLine`, for the interrupt. Ctrl+C
 * reaches readline as a keypress in raw mode, and with no `SIGINT` listener
 * readline just closes: the question never settles, the event loop drains, and
 * the process exits 0, so `traceroot setup && <next step>` carried on through
 * the keypress meant to stop it. A question that names its stage raises
 * `INTERRUPTED` instead, as the selector does (see `select.ts`). One that names
 * none behaves exactly as `readLine` does.
 */
export async function readAnswer(
  terminal: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  question: string,
  options: { stage?: SetupStage; masked?: boolean } = {},
): Promise<string> {
  const { createInterface } = await import("node:readline");
  // Drained first, for the same reason every `select` is (see
  // `discardTypeAhead`). The two closing acknowledgements are consecutive
  // questions with a block of prose between them, so a spare Enter at the first
  // scrolls the second past a user who never read it.
  await discardTypeAhead(terminal.input);
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: terminal.input, output: terminal.output, terminal: true });
    if (options.masked === true) {
      const mutable = rl as unknown as { _writeToOutput?: (s: string) => void };
      const original = mutable._writeToOutput?.bind(rl);
      mutable._writeToOutput = (chunk: string): void => {
        if (chunk.includes(question)) {
          original?.(chunk);
        } else {
          terminal.output.write("*");
        }
      };
    }
    const { stage } = options;
    if (stage !== undefined) {
      rl.on("SIGINT", () => {
        rl.close();
        // Nothing echoed the keypress, so the next line would start on this one.
        terminal.output.write("\n");
        reject(new SetupError({ stage, code: "INTERRUPTED", message: "Setup interrupted." }));
      });
    }
    rl.question(question, (answer) => {
      rl.close();
      if (options.masked === true) {
        terminal.output.write("\n");
      }
      resolve(answer);
    });
  });
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
  // A real status beats sniffing a message, and anything that knows its status
  // should be judged on it.
  if (err instanceof SetupApiError) {
    return err.status === 401 || err.status === 403;
  }
  // So does the class the other clients assign. `whoami` throws the server's
  // own `detail` as the message — "API key has expired", "Project has been
  // deleted", "Authentication failed" — and the token provider refuses a dead
  // session with "session expired or revoked", none of which the regex below
  // recognises; both put the auth exit code on the error. Read structurally, as
  // `trace.ts` does, with the text kept for errors that carry only a string.
  const exitCode = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
  if (exitCode === ExitCode.auth) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /401|403|unauthor|invalid api key|forbidden/i.test(message);
}

/** Whether the credential resolved from an explicit, user-controlled source. */
function isExplicitSource(source: ResolvedAuth["credential"]["source"]): boolean {
  return source === "flag" || source === "env" || source === "env-file";
}

/**
 * A failure that pauses the run rather than ending it.
 *
 * Two endings need telling apart, because only one of them may undo what the
 * run created. A run that stopped because its agent is not installed, because
 * the suite needs fixing, or because no trace has arrived yet is *paused*: its
 * own message tells the user to rerun with `--resume`, and a rollback that
 * revoked the credential they are about to resume with would break the thing it
 * was tidying up after. A run that was cancelled, that cannot authenticate, or
 * that hit something unexpected is *over*, and what it created is litter.
 *
 * Declared at the throw, not derived from the error's code. The same code is
 * raised in places that mean different things — `UNEXPECTED` covers both a
 * stage that died mid-edit and a programming fault in a helper — so a table
 * keyed by code would be guessing, and the stage that raises the error is the
 * only place that knows which ending it is.
 *
 * Nothing is paused by default. Absence of this class means the run is over,
 * which is the direction that cleans up rather than the direction that leaves a
 * live credential behind: the cost of being wrong is one more `setup` run,
 * against an orphaned key nobody is watching.
 */
class PausedSetupError extends SetupError {}

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

/**
 * Runs in which this process launched the coding agent, keyed by context.
 *
 * In memory and never checkpointed, because what it answers is whether a trace
 * can still be on its way: the task has the agent run the application once,
 * and that trace reaches the list seconds after the run that sent it. A resumed
 * run restores `instrumentation` from the checkpoint whichever route wrote it,
 * so that record cannot say whether anything ran the application in this
 * process.
 */
const agentLaunched = new WeakSet<SetupContext>();

/**
 * Whether anything can still send this run a trace, which is what decides how
 * long `verify_trace` waits for one.
 *
 * Two things can. The coding agent, when this process launched it, because
 * the task has it run the application. And the application itself, once it
 * carries TraceRoot — a repository that already did, or a resume after the
 * user instrumented it by hand — because whoever runs it next sends one.
 * Detection reads the entry point afresh on every run, so the second answer is
 * about the code as it stands now.
 *
 * Setup's own check is not on the list. It runs with TraceRoot switched off and
 * sends nothing, so whether it ran says nothing about whether a trace is
 * coming. That was the reading this replaced: a repository with no test command
 * gave up on the agent's trace after one look, and one with a test command
 * waited out the whole budget on a hand-over route where nothing had been
 * instrumented at all.
 */
function traceCanArrive(ctx: SetupContext): boolean {
  return agentLaunched.has(ctx) || ctx.stack?.existingInstrumentation.present === true;
}

// ── AUTHENTICATE ────────────────────────────────────────────────────────────

/**
 * The resolved credential, but only when it is a project API key.
 *
 * A session credential lives in the same slot and is useless to the paths that
 * want a key — they hand it to `whoami` or write it into an env file, and
 * neither means anything for a session token.
 */
function apiKeyFrom(auth: SetupDeps["resolvedAuth"]): string | undefined {
  return auth.credential.kind === "api-key" ? auth.credential.value : undefined;
}

/**
 * The line that says an ambient API key was set aside for a handoff code.
 *
 * Named by where it came from, because "a key is configured" is not actionable
 * when the reader cannot see *which* key — and the places differ in how
 * surprising they are: a `.env` belongs to the repository the user is standing
 * in, while the config and credentials files belong to the machine.
 *
 * The credentials file is in here because `resolveAuth` reclassifies a
 * `tr_`-shaped value found in its session slot as an API key, source and all —
 * so "an ambient API key" really can come from there, and naming the config
 * file for it sends the reader to edit a file that has nothing in it.
 */
function ambientKeySetAside(source: ResolvedAuth["credential"]["source"]): string {
  const where =
    source === "auto-env-file"
      ? "in this directory's .env"
      : source === "credentials-file"
        ? "in your TraceRoot credentials file"
        : "in your TraceRoot config file";
  return `A TraceRoot API key is configured ${where}; the sign-in code from the browser takes precedence.`;
}

const authenticate: StageDefinition = {
  stage: "authenticate",
  isSatisfied: (ctx) => ctx.session !== undefined,
  async run(ctx, deps) {
    const host = deps.resolvedAuth.hostUrl.value ?? DEFAULT_HOST;
    const existing = apiKeyFrom(deps.resolvedAuth);

    // Said before anything is sent, because `host` above is already the
    // deployment the code will go to.
    if (deps.hostsSetAside !== undefined) {
      wizardWarn(ctx, deps.hostsSetAside);
    }

    // Browser-first onboarding's one-shot code. It is redeemed at most once per
    // run, from whichever of the two rungs below is reached first.
    const handoffCode = ctx.flags.handoff?.trim();
    const handoff = handoffCode === undefined || handoffCode === "" ? null : handoffCode;
    let handoffTried = false;
    const tryHandoff = async (): Promise<boolean> => {
      if (handoff === null || handoffTried) {
        return false;
      }
      handoffTried = true;
      return await handoffSignIn(ctx, deps, host, handoff);
    };

    // Where the code sits relative to a configured API key — the one real
    // precedence question this feature poses.
    //
    // An `--api-key` typed on this command line, named through `--env-file`, or
    // exported in the environment is a deliberate instruction, and it keeps
    // winning. An *ambient* key does not. One left in this directory's `.env`
    // or in the config file by an earlier run is machine state, not intent, and
    // letting it quietly defeat a code typed on the command line is the exact
    // failure this feature exists to remove: the hand-back step says to run
    // setup where the application lives, and a successful run writes
    // `TRACEROOT_API_KEY` into that directory's `.env` — so the likeliest place
    // to paste a handoff command is a directory already holding a key for some
    // other account. Honouring it silently authenticates as that account and
    // then dies three stages later, at project selection, with a message about
    // a missing project rather than about the wrong account.
    //
    // The explicit/ambient line is `isExplicitSource`'s, not a second one
    // invented here.
    const keyIsAmbient =
      existing !== undefined &&
      existing !== "" &&
      !isExplicitSource(deps.resolvedAuth.credential.source);
    if (handoff !== null && keyIsAmbient) {
      // Said before the redemption, not after: this is the decision, and it
      // holds whether or not the code turns out to still be live.
      wizardNote(ctx.writers, [ambientKeySetAside(deps.resolvedAuth.credential.source)], {
        settled: true,
      });
      if (await tryHandoff()) {
        return "ok";
      }
      // The code was refused, so the flag has had its say and the ordinary
      // ladder resumes — ambient key included.
    }

    if (existing !== undefined && existing !== "") {
      const client = deps.createClient({
        host,
        auth: { kind: "api-key", key: existing },
        timeoutMs: 15_000,
      });
      try {
        const who = await client.whoami();
        adoptKeySession(
          ctx,
          host,
          existing,
          who,
          isExplicitSource(deps.resolvedAuth.credential.source)
            ? deps.resolvedAuth.credential.source === "flag"
              ? "flag"
              : "env"
            : "existing-config",
        );
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

    // The code's other rung, reached when no key was configured at all or when
    // an explicit one was rejected. Either way it runs before anything saved on
    // disk is consulted: the code is intent to authenticate as the account
    // whose browser printed the command, and the `--project` on that same line
    // belongs to *that* account, so reusing a stored session would not merely
    // be the wrong account — it would fail later and elsewhere, as a confusing
    // project error rather than an auth one.
    //
    // A refusal falls through to the rungs below exactly as if the flag had not
    // been passed: interactive and nothing stored means the device flow, which
    // is one extra page and the status quo — never a dead end.
    if (await tryHandoff()) {
      return "ok";
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
    const pasted = normalizeApiKey(await deps.promptHidden("TraceRoot API key: ", "authenticate"));
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
    adoptKeySession(ctx, host, pasted, who, "pasted-key");
    return "ok";
  },
};

/**
 * Adopts an API key that `whoami` has just accepted as this run's session.
 *
 * One function for the two routes that sign in with a key — one already
 * configured, one pasted at the prompt — because what a key session records
 * does not depend on where the key came from, and a second copy is a second
 * place a field can reach one route and not the other.
 *
 * The key already implies a project (TraceRoot keys are project-scoped today),
 * so it is recorded as the default selection. SELECT_CONTEXT may still override
 * it from `--project`.
 */
function adoptKeySession(
  ctx: SetupContext,
  host: string,
  key: string,
  who: Awaited<ReturnType<ApiClient["whoami"]>>,
  via: NonNullable<SetupContext["session"]>["via"],
): void {
  ctx.session = {
    host,
    uiBaseUrl: who.ui_base_url,
    userKey: makeSecret(key),
    workspaceId: who.workspace_id,
    workspaceName: who.workspace_name,
    via,
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
}

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
 * Stores a freshly minted session for the host, and returns the entry whether
 * or not the store took it.
 *
 * Both ways a user can sign in end here — the browser approval and the one-shot
 * code from the web app — with the same entry, the same fields and the same
 * conditions on the optional two: `auth_host` only when the app and the API are
 * not the same host, `email` only when the sign-in told us one. Written once so
 * a later run cannot tell which way this machine signed in.
 *
 * Keeping it is what lets the next repository skip the browser entirely, and
 * this is the only moment it is available — but a store that failed must not
 * fail a sign-in that otherwise worked. So that is a warning, and the caller
 * gets the entry back either way, because this run still needs it to mint a
 * token.
 */
function storeSessionCredential(
  ctx: SetupContext,
  deps: SetupDeps,
  session: { host: string; authHost: string; sessionToken: string; email: string | undefined },
): CredentialEntry {
  const { host, authHost, email } = session;
  const entry: CredentialEntry = {
    session_token: session.sessionToken,
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
  return entry;
}

/**
 * How a sign-in line names the account: with the email when one is known, and
 * without pretending to one when it is not.
 *
 * One spelling for the three lines that announce a sign-in, because a user
 * reading two of them in the same run is comparing accounts.
 */
function signedInAs(email: string | undefined): string {
  return email === undefined ? "Signed in" : `Signed in as ${wizardValue(email)}`;
}

/**
 * The one line that says a handoff is replacing a different account's sign-in.
 *
 * `writeCredential` *replaces* the host's entry, so redeeming a handoff logs
 * this machine out of whatever was stored. Doing that silently is the bug this
 * exists to close: a run that quietly reuses — or quietly discards — the wrong
 * account fails much later, at project selection, where the message says
 * nothing about which account it is for.
 *
 * Returns `undefined` only when there is nothing to say: no stored credential,
 * or one provably for the same account. Sameness is *proved*, never assumed —
 * when either side's email is missing the sentence degrades to a non-specific
 * one rather than going quiet.
 */
function accountSwitchLine(
  previous: CredentialEntry | null,
  email: string | undefined,
): string | undefined {
  if (previous === null) {
    return undefined;
  }
  if (previous.email === undefined || email === undefined) {
    return `${signedInAs(email)}; the sign-in code from the browser replaced the TraceRoot sign-in already saved on this machine.`;
  }
  if (previous.email === email) {
    return undefined;
  }
  return `${signedInAs(previous.email)}; the code from the browser is for ${wizardValue(email)} — switching.`;
}

/**
 * Browser-first onboarding's handoff.
 *
 * The code was minted by the page the user is already looking at, so redeeming
 * it here is what lets this run authenticate without a second browser page.
 * What comes back is the same artifact a device-flow approval returns, written
 * to the same store through the same shape — from `resolveAuth`'s point of view
 * the result is an ordinary `credentials-file` session, with no new source and
 * no new precedence rule.
 *
 * Returns false when the server refused the code, so the caller can fall back
 * to the sign-in it would have used anyway. That is the *only* recoverable
 * failure: a 429, a 5xx or a timeout is a reachability problem and is raised as
 * one by `redeemHandoff`, because reporting "your code expired" for a network
 * fault would send the user hunting for a new code they do not need.
 */
async function handoffSignIn(
  ctx: SetupContext,
  deps: SetupDeps,
  host: string,
  code: string,
): Promise<boolean> {
  // Redemption talks to the app, which is not always the API host — a split
  // local stack runs them on different ports, and the code was minted by the
  // app. Same resolution the device flow and the token mint already use.
  const authHost = deps.resolvedAuth.authHost.value ?? host;

  const outcome = await deps.redeemHandoff({ authHost, code });
  if (outcome.kind === "rejected") {
    // Unknown, expired and already-redeemed are one answer by design, so this
    // says the true thing all three have in common rather than guessing.
    wizardWarn(
      ctx,
      "the sign-in code from the browser is no longer valid (it expires after a few minutes, and works once); signing in the normal way",
    );
    return false;
  }
  const { sessionToken, email } = outcome.credential;

  // Read before the write that replaces it: the announcement is about what is
  // being lost, and after `writeCredential` there is nothing left to compare.
  const switched = accountSwitchLine(deps.readCredential(host), email);

  // Exactly the entry the browser path writes, because it is the same writer.
  const entry = storeSessionCredential(ctx, deps, { host, authHost, sessionToken, email });

  wizardNote(
    ctx.writers,
    [
      switched ?? `${signedInAs(email)}.`,
      "",
      wizardAside("Used the sign-in code from the browser — no second page needed."),
    ],
    { settled: true },
  );

  const signedIn = await userCredentialSignIn(ctx, deps, host, entry, { announce: false });
  if (!signedIn) {
    throw new SetupError({
      stage: "authenticate",
      code: "NOT_AUTHENTICATED",
      message: "The sign-in from the browser was not accepted.",
      remedy: "Run `traceroot setup` again.",
    });
  }
  return true;
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

  const entry = storeSessionCredential(ctx, deps, {
    host,
    authHost,
    sessionToken: credential.sessionToken,
    email,
  });

  // Not `wizardStepLine`: `wizardNote` puts the step glyph on the first row of
  // the block itself, so composing one in as well printed two markers in the
  // gutter — `◇  ◆  Signed in as …`. The glyph belongs to the block, and
  // `wizardStepLine` is for the one caller that has no block to hang it on: the
  // spinner, which needs the settled line in hand before it erases what it drew.
  wizardNote(ctx.writers, [`${signedInAs(email)}.`], { settled: true });

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

  // What the repository already reports to, if anything: read before the
  // choice so it can be the default, and compared after it — before either key
  // is minted — so a run that would move the repository asks first.
  const existing = await repositoryKey(ctx, deps, host, "authenticate");
  const chosen = await chooseProject(
    ctx,
    deps,
    api,
    projects,
    "authenticate",
    options.workspaceId,
    existing?.who.project_id,
  );
  await confirmProjectSwitch(ctx, deps, existing, chosen.project, projects, "authenticate");

  // Two keys, because they go to two places with different rights.
  //
  // `cli` is the credential this process keeps and `writeConfig` persists. It
  // has to be able to manage keys — listing, minting and revoking a project's
  // keys all require an admin-scoped key — and it has to be able to read traces
  // back, which is how the run proves the first one arrived.
  //
  // `app` is written into the project's env file and travels with the
  // application: into CI, into containers, into whatever runs it. It needs to
  // send telemetry and nothing else. One key doing both jobs meant every
  // deployment of the instrumented application carried a credential that could
  // enumerate and revoke the project's keys.
  //
  // A rerun mints neither key it already has. Minting a fresh pair every time
  // left each earlier pair live and recorded nowhere, and the third run in a day
  // failed outright on a name the first two had taken. The CLI's is the key an
  // earlier run wrote to its config; the application's is the one in the env
  // file read above, kept unless it belongs elsewhere or can manage keys. A first
  // run has neither, so it mints both, as it always has.
  const projectId = chosen.project.projectId;
  const configured = await configuredCliKey(deps, host, projectId);
  const cli = configured ?? (await mintProjectKey(ctx, deps, api, projectId, "admin"));
  const kept =
    existing !== null && existing.who.project_id === projectId && !isAdminScoped(existing.who)
      ? existing
      : null;
  const application =
    kept === null
      ? mintedCredential(await mintProjectKey(ctx, deps, api, projectId, "ingest"), projectId)
      : reusedCredential(ctx, kept, projectId);
  const key = makeSecret(cli.key);

  // Verify before persisting, exactly as the browser path does. `whoami` is
  // also where `ui_base_url` comes from — the deployment's own answer for where
  // trace links live, which nothing else on this path knows. The config's key
  // was verified when it was read.
  const who =
    configured?.who ??
    (await deps
      .createClient({ host, auth: { kind: "api-key", key: key.reveal() }, timeoutMs: 15_000 })
      .whoami());

  // What the config held before a key this run minted goes into it — a key the
  // rollback may revoke — so that it can be put back rather than left naming a
  // dead key. Only a mint has an id. A reused key is still good, and the config
  // holding it is left alone.
  const replaced = "id" in cli ? configText(deps) : undefined;
  deps.writeConfig({ api_key: cli.key, host_url: host });
  const written = replaced === undefined ? undefined : configText(deps);
  if ("id" in cli && replaced !== undefined && typeof written === "string") {
    wroteConfig.set(ctx, { keyId: cli.id, key: cli.key, before: replaced, after: written });
  }

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
  // The application's key, not the CLI's. Everything downstream that writes a
  // credential into the repository or hands one to a child process reads this.
  ctx.credential = application;
  ctx.checkpoint.host = host;
  ctx.checkpoint.uiBaseUrl = who.ui_base_url;
  ctx.checkpoint.workspaceId = chosen.project.workspaceId;
  // The key the report and the closing notice are about is the one the
  // application carries, so the recorded id and hint are the application's.
  if (application.keyId !== null) {
    ctx.checkpoint.projectKeyId = application.keyId;
  }
  ctx.checkpoint.projectKeyHint = application.key.hint;
  recordProject(ctx);

  wizardProgress(ctx, `Project ${chosen.project.projectName}.`);
  if (kept !== null) {
    wizardProgress(ctx, "Reusing the existing project API key.");
  }
  return true;
}

/**
 * The CLI key an earlier run wrote to the CLI's config, while it still works
 * for this project on this host.
 *
 * Null for anything else — no config, no key in it, a config written for
 * another host, a key the server refuses or cannot be asked about, a key for
 * another project — and the caller mints, as a first run does. The host is
 * compared before anything is sent, so the key never goes to a deployment it
 * was not written for.
 */
async function configuredCliKey(
  deps: SetupDeps,
  host: string,
  projectId: string,
): Promise<{ key: string; who: Awaited<ReturnType<ApiClient["whoami"]>> } | null> {
  let config: ReturnType<SetupDeps["readConfig"]>;
  try {
    config = deps.readConfig();
  } catch {
    return null;
  }
  const key = normalizeApiKey(config?.api_key ?? "");
  const writtenFor = (config?.host_url ?? DEFAULT_HOST).trim().replace(/\/+$/, "");
  if (key === "" || writtenFor !== host) {
    return null;
  }
  try {
    const who = await deps
      .createClient({ host, auth: { kind: "api-key", key }, timeoutMs: 15_000 })
      .whoami();
    return who.project_id === projectId ? { key, who } : null;
  } catch {
    return null;
  }
}

/**
 * Whether `whoami` reports the key as admin-scoped.
 *
 * Read structurally because `key_scope` is newer than the vendored schema. A
 * deployment that predates scopes sends nothing, which reads as no, so nothing
 * changes there.
 */
function isAdminScoped(who: Awaited<ReturnType<ApiClient["whoami"]>>): boolean {
  return (who as { key_scope?: unknown }).key_scope === "admin";
}

/**
 * Mints one of this repository's two keys, naming it after the repository.
 *
 * A name collision means setup already ran here and this run cannot read that
 * key's secret back: the caller reuses any key it can still read, and the
 * server never shows a secret twice. So the only options are to mint a
 * distinguishable sibling or to fail a rerun outright, and failing a rerun
 * would be absurd. The suffix is the run date, then a count after it, which
 * keeps the key list readable rather than filling it with opaque ids.
 *
 * The `admin` request can be refused on authorization rather than on
 * authentication: minting a key that can manage a project's other keys is
 * reserved for a workspace admin, because that is the capability the dashboard
 * reserves for one. A member is therefore allowed to set their repository up
 * and not allowed to mint that key — so the refusal falls back to `ingest`
 * rather than ending the run. The CLI then cannot list or revoke keys on a
 * later run, and says so at the point it tries, which is a smaller loss than
 * refusing to onboard anyone who is not an admin.
 */
async function mintProjectKey(
  ctx: SetupContext,
  deps: SetupDeps,
  api: SetupApi,
  projectId: string,
  scope: "ingest" | "admin",
): Promise<CreatedApiKey> {
  // Distinct names, because the two keys are now distinguishable in a dashboard
  // only by what they are called. The application's keeps the name setup has
  // always used, so a rerun's duplicate-name handling is unchanged for it.
  const base =
    scope === "admin" ? `traceroot-cli-${basename(ctx.root)}` : `traceroot-${basename(ctx.root)}`;
  const mint = (name: string, withScope: "ingest" | "admin") =>
    mintRecordedKey(ctx, api, {
      projectId,
      name,
      scope: withScope,
      authenticatedBy: "user",
    });

  const attempt = async (withScope: "ingest" | "admin"): Promise<CreatedApiKey> => {
    try {
      return await mint(base, withScope);
    } catch (err) {
      if (!isNameConflict(err)) {
        throw err;
      }
    }
    // The run date, then a count after it. The date alone gave one more name a
    // day, so a third run in the same day had nowhere left to go.
    const dated = `${base}-${deps.now().toISOString().slice(0, 10)}`;
    for (let n = 1; ; n += 1) {
      try {
        return await mint(n === 1 ? dated : `${dated}-${n}`, withScope);
      } catch (err) {
        if (!isNameConflict(err) || n === MAX_DATED_KEY_NAMES) {
          throw err;
        }
      }
    }
  };

  if (scope === "ingest") {
    return await attempt("ingest");
  }
  try {
    return await attempt("admin");
  } catch (err) {
    if (!isForbidden(err)) {
      throw err;
    }
    wizardWarn(
      ctx,
      "this account cannot mint a key that manages other keys, so the CLI's own credential can only send and read; ask a workspace admin if a later run needs to rotate it",
    );
    return await attempt("ingest");
  }
}

/**
 * How many dated names one mint tries, the bare date included. A bound, so a
 * server that answers 409 to everything ends the run instead of looping; ten is
 * already more same-day reruns than a repository whose earlier keys are reused
 * should ever see.
 */
const MAX_DATED_KEY_NAMES = 10;

/** A 409 from the key-minting route: the name is taken. */
function isNameConflict(err: unknown): boolean {
  return err instanceof SetupApiError && err.status === 409;
}

/**
 * A 403: authenticated, and not authorized for what was asked.
 *
 * Distinguished from a 401 on purpose. A 401 means the credential is wrong and
 * retrying with a narrower request changes nothing; a 403 means this request
 * specifically was refused, which is the only case a narrower one can satisfy.
 */
function isForbidden(err: unknown): boolean {
  return err instanceof SetupApiError && err.status === 403;
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
 * The workspace a project belongs to, named the way `status` names every other
 * identity: the name first, its id after.
 *
 * The id is not decoration. A workspace name is not unique either — nothing
 * refuses a second workspace called the same thing, and the dashboard's default
 * name for a new one is derived from the owner's email domain, so two
 * colleagues onboarding from the same company both get a workspace with the
 * same name and anyone invited to both reads it twice. Qualifying two projects
 * named `test` with `Acme` would leave them reading identically all over again,
 * which is the whole defect. The id ends it: a project name is unique within
 * its workspace, so name plus workspace id cannot repeat.
 *
 * Written plainly rather than through `identity()`: this string lands in a
 * prompt's hint, which the prompt layer dims as a whole, and a nested dim would
 * end that dimming early for the rest of the line.
 */
function describeWorkspace(project: ProjectSummary): string {
  const name = project.workspace_name?.trim() ?? "";
  const id = project.workspace_id.trim();
  if (name === "") {
    // Every deployment that serves the project list sends a name, and one old
    // enough to omit it is old enough to answer the route with a 404 — so this
    // is a type obligation rather than a case to design for. The id is still an
    // answer, which is what matters: the hint identifies a workspace instead of
    // going blank.
    return id;
  }
  return id === "" ? name : `${name} (${id})`;
}

/** A project as a reader can tell it from its namesakes: its name, then its workspace. */
function describeProject(project: ProjectSummary): string {
  return `'${project.project_name}' in ${describeWorkspace(project)}`;
}

/**
 * Project name, then project id, compared by code unit.
 *
 * Not `localeCompare`: collation follows the runtime's locale data, and the
 * point of the order is that a position names the same project on every
 * machine that runs this, CI included.
 */
function byNameThenId(a: ProjectSummary, b: ProjectSummary): number {
  const order = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return order(a.project_name, b.project_name) || order(a.project_id, b.project_id);
}

/**
 * The project picker's rows.
 *
 * The label stays the bare project name, because the project is the thing being
 * chosen; the owning workspace goes in the dimmed hint beside it, which is what
 * `hint` is for. A project name is only unique inside its workspace and every
 * sign-in path lists projects across all of them, so a name appearing several
 * times is the ordinary case here — and labelled with the name alone those rows
 * are one choice as far as the reader can see, which makes a mis-pick both
 * undetectable and consequential: it is what sends a repository's traces to the
 * wrong project.
 *
 * Qualified unconditionally rather than only where today's list collides. A row
 * that renders the same on every run is one a person can recognise from the
 * last run and a test can pin, while a hint that appears only on a collision
 * hides the workspace from exactly the account that is about to grow one.
 */
export function projectOptions(projects: readonly ProjectSummary[]): SelectOption[] {
  return projects.map((project) => ({
    value: project.project_id,
    label: project.project_name,
    hint: describeWorkspace(project),
  }));
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
 *
 * A repository that already reports to a project has already answered: that
 * project is where the choice starts, and where a run with nobody to ask stays.
 * Whether a different answer may replace it is {@link confirmProjectSwitch}'s
 * call, not this function's.
 */
async function chooseProject(
  ctx: SetupContext,
  deps: SetupDeps,
  api: SetupApi,
  listed: readonly ProjectSummary[],
  stage: SetupStage,
  /** Where a newly created project goes, when the caller already knows. */
  workspaceId?: string,
  /** The project the repository already reports to; see {@link repositoryKey}. */
  currentProjectId?: string,
): Promise<{
  project: { projectId: string; projectName: string; workspaceId: string };
  origin: ProjectSelection["origin"];
}> {
  const wanted = ctx.flags.project;
  // In an order this function defines rather than the server's. The list
  // endpoint leaves the projects inside a workspace unordered, so a row's
  // position moved between runs, and "the third `test`" was not an answer that
  // could be given twice.
  const projects = [...listed].sort(byNameThenId);
  const current = projects.find((p) => p.project_id === currentProjectId);

  const summarize = (p: ProjectSummary) => ({
    projectId: p.project_id,
    projectName: p.project_name,
    workspaceId: p.workspace_id,
  });

  if (wanted !== undefined) {
    // A name is unique only inside its workspace, so it can match several
    // projects. Among them, the one the repository already reports to: the
    // `--project` that set a repository up must not move it to a namesake on
    // the next run.
    const matches = projects.filter((p) => p.project_id === wanted || p.project_name === wanted);
    const match =
      matches.find((p) => p.project_id === wanted) ??
      matches.find((p) => p === current) ??
      matches[0];
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
    const name = (await deps.prompt(`New project name [${basename(ctx.root)}]: `, stage)).trim();
    const created = await api.createProject(
      name === "" ? basename(ctx.root) : name,
      targetWorkspace,
    );
    return { project: summarize(created), origin: "created" };
  }

  if (!ctx.canPrompt) {
    if (current !== undefined) {
      wizardProgress(
        ctx,
        `Using project ${describeProject(current)}, which this repository already reports to.`,
      );
      return { project: summarize(current), origin: "existing" };
    }
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
    options: projectOptions(projects),
    // Opens on the project the repository already reports to, so accepting the
    // question as asked keeps it there. A first run has none and opens on the
    // first row, as it always has.
    ...(current === undefined ? {} : { initialValue: current.project_id }),
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

/**
 * Refuses to move a repository to another project unless the user chose to.
 *
 * The refusal `reuseExistingKey` makes, on the path where it could never run. A
 * user credential mints the application's key during authentication, so when
 * the pipeline reaches `acquire_project_key` its `isSatisfied` is already true
 * and the stage — the guard with it — is skipped, which left nothing between
 * the picker and `configure_repository` replacing the env file's key with one
 * for whichever project was picked. That is how three runs in one repository
 * sent its traces to three projects. Asked here, between the choice and the
 * first mint, so a refusal leaves nothing behind. A key session asks it from
 * `acquire_project_key`, before its key is written; see {@link settleSessionKey}.
 *
 * A person is asked, with both projects named by workspace, because two
 * projects can share a name. A run nobody is watching stops instead, unless a
 * flag named the destination: that is the user choosing it in this run, so the
 * run goes ahead and says so. Which flag can do that, and what to rerun, depend
 * on how the run signed in; see {@link SwitchRoute}.
 */
async function confirmProjectSwitch(
  ctx: SetupContext,
  deps: SetupDeps,
  existing: RepositoryKey | null,
  chosen: { projectId: string; projectName: string; workspaceId: string },
  projects: readonly ProjectSummary[],
  stage: SetupStage,
  route: SwitchRoute = {
    namedBy: ctx.flags.project === undefined ? undefined : "--project",
    move: [
      "To move this repository to that project, name it:",
      `  traceroot setup --project ${chosen.projectId}`,
    ],
    keep: "Rerun `traceroot setup` and accept the project it opens on.",
  },
): Promise<void> {
  if (existing === null || existing.who.project_id === chosen.projectId) {
    return;
  }
  const from = describeProject({
    project_id: existing.who.project_id,
    project_name: existing.who.project_name ?? existing.who.project_id,
    workspace_id: existing.who.workspace_id,
    workspace_name: existing.who.workspace_name,
  });
  const to = describeProject(
    projects.find((p) => p.project_id === chosen.projectId) ?? {
      project_id: chosen.projectId,
      project_name: chosen.projectName,
      workspace_id: chosen.workspaceId,
    },
  );

  if (ctx.canPrompt) {
    const answer = await deps.select({
      stage,
      message: `This repository sends its traces to ${from}. ${wizardEmphasis(`Switch it to ${to}?`)}`,
      options: [
        { value: "no", label: "No", hint: "keep it where it is and cancel setup" },
        {
          value: "yes",
          label: "Yes",
          hint: `send its traces to ${chosen.projectName} from now on`,
        },
      ],
      initialValue: "no",
    });
    if (answer === "yes") {
      return;
    }
    throw new SetupError({
      stage,
      code: "CANCELLED",
      message: `Setup cancelled — this repository still sends its traces to ${from}.`,
      remedy: route.keep,
    });
  }

  if (route.namedBy !== undefined) {
    wizardWarn(
      ctx,
      `this repository sent its traces to ${from}; from now on it sends them to ${to}, as ${route.namedBy} asked`,
    );
    return;
  }

  throw new SetupError({
    stage,
    code: "UNSAFE_OVERWRITE",
    message: `${existing.envEntry} already contains a working TraceRoot key for ${from}, but setup selected ${to}.`,
    remedy: [...route.move, `or remove ${KEY_ENV} from ${existing.envEntry} if it is stale.`].join(
      "\n",
    ),
  });
}

/**
 * How a run can choose a repository's destination, which differs by how it
 * signed in.
 *
 * A signed-in user picks a project, so `--project` names it. A key session has
 * no picker: the key decides, so the only flag that names the destination is
 * `--api-key`. A key exported from a shell profile, or left in the CLI's config
 * by an earlier run, was not chosen by this run and does not count.
 */
interface SwitchRoute {
  /** The flag that named the destination in this run, when one did. */
  namedBy: string | undefined;
  /** How to make the move on purpose, for a run that refused to. */
  move: string[];
  /** What to do instead, for a user who declined the move. */
  keep: string;
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
    // shape TraceRoot ships today). Minting a second key would be pure noise —
    // unless the key would go over the env file's own, or is one that can
    // manage keys; see `settleSessionKey`.
    let settledEnvFile = false;
    if (ctx.project?.origin === "from-whoami" || ctx.project?.origin === "existing") {
      const userKey = session.userKey;
      const client = deps.createClient({
        host: session.host,
        auth: { kind: "api-key", key: userKey.reveal() },
        timeoutMs: 15_000,
      });
      let who: Awaited<ReturnType<ApiClient["whoami"]>> | undefined;
      try {
        who = await client.whoami();
      } catch {
        // Fall through to the reuse/mint path below.
      }
      if (who?.project_id === project.projectId) {
        if (await settleSessionKey(ctx, deps, session, project, who)) {
          return "skipped";
        }
        // The env file has been read and answered for; what is left is the mint.
        settledEnvFile = true;
      }
    }

    const api = deps.createSetupApi({ host: session.host, apiKey: session.userKey.reveal() });

    // Reuse before minting: a key already in the project's env file that authenticates to
    // the selected project is the right key, and a rerun of setup must not
    // accumulate a new credential every time.
    const reused = settledEnvFile ? null : await reuseExistingKey(ctx, deps, project.projectId);
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
            `or add ${KEY_ENV}=<project key> to ${relativeToRoot(ctx.root, credentialEnvPath(ctx))} and rerun setup.`,
          ].join("\n"),
        );
      }
      throw err;
    }

    const name = uniqueKeyName(`traceroot-setup-${basename(ctx.root)}`, existingNames);
    const created = await mintRecordedKey(ctx, api, {
      name,
      projectId: project.projectId,
      // The application's credential, so it sends telemetry and nothing else.
      // Stated rather than left to the server's default: the other mint path
      // asks for `admin` for the CLI's own key, and two paths that disagree by
      // omission read as two paths that agree.
      scope: "ingest",
      authenticatedBy: "project-key",
    });
    ctx.credential = mintedCredential(created, project.projectId);
    ctx.checkpoint.projectKeyId = created.id;
    ctx.checkpoint.projectKeyHint = ctx.credential.key.hint;
    // The plaintext key is deliberately not printed. It goes into the child's
    // environment and into the project's env file; putting it on the terminal
    // would leave a live credential in scrollback and in any captured output.
    wizardProgress(ctx, `Created project API key '${created.name}' (${ctx.credential.key.hint}).`);
    return "ok";
  },
};

/**
 * Settles the application's key on a key session whose own key belongs to the
 * selected project, or returns false when one has to be minted for it.
 *
 * The session key used to be taken whatever the env file held, and
 * `configure_repository` then wrote it there: over another project's working
 * key, which moved the repository without a word, and — once `traceroot
 * logout` left the CLI's own config key as the session — over the application's
 * key with one that can manage keys. So it is taken only where writing it loses
 * nothing:
 *
 * - The application already finds this key, or the env file already holds it:
 *   nothing is written, so it is taken as before.
 * - The env file holds another working key for this project: that key is kept,
 *   exactly as `reuseExistingKey` keeps one on the other path.
 * - It holds one for another project: that is the move
 *   {@link confirmProjectSwitch} asks about, and a run nobody watches stops
 *   unless `--api-key` named the key in this run.
 * - The key is admin-scoped: an ingest key is minted for the application
 *   instead, which the admin key is the one credential able to do. That holds
 *   for a key this run was handed as much as for the CLI's own — `--api-key`,
 *   an env file and the prompt included — because the application carries its
 *   key into every deployment, and none of them needs to manage keys. A key on
 *   a deployment that does not report scopes is written as before.
 */
async function settleSessionKey(
  ctx: SetupContext,
  deps: SetupDeps,
  session: NonNullable<SetupContext["session"]>,
  project: ProjectSelection,
  who: Awaited<ReturnType<ApiClient["whoami"]>>,
): Promise<boolean> {
  const key = session.userKey.reveal();
  const take = (): true => {
    ctx.credential = {
      key: session.userKey,
      keyId: null,
      keyName: who.key_name,
      projectId: project.projectId,
      expiresAt: null,
      origin: "existing-config",
    };
    ctx.checkpoint.projectKeyHint = session.userKey.hint;
    wizardProgress(ctx, "Using the existing project-scoped API key.");
    return true;
  };

  if (applicationCanResolve(ctx, deps, key) || holdsKey(envFileKey(credentialEnvPath(ctx)), key)) {
    return take();
  }

  const existing = await repositoryKey(ctx, deps, session.host, "acquire_project_key");
  if (existing !== null) {
    if (existing.who.project_id === project.projectId && !isAdminScoped(existing.who)) {
      ctx.credential = reusedCredential(ctx, existing, project.projectId);
      ctx.checkpoint.projectKeyHint = ctx.credential.key.hint;
      wizardProgress(ctx, "Reusing the existing project API key.");
      return true;
    }
    await confirmProjectSwitch(
      ctx,
      deps,
      existing,
      project,
      [
        {
          project_id: who.project_id,
          project_name: who.project_name ?? who.project_id,
          workspace_id: who.workspace_id,
          workspace_name: who.workspace_name,
        },
      ],
      "acquire_project_key",
      {
        namedBy:
          session.via === "flag"
            ? "--api-key"
            : ctx.flags.project === undefined
              ? undefined
              : "--project",
        move: [
          "To move this repository to that project, pass that project's key:",
          "  traceroot setup --api-key <key>",
        ],
        keep: "To set it up where it is, rerun with that project's key: `traceroot setup --api-key <key>`.",
      },
    );
  }

  if (!isAdminScoped(who)) {
    return take();
  }
  wizardProgress(
    ctx,
    "That key can manage the project's keys, so the application gets a send-only key of its own.",
  );
  return false;
}

/**
 * The project's env files with the credential's own at the head of the list.
 *
 * Both sides name their paths relative to the service directory the agent
 * stands in, so a plain string comparison is the right dedupe: `detectEnvFiles`
 * emits `./.env` for a file beside the service and `../.env` for the
 * repository root's, and {@link credentialEnvFile} uses the same two spellings.
 */
function withCredentialFirst(found: string[], credential: string | null): string[] {
  if (credential === null) {
    return found;
  }
  return [credential, ...found.filter((file) => file !== credential)];
}

/** A key this run minted, with what the rollback needs to undo it. */
interface MintedKey {
  id: string;
  /** As the dashboard lists it, so the user can find the right row. */
  name: string | null;
  /**
   * The server's own display hint, not one derived here. It is the string the
   * dashboard's key list shows, which is what makes a key named in a failure
   * message findable; a hint computed locally would be a second spelling of
   * the same key that matches nothing on screen.
   */
  hint: string;
  /**
   * The client that minted it, kept so the rollback can revoke through the same
   * credential that created it.
   *
   * Not rebuilt from the session, which is why this field exists: the two keys
   * the sign-in stage mints are created before `ctx.session` is assigned, so a
   * rollback that reconstructed a client from the session would find nothing
   * there and silently revoke neither.
   */
  api: SetupApi;
  /**
   * Which route minted it, because that decides the route that can revoke it:
   * a key minted on the user's credential is revoked on it too, through the
   * route that names the project.
   */
  authenticatedBy: MintRequest["authenticatedBy"];
  projectId: string;
}

/**
 * Keys minted by this run, in the order they were minted, so a later failure
 * can revoke them.
 *
 * This process's own and nothing else's. A previous run's keys reach this
 * process only through the checkpoint, and nothing can tell an orphan from a
 * key that has since gone into service — so they are recorded there and never
 * revoked from here. Revoking the wrong one breaks a working installation,
 * which is worse than the untidiness this cleans up.
 */
const mintedKeys = new WeakMap<SetupContext, MintedKey[]>();

/** What to ask for, and which route can be asked. */
interface MintRequest {
  projectId: string;
  name: string;
  scope: "ingest" | "admin";
  /**
   * Which route mints it, named for what authenticates the call rather than for
   * the method: `user` goes to the route that takes a project id and a user's
   * own credential, which is the only one that works before the project has a
   * key; `project-key` goes to the route that derives the project from the key
   * authenticating the request.
   */
  authenticatedBy: "user" | "project-key";
}

/**
 * Mints a key and writes it down. The only place in this file that calls a
 * key-creating route.
 *
 * A single function rather than a convention each stage remembers to follow.
 * The rollback used to read a list that only one of the two minting stages
 * appended to, so a run that signed in and failed later left two live keys on
 * the project with nothing anywhere marking them as orphaned — and the gap was
 * invisible, because a stage that mints is not obliged to record. Here it
 * cannot do one without the other: the recording is between the mint returning
 * and this function returning, so no caller can hold a key that is not in the
 * ledger.
 *
 * Written to the checkpoint as well as to memory, immediately. A process that
 * dies takes the in-memory ledger with it, and the checkpoint is the only thing
 * that survives to say a key was created at all. `writeCheckpoint` never
 * throws, so the durable record cannot itself be what loses the key. The one
 * window this cannot close is a process that dies between the server minting
 * the key and the response arriving here: nothing on this side of that call can
 * know the key exists.
 */
async function mintRecordedKey(
  ctx: SetupContext,
  api: SetupApi,
  request: MintRequest,
): Promise<CreatedApiKey> {
  const created =
    request.authenticatedBy === "user"
      ? await api.createProjectApiKey({
          projectId: request.projectId,
          name: request.name,
          scope: request.scope,
          expiresInDays: null,
        })
      : await api.createApiKey({
          name: request.name,
          projectId: request.projectId,
          scope: request.scope,
          expiresInDays: null,
        });

  const entry: MintedKey = {
    id: created.id,
    name: created.name,
    hint: created.hint,
    api,
    authenticatedBy: request.authenticatedBy,
    projectId: request.projectId,
  };
  mintedKeys.set(ctx, [...(mintedKeys.get(ctx) ?? []), entry]);
  ctx.checkpoint.mintedKeys = [
    ...(ctx.checkpoint.mintedKeys ?? []),
    { id: entry.id, name: entry.name, hint: entry.hint },
  ];
  writeCheckpoint(ctx.artifactDir, ctx.checkpoint);
  return created;
}

/** The key a repository's env file already holds, and who the server says it is. */
interface RepositoryKey {
  key: string;
  /** The env file, named from the repository root. */
  envEntry: string;
  who: Awaited<ReturnType<ApiClient["whoami"]>>;
}

/**
 * The key in the env file this run would write, and the project it belongs to —
 * which is the project the repository already reports to.
 *
 * Asked of the server rather than recorded by setup. `whoami` answers for any
 * project key, an ingest key included, so the key a previous run wrote is its
 * own record of where the application's traces go; a second record under
 * `.traceroot/` could only ever disagree with the key the application sends.
 *
 * Null when there is nothing to protect: no file, no key in it, or a key the
 * server refuses. A key that could not be checked at all is not that —
 * replacing it might break an application that works — so the run stops.
 */
async function repositoryKey(
  ctx: SetupContext,
  deps: SetupDeps,
  host: string,
  stage: SetupStage,
): Promise<RepositoryKey | null> {
  const envPath = credentialEnvPath(ctx);
  const envEntry = relativeToRoot(ctx.root, envPath);
  if (!existsSync(envPath)) {
    return null;
  }
  const key = envFileKey(envPath)?.trim();
  if (key === undefined || key === "") {
    return null;
  }

  const client = deps.createClient({
    host,
    auth: { kind: "api-key", key },
    timeoutMs: 15_000,
  });
  try {
    return { key, envEntry, who: await client.whoami() };
  } catch (err) {
    if (isAuthRejection(err)) {
      // A dead key is safe to replace.
      return null;
    }
    throw new SetupError({
      stage,
      code: "UNSAFE_OVERWRITE",
      message: `A TraceRoot key is already present in ${envEntry} but could not be verified (${host} was unreachable), so setup stopped rather than replacing it.`,
      remedy: "Check your connection and rerun `traceroot setup`.",
    });
  }
}

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
  const existing = await repositoryKey(ctx, deps, requireSession(ctx).host, "acquire_project_key");
  if (existing === null) {
    return null;
  }
  const { who, envEntry } = existing;

  if (who.project_id !== projectId) {
    throw new SetupError({
      stage: "acquire_project_key",
      code: "UNSAFE_OVERWRITE",
      message: `${envEntry} already contains a working TraceRoot key for project '${who.project_name ?? who.project_id}', but setup selected '${ctx.project?.projectName}'.`,
      remedy: [
        "Run setup for that project instead:",
        `  traceroot setup --project ${who.project_name ?? who.project_id}`,
        `or remove ${KEY_ENV} from ${envEntry} if it is stale.`,
      ].join("\n"),
    });
  }

  return reusedCredential(ctx, existing, projectId);
}

/** A key already in the repository's env file, kept as the application's. */
function reusedCredential(
  ctx: SetupContext,
  existing: RepositoryKey,
  projectId: string,
): ProjectCredential {
  return {
    key: makeSecret(existing.key),
    keyId: ctx.checkpoint.projectKeyId ?? null,
    keyName: existing.who.key_name,
    projectId,
    expiresAt: null,
    origin: "reused",
  };
}

/** A key this run minted for the application. */
function mintedCredential(created: CreatedApiKey, projectId: string): ProjectCredential {
  return {
    key: makeSecret(created.key),
    keyId: created.id,
    keyName: created.name,
    projectId,
    expiresAt: created.expires_at,
    origin: "minted",
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
    const target = chooseCredentialEnvFile(ctx.artifactDir);
    const envPath = join(ctx.artifactDir, target.name);
    // The same file named from the repository root, which is what git wants. A
    // `.env` at the root and an `api/.env` are different files, and asking git
    // about the wrong one is how a tracked credential gets written to anyway.
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
        //
        // This is the one case that refuses, and it stays a refusal now that the
        // file is the project's own. Tracked means the next `git commit -a`
        // carries the key with no further decision from the user, and there is
        // nothing this stage could add to the repository to prevent it.
        wizardWarn(
          ctx,
          `${envEntry} is tracked by git, so the API key was not written to it. The key is available to this setup run only; add it to an untracked env file to persist it.`,
        );
        return "skipped";
      }
    }

    // Which variables go in, asked of the one function that decides — the same
    // one the closing notice asks when it tells the user which to carry. The
    // host rule lived here alone, and the notice named the key and nothing
    // else, which is how a non-default host came to be written down and never
    // mentioned again.
    const keys = applicationEnvKeys(session.host);
    const updates: Record<string, string> = { [KEY_ENV]: credential.key.reveal() };
    // A host line the file already holds for another deployment is replaced
    // even on the hosted product, where the key alone is otherwise the whole
    // set: the application reads that line, so the new key and its traces would
    // go to a deployment the key does not belong to. The usual source is a
    // repository `.env` whose host a `--handoff` run ignored.
    const fileHost = envFileHost(envPath)?.trim().replace(/\/+$/, "");
    const replacesHost = fileHost !== undefined && fileHost !== "" && fileHost !== session.host;
    if (keys.includes(HOST_ENV) || replacesHost) {
      updates[HOST_ENV] = session.host;
    }
    // What the file said first, because a rerun writes over the project's own
    // file: undoing a value it replaced means putting that value back.
    const before = readIfPresent(envPath);
    const result = upsertEnvFile(envPath, updates);
    if (replacesHost && result.written.includes(HOST_ENV)) {
      wizardWarn(
        ctx,
        `replaced ${HOST_ENV} in ${envEntry} (${fileHost}) with ${session.host}, the deployment this run's key belongs to`,
      );
    }
    const held = before === null ? {} : parseEnvFile(before);
    // `created`, because undoing a write and undoing a file are different
    // things and only the writer knows which this was.
    wroteEnvKeys.set(ctx, {
      path: envPath,
      keys: result.written,
      created: result.created,
      previous: Object.fromEntries(
        result.written.flatMap((key) => (held[key] === undefined ? [] : [[key, held[key]]])),
      ),
      before,
      after: result.written.length === 0 ? null : readIfPresent(envPath),
    });
    // The file is the project's and holds a usable key either way, so the
    // closing notice and the report can name it whether or not this run was the
    // one that put the key there.
    ctx.credentialEnvFile = envPath;

    if (ctx.inGitRepo) {
      await warnIfNotIgnored(ctx, deps, envEntry);
    }

    if (result.written.length === 0) {
      wizardProgress(ctx, `${envEntry} already up to date.`);
      return "skipped";
    }
    wizardProgress(
      ctx,
      target.existed
        ? `Wrote ${result.written.join(", ")} to ${envEntry}${modeNote(envPath)}.`
        : `Created ${envEntry} with ${result.written.join(", ")}${modeNote(envPath)}.`,
    );
    return "ok";
  },
};

/**
 * ` (0600)`: the mode a file has now, for the line that reports writing it.
 *
 * Read back rather than stated. A file this stage creates is 0600, but whether
 * one the project already had is tightened to match is the writer's decision,
 * not this line's — and a constant here would claim a protection the file may
 * not have. Nothing at all when the mode cannot be read.
 */
function modeNote(path: string): string {
  try {
    return ` (${(statSync(path).mode & 0o777).toString(8).padStart(4, "0")})`;
  } catch {
    return "";
  }
}

/** The file and keys this run wrote, so a failure can roll them back. */
const wroteEnvKeys = new WeakMap<
  SetupContext,
  {
    path: string;
    keys: string[];
    created: boolean;
    /** Each written key that already had a value, with that value. */
    previous: Record<string, string>;
    /** The file as it was before this run wrote it, and just after. */
    before: string | null;
    after: string | null;
  }
>();

/** A file's contents, or null when it is not there or cannot be read. */
function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Says so when the file now holding a live key is not ignored by git.
 *
 * Says, and does not act. This stage used to append a line to the user's
 * `.gitignore`, which was a write into a file nobody asked us to touch and was
 * decided by a matcher that read only the ignore file at the repository root —
 * blind to a nested `.gitignore`, to `.git/info/exclude` and to the user's
 * global excludes, and therefore liable to add a duplicate rule for a path
 * already covered. `git check-ignore` is the authority on the question, and the
 * answer belongs to the user to act on.
 *
 * Warn rather than refuse, which is the opposite of what the tracked case does,
 * and deliberately. Tracked means the key travels on the next `git commit -a`
 * with nothing further asked of the user. Merely unignored means git will list
 * the file in `git status` before anything is committed — the user sees it, and
 * this line tells them what to do. Refusing here would also break the case
 * setup is most useful in: a fresh repository with no `.gitignore` at all, where
 * a refusal leaves the user with no credential and no way forward.
 *
 * The third state is the one the old code got worst. It returned `"failed"` and
 * the caller dropped it on the floor, so a run that could not tell whether a
 * live credential was ignored said nothing at all. "Cannot tell" is reported as
 * itself here, because it is not evidence that the file is safe.
 */
async function warnIfNotIgnored(ctx: SetupContext, deps: SetupDeps, entry: string): Promise<void> {
  const state = await isPathIgnored({
    root: ctx.root,
    path: entry,
    runProcess: deps.runProcess,
    env: deps.env,
  });
  if (state === "not-ignored") {
    wizardWarn(
      ctx,
      `${entry} holds a live API key and git does not ignore it. Add a line for ${entry} to .gitignore before you commit.`,
    );
    return;
  }
  if (state === "unknown") {
    wizardWarn(
      ctx,
      `could not check whether git ignores ${entry}, which now holds a live API key; confirm it is not committed.`,
    );
  }
}

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

/** The host a dotenv file points the application at, read the way {@link envFileKey} reads its key. */
function envFileHost(path: string): string | undefined {
  try {
    return loadOptionalEnvFileFromDisk(path)[HOST_ENV];
  } catch {
    return undefined;
  }
}

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
function credentialEnvFile(ctx: SetupContext, from: string): string | null {
  const path = credentialEnvPath(ctx);
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
      // Both ways of selecting nothing are answered by the same question.
      //
      // No dependency manifest anywhere: detection deliberately does not infer
      // a service from loose scripts — a stray file is not evidence — but the
      // answer to "no manifest" is to ask, not to stop with a suggestion the
      // user cannot act on, since following that suggestion would only
      // reproduce this very error.
      //
      // More than one candidate: choosing silently would produce a confident,
      // wrong success — an instrumented service nobody asked about, and no
      // traces from the one they cared about. So ask when we can, and only
      // refuse when there is nobody to ask. Ask which *language*, and leave the
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
 * An adapter as the agent record a route that launches nothing still needs.
 *
 * `runnable: false` is the load-bearing part: nothing downstream may mistake
 * this for a binary that exists.
 */
function unlaunchedAgent(adapter: AgentAdapter, configured: boolean): DetectedAgent {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    runnable: false,
    configured,
    evidence: [],
  };
}

/**
 * The agent a hand-over route targets.
 *
 * `task-file` and `manual` both render a skill path and install the skill, and
 * both are per-agent — so an agent has to be named even though none will be
 * launched. It used to be named as `--agent` or else Claude Code, which made
 * the narrowness of `LAUNCHABLE_AGENTS` leak somewhere it has no business
 * being: that list exists because driving an agent headless needs an
 * environment this CLI controls, and this route drives nothing. A machine with
 * both `~/.codex` and `~/.claude` was told to run the task in Claude Code and
 * never heard Codex mentioned, and the skill went to `.claude/skills/` whatever
 * the user actually runs.
 *
 * So the agents *present* decide, through each adapter's own `detect` — which
 * is also what keeps Codex's global `$CODEX_HOME/skills` out of Claude Code's
 * project-local `.claude/skills`. The ladder is the one the rest of the CLI
 * uses: an explicit flag wins, one agent auto-selects, several ask when there
 * is somebody to ask, and none is not an error here — the markdown task is
 * self-contained, so it goes to the tool-neutral `.agents/skills/` location and
 * the wording stops naming a product nobody has.
 */
async function handoverAgent(ctx: SetupContext, deps: SetupDeps): Promise<DetectedAgent> {
  // Validated against the whole registry rather than the launchable list:
  // nothing is run, so "setup cannot drive that one" is not a reason to refuse
  // to write its task out.
  if (ctx.flags.agent !== undefined) {
    return unlaunchedAgent(requireAgent(ctx.flags.agent), true);
  }

  const present = detectConfiguredAgents(ctx.root);
  const first = present[0];
  if (first === undefined) {
    return unlaunchedAgent(requireAgent("generic"), false);
  }
  if (present.length === 1) {
    return unlaunchedAgent(first, true);
  }

  if (!ctx.canPrompt) {
    // No question, and not a word of one: `--json` owns stdout for its event
    // stream and a CI job has nobody to read a prompt. The registry's order
    // decides, and the run then *reports* the decision and the flag that
    // changes it — output after the fact, not a prompt.
    wizardProgress(
      ctx,
      `Agents set up here: ${present.map((a) => a.displayName).join(", ")}. Targeting ${first.displayName}; rerun with \`--agent <id>\` to target another.`,
    );
    return unlaunchedAgent(first, true);
  }

  const chosenId = await deps.select({
    stage: "select_agent",
    message: "Which coding agent will you run the task in?",
    options: present.map((adapter) => ({
      value: adapter.id,
      label: adapter.displayName,
      // Where its copy of the skill lands, because that is the one consequence
      // of this answer and it is not the same kind of place for each agent:
      // Claude Code reads a directory in this repository, Codex one in the
      // user's home.
      hint: displaySkillPath(ctx.root, adapter.getSkillInstallPath(ctx.root, SKILL_NAME)),
    })),
  });
  const chosen = present.find((adapter) => adapter.id === chosenId);
  if (chosen === undefined) {
    throw new SetupError({
      stage: "select_agent",
      code: "AMBIGUOUS",
      message: `'${chosenId}' is not one of the agents set up here.`,
    });
  }
  return unlaunchedAgent(chosen, true);
}

/**
 * "Run it in Codex", or — when there is no agent to name — a sentence that says
 * the task works anywhere rather than dead-ending on an agent the user has not
 * got. `subject` is whatever reads best where it is used: "it" straight after
 * the line that named the file, the path itself where nothing has.
 *
 * `generic` is no agent to name: it is the registry's entry for "no particular
 * agent", and its display name — "Agent (generic)" — is a category rather than
 * somewhere a user can go and open a file.
 *
 * Shared by the hand-over itself and by the closing block that has to repeat it,
 * so the two cannot come to disagree about where the task is supposed to run.
 */
export function runTaskSentence(ctx: SetupContext, subject: string): string {
  const agent = ctx.agent;
  return agent === undefined || agent.id === "generic"
    ? `No coding agent is set up here, but the task is self-contained — run ${subject} in whichever agent you use`
    : `Run ${subject} in ${agent.displayName}`;
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

  // The other half of the same decision. Spelled once for the same reason
  // `withAgent` is: four of the returns below differ only in which method they
  // name, and the agent a hand-over targets is not a question any of them
  // answers differently.
  const withHandover = async (
    method: Exclude<InstrumentMethod, "agent">,
  ): Promise<InstrumentationChoice> => ({
    method,
    agent: await handoverAgent(ctx, deps),
  });

  if (ctx.flags.method !== undefined) {
    return ctx.flags.method === "agent" ? await withAgent() : await withHandover(ctx.flags.method);
  }
  // `--no-instrument` predates the three-way choice and means "do not run one".
  if (!ctx.flags.instrument) {
    return await withHandover("task-file");
  }
  // An explicit `--agent` is an unambiguous request to launch that agent.
  if (ctx.flags.agent !== undefined) {
    return await withAgent();
  }
  if (!ctx.canPrompt) {
    return await withHandover("task-file");
  }

  const runnable = detected.filter((agent) => agent.runnable);
  // Left out of the options below, so it has to say why or the run option
  // just goes missing.
  for (const agent of detected) {
    if (agent.unlaunchable !== undefined) {
      wizardWarn(ctx, agent.unlaunchable);
    }
  }
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
  return await withHandover(answer);
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
      // Except when the copy lands outside the repository. Codex reads its
      // skills from the user's home, so a run started here writes there — a
      // change `git diff` will never show, and not one to leave the user to
      // find by accident.
      if (!isInsideDirectory(ctx.root, targetDir)) {
        wizardProgress(
          ctx,
          `Installed the TraceRoot skill for ${agent.displayName} in ${displaySkillPath(ctx.root, targetDir)}, outside this repository.`,
        );
      }
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

/**
 * An agent's free-text note, short enough and flat enough for an error message.
 *
 * The note is the only place the agent's account of a block exists — the
 * completion block has no field for "I was stopped", so there is nothing to
 * match on and nothing is matched. It is quoted, not parsed.
 */
function oneLine(note: string, max = 200): string {
  const flat = note.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Where the task-file route writes the instrumentation task.
 *
 * Named once because two invocations have to agree on it: the run that writes
 * the file, and the `--resume` that restores the hand-over and has to name that
 * file again without having written it.
 */
function instrumentTaskPath(root: string): string {
  return join(root, ".traceroot", "prompts", "setup-instrument.md");
}

/**
 * Records a hand-over: the stage result for a route that ran nothing, and the
 * route itself on the checkpoint.
 *
 * Both in one place because the two have to agree. `restore()` rebuilds the
 * result from the recorded route alone — `"task-file"` wrote a task file,
 * `"manual"` printed instructions — so a branch that recorded one route and
 * returned the shape of the other would resume as something it never was. The
 * task path is derived from the route here for that reason rather than passed
 * in beside it, and every remaining field is the zero of "no run happened".
 */
function recordHandover(
  ctx: SetupContext,
  agentId: DetectedAgent["id"],
  route: "task-file" | "manual",
): void {
  ctx.checkpoint.instrumentHandover = route;
  ctx.instrumentation = {
    agentId,
    mode: "prompt-only",
    exitCode: 0,
    durationMs: 0,
    reported: null,
    observedChangedFiles: [],
    promptPath: route === "task-file" ? instrumentTaskPath(ctx.root) : null,
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
    // Unless nothing was edited at all. A hand-over is the other way this stage
    // completes, and restoring one as an agent run is how a resumed run came to
    // wait out the trace timeout on an uninstrumented application and then tell
    // the user to go and run it again. The mode is the thing `verify_trace`
    // reads to say so instead, so it has to survive the invocation that
    // recorded it.
    const completed = ctx.checkpoint.instrumentHandover;
    if (completed === undefined) {
      // A checkpoint written before that field existed. Every route records its
      // own value now, so absence is "not recorded" and nothing else — and
      // defaulting it to the agent route is the misreading this whole fix is
      // about, except silent. Decline, and the stage runs again: a rerun
      // without `--resume` already does exactly that, so it is a path the flow
      // has, where a restored result built on a guess is not.
      return;
    }
    ctx.instrumentation = {
      agentId,
      mode: completed === "agent" ? "background" : "prompt-only",
      exitCode: 0,
      durationMs: 0,
      reported: null,
      observedChangedFiles: [],
      promptPath: completed === "task-file" ? instrumentTaskPath(ctx.root) : null,
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
    const credentialFile = credentialEnvFile(ctx, agentCwd);
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
      // The same list the credential-free run takes, so the launch, the task
      // and the verification cannot disagree about which channel carries the
      // credential. Non-empty means a file the application loads holds the key,
      // and the agent is not given it in its environment.
      credentialFiles: applicationCredentialFiles(ctx),
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
      // One list, with the credential's file first.
      //
      // The credential used to be a second, parallel instruction: its own path,
      // its own loader, its own paragraph explaining that loading it was not
      // redundant. It needed all of that because the file was ours and nothing
      // read it. Now it is one of the project's own env files, so it belongs in
      // the list of them — `detectEnvFiles` finds it unprompted, since
      // `configure_repository` runs several stages before this one.
      //
      // First, not merely present, because `buildSetupTask` puts the head of
      // this list in the snippet it hands the agent. `detectEnvFiles` returns
      // the service's files before the repository root's, and the credential
      // does not always land in the service: the artefact directory is fixed
      // before the pipeline starts while the service is detected here, so a run
      // started at the root of a monorepo writes the key at the root and
      // instruments `api/`. Deduped, because in the ordinary case it is already
      // in there.
      envFiles: withCredentialFirst(detectEnvFiles(ctx.root, service.path), credentialFile),
      credentialEnvFile: credentialFile,
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
      recordHandover(ctx, agent.id, "manual");
      return "skipped";
    }

    if (method === "task-file") {
      // The task is handed over instead of run. The rest of the flow still
      // works, so "instrument it yourself, then `setup --resume`" is a
      // first-class path rather than a dead end.
      const promptPath = instrumentTaskPath(ctx.root);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(dirname(promptPath), { recursive: true });
      writeFileSync(promptPath, task, "utf8");
      recordHandover(ctx, agent.id, "task-file");
      wizardLine(
        ctx,
        `\nWrote the instrumentation task to ${displaySkillPath(ctx.root, promptPath)}.\n${runTaskSentence(ctx, "it")}, then rerun \`traceroot setup --resume\`.`,
      );
      return "skipped";
    }

    await confirmAgentLaunch(ctx, deps, adapter.displayName);

    // The one measurement that cannot be taken later.
    //
    // Here, and not in a stage of its own, because it has to sit between two
    // adjacent points: after the last question the user can answer "no" to —
    // running somebody's test suite and then telling them the run was aborted
    // is ten minutes spent on nothing — and before the first edit, after which
    // "the suite fails" no longer distinguishes a suite this run broke from one
    // that needed a database, a network, or a fix before setup arrived.
    //
    // The hand-over routes above return before this, and that is a decision
    // rather than an omission.
    //
    // `--no-instrument` and `--manual` both leave the edit outside the run: the
    // code changes afterwards, by the user or by an agent they drive
    // themselves, possibly days later, with this process long gone. A
    // measurement taken here would answer "was the suite red when setup wrote
    // the task", which is not the question verification asks. Between those two
    // moments the user may pull, fix the suite, break it, or change their
    // dependencies — so such a baseline would support both of the causal claims
    // verification makes while neither premise could be checked. The direction
    // that matters is the excusing one: "your suite was already failing" over a
    // measurement from last Tuesday would clear instrumentation that really did
    // break something, with authority and in writing.
    //
    // Measuring on the resume instead is no better. The code has changed by
    // then, so it is not a before.
    //
    // So those routes take no baseline, and the verification says so instead of
    // naming a cause: `verifyApplication` reports a failing check with no
    // baseline as `inconclusive`, the same word this route uses for a suite
    // that was already red. Spending a ten-minute suite run in order to print a
    // task file would also be absurd.
    //
    // Taken once: a resumed `instrument` stage runs over a worktree the agent
    // may already have edited, where this would measure the wrong thing while
    // looking like a baseline.
    if (service.testCommand !== null && ctx.checkpoint.applicationBaseline === undefined) {
      wizardProgress(ctx, `Checking \`${service.testCommand}\` before anything changes`);
      const baseline = await runBaselineCheck({
        command: service.testCommand,
        cwd: agentCwd,
        parentEnv: deps.env,
        // The interpreter found above, the same one the agent is told to
        // install into and the same one `verify_application` runs the real
        // check with. Without it `pytest` is not on the child's PATH and the
        // spawn fails before a single test runs — which is every Python
        // project with a virtualenv, i.e. nearly all of them.
        interpreter: pythonInterpreter,
        runProcess: deps.runProcess,
        signal: ctx.signal,
      });
      ctx.checkpoint.applicationBaseline = baseline;
      // `ran`, not just the exit code. An un-run baseline has `exitCode: null`,
      // and `null !== 0` — so warning on the code alone announced that the
      // project's suite does not pass on every run where the measurement
      // simply did not happen. That is the same false causal claim this whole
      // mechanism exists to remove, pointed the other way.
      if (baseline.ran && baseline.exitCode !== 0) {
        wizardWarn(
          ctx,
          `${service.testCommand} does not pass yet, so it cannot verify the instrumentation either; this run will say so rather than blame the changes`,
        );
      }
    }

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
          credentialFiles: applicationCredentialFiles(ctx),
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
              // Every spelling the task names, not only the absolute one.
              //
              // The task names a service-local interpreter relatively in the
              // command it tells the agent to run, because an absolute path
              // under a directory with spaces and parentheses is a quoting
              // problem the agent has to solve on the first try. A permission
              // rule matches the start of a command literally, so allowing only
              // the absolute path refuses exactly the command the task gave.
              ...taskInterpreters(pythonInterpreter, ctx.root, service.path),
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

      const reported = parseCompletion(result.output);
      // An agent did run. Recorded positively rather than by clearing the
      // field, because a rerun without `--resume` still loads the previous
      // checkpoint: writing `"agent"` overwrites a hand-over an earlier run
      // recorded here, which is what the clear was for, and leaves absence
      // meaning only "a version that did not record this".
      ctx.checkpoint.instrumentHandover = "agent";
      ctx.instrumentation = {
        agentId: agent.id,
        mode: "background",
        exitCode: result.exitCode,
        durationMs: deps.now().getTime() - started,
        reported,
        observedChangedFiles,
        promptPath: null,
      };

      if (result.spawnFailed) {
        throw new PausedSetupError({
          stage: "instrument",
          code: "UNSUPPORTED",
          message: `Could not start ${adapter.displayName}.`,
          remedy: [
            "Install it and rerun `traceroot setup --resume`, or generate the task instead:",
            "  traceroot setup --no-instrument",
          ].join("\n"),
        });
      }
      // It ran, and the task told it to run the application: from here on a
      // trace can be on its way whether or not anything below finds fault.
      agentLaunched.add(ctx);
      if (result.exitCode !== 0) {
        const changed =
          observedChangedFiles.length === 0
            ? "No files were changed."
            : `Files changed: ${observedChangedFiles.join(", ")}`;
        throw new PausedSetupError({
          stage: "instrument",
          code: "AGENT_FAILED",
          message: `${adapter.displayName} exited with status ${result.exitCode}. ${changed}`,
          remedy:
            "Nothing was reverted — your changes are intact. Fix the issue and rerun `traceroot setup --resume`.",
        });
      }

      // Exit 0 is the agent saying it finished. It is not evidence that it did
      // anything, and a sandboxed agent that could not act says both at once: a
      // package install refused for want of a writable cache, a workspace it had
      // no permission to edit, a command its own approval rules denied. It
      // reports the block in its completion block and still exits 0.
      //
      // Without this the run carries on as though the service were
      // instrumented. `verify_application` passes, because nothing about the
      // application changed; the SDK probe below says nothing at all for a Node
      // service, because there is no import to check; and the run then spends
      // the entire trace timeout before `verify_trace` reports that the
      // instrumented code path never ran — which is true, and names the symptom
      // rather than the cause the agent had already stated.
      //
      // Both signals have to agree before this fires. The agent's own report
      // that it changed nothing is a claim (see `parseCompletion`), and the
      // worktree observation is empty outside a git repository and whenever
      // `git status` could not be read — so either alone would fail runs that
      // worked. A service that already carried TraceRoot is excluded too: there
      // the right amount of editing may genuinely be none.
      const changedNothing =
        reported !== null &&
        reported.filesChanged.length === 0 &&
        observedChangedFiles.length === 0 &&
        ctx.stack?.existingInstrumentation.present !== true;
      if (changedNothing) {
        throw new PausedSetupError({
          stage: "instrument",
          code: "AGENT_FAILED",
          message: [
            `${adapter.displayName} finished without changing any files, so ${service.path} is not instrumented.`,
            reported.notes === null ? null : `It reported: ${oneLine(reported.notes)}`,
          ]
            .filter((part) => part !== null)
            .join(" "),
          remedy: [
            "An agent that reports no edits was usually stopped from making them — a refused command, or a package install with nowhere writable to cache.",
            "Clear what blocked it and rerun:",
            "  traceroot setup --resume",
            "Or write the task out and run it yourself:",
            "  traceroot setup --no-instrument",
          ].join("\n"),
        });
      }

      // Exit 0, and the service still has no TraceRoot in it.
      //
      // The guard above cannot fire without the agent's own report, so an agent
      // that finishes without emitting one is not covered by it at all — which
      // is what the run that prompted this did. No completion block, the SDK
      // installed into `.venv`, not one line of `main.py` touched, the stage
      // recorded as done, `verify_application` passing on untouched code, and
      // then two minutes of trace spinner before the failure blamed the
      // instrumented path for never running. Every one of those was true and
      // none of them was the answer, which had been available the moment the
      // agent exited.
      //
      // So this asks the question rather than inferring it from how many files
      // moved: {@link findTraceRootInitialization} is the reading
      // `detect_stack` makes for `existingInstrumentation`, re-run now that the
      // agent has finished. It reads files, not a diff, so it holds in a
      // repository that is not under git — where `observedChangedFiles` is
      // empty whatever happened, and the inference above is therefore blind.
      //
      // Both ways the agent can be right are allowed for. It is not required to
      // have edited the entry point: whatever it reported changing and whatever
      // git saw change are read too, because a call wired into a module the
      // entry point imports is instrumentation. And a service that already
      // carried TraceRoot is excluded, for the same reason it is excluded
      // above — there the right amount of editing may genuinely be none.
      //
      // Only ever a positive finding of absence. An entry point that could not
      // be identified is not evidence of anything, so there the stage says
      // nothing and the run carries on.
      const entryPoint = serviceEntryPath(service);
      if (ctx.stack?.existingInstrumentation.present !== true && entryPoint !== null) {
        //
        // With no report and no diff, both of those lists are empty and the
        // reading narrows to the entry point alone — which fails a run that put
        // the call in a module the entry point imports, the case allowed for
        // just above. Neither input is exotic: `reported` is null for any agent
        // that does not emit the completion fence, which for Codex is the
        // expected state rather than the exception, and `changedFiles` is empty
        // in every repository that is not under git. So when the agent reported
        // nothing, the service's own directory goes in, and a directory
        // candidate is read as the same bounded source scan a directory git
        // reported already gets — not a tree walk.
        const wiredIn = findTraceRootInitialization(ctx.root, service, [
          ...(reported?.filesChanged ?? []),
          ...observedChangedFiles,
          ...(reported === null ? [service.path] : []),
        ]);
        if (wiredIn === null) {
          throw new PausedSetupError({
            stage: "instrument",
            code: "AGENT_FAILED",
            message: [
              `${adapter.displayName} finished, but the service is still not instrumented: there is no TraceRoot initialization in ${entryPoint}.`,
              reported === null || reported.notes === null
                ? null
                : `It reported: ${oneLine(reported.notes)}`,
            ]
              .filter((part) => part !== null)
              .join(" "),
            remedy: [
              "Exit 0 is the agent saying it finished, not that it wired anything up — a refused command and an exhausted context both end that way.",
              "Nothing was reverted, so a rerun picks up from whatever it did get done:",
              "  traceroot setup --resume",
              "Or write the task out and run it yourself:",
              "  traceroot setup --no-instrument",
            ].join("\n"),
          });
        }
      }

      const sdkCheck = await checkSdkImportable(ctx, deps, service, sdk, agentCwd);
      if (sdkCheck !== null && !sdkCheck.importable) {
        const install = installCommand(sdk, service, service.language, sdkCheck.interpreter);
        throw new PausedSetupError({
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
 * Everything up to here was reversible — a key, a line in the project's env file, a
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
      { value: "abort", label: "Abort", hint: `cancel setup without running ${agentName}` },
    ],
    initialValue: "confirm",
  });

  if (answer !== "confirm") {
    throw new SetupError({
      stage: "instrument",
      code: "CANCELLED",
      message: `Setup cancelled — ${agentName} was not run, so no code was changed.${keptOnCancel(ctx)}`,
      remedy: [
        "To get the same instructions without an agent editing anything:",
        "  traceroot setup --no-instrument     writes the task for your own agent",
        "  traceroot setup --manual            prints the steps",
      ].join("\n"),
    });
  }
}

/**
 * What a run cancelled at the launch keeps: ` Setup kept …`, or nothing.
 *
 * The cancel used to close on "nothing was changed", which by this question is
 * false: the skill is installed, and a sign-in has written the CLI's config. The
 * rollback that follows takes back the keys this run minted and what it wrote
 * to the env file, and names each, including any key it could not revoke. It
 * never touches the skill. It puts the config back when the key there is one
 * this run minted and then revokes, and says which it did; a config holding a
 * key this run did not mint, it leaves. Worked out before the rollback runs, so
 * this claims only what the rollback is certain to leave.
 */
function keptOnCancel(ctx: SetupContext): string {
  const kept: string[] = [];
  const skill = requireAgent(requireDetectedAgent(ctx).id).getSkillInstallPath(
    ctx.root,
    SKILL_NAME,
  );
  if (existsSync(skill)) {
    kept.push(`the TraceRoot skill in ${displaySkillPath(ctx.root, skill)}`);
  }
  // The two routes that sign in on the user's behalf write it, and no other does.
  const wroteIt = ctx.session?.via === "user-credential" || ctx.session?.via === "pasted-key";
  if (wroteIt && !wroteConfig.has(ctx)) {
    kept.push("the CLI's config");
  }
  return kept.length === 0 ? "" : ` Setup kept ${kept.join(" and ")}.`;
}

// ── VERIFY_APPLICATION ──────────────────────────────────────────────────────

/**
 * The tail of a failing run's output: enough to see the error, little enough
 * that a chatty test suite does not bury the remedy underneath it.
 */
function outputTail(output: string): string {
  return output.split("\n").slice(-25).join("\n").trim();
}

/**
 * Every file the application could read this run's credential out of.
 *
 * Not "the file this run wrote", which is what the credential-free run used to
 * be told. `configure_repository` writes nothing when the key already resolved
 * from the project's own `.env` — `applicationCanResolve` returns true and the
 * stage is satisfied before it runs — so there is no file of ours to name,
 * while the file the entry point loads sits on disk holding the key. The
 * credential-free run then had the credential and the check passed without
 * being made.
 *
 * A candidate earns its place by holding *this* credential, which is the test
 * {@link credentialEnvFile} already applies before naming a file to the agent.
 * An unrelated `.env`, or one holding a different project's key, is left alone.
 * `ctx.cwd` is in the list because that is where `resolveAuth` looks for the
 * `.env` it auto-discovers, and for a service in a subdirectory that is not the
 * same file as {@link credentialEnvPath}.
 */
function applicationCredentialFiles(ctx: SetupContext): string[] {
  const key = ctx.credential?.key.reveal();
  if (key === undefined) {
    return [];
  }
  const files: string[] = [];
  for (const path of [ctx.credentialEnvFile, credentialEnvPath(ctx), join(ctx.cwd, ".env")]) {
    if (
      path === undefined ||
      files.includes(path) ||
      !existsSync(path) ||
      !holdsKey(envFileKey(path), key)
    ) {
      continue;
    }
    files.push(path);
  }
  return files;
}

const verifyApplicationStage: StageDefinition = {
  stage: "verify_application",
  // An inconclusive result is settled, not pending. Re-running a suite that was
  // already failing produces the same answer and costs the same minutes, so a
  // resume takes the recorded one.
  isSatisfied: (ctx) =>
    ctx.application?.outcome === "passed" || ctx.application?.outcome === "inconclusive",
  restore(ctx) {
    if (ctx.checkpoint.application !== undefined) {
      ctx.application = ctx.checkpoint.application;
    }
  },
  async run(ctx, deps) {
    const service = requireService(ctx);
    const credential = requireCredential(ctx);
    const command = service.testCommand;

    if (command === null) {
      ctx.application = {
        command: null,
        baseline: null,
        run: { ran: false, exitCode: null, durationMs: 0 },
        outcome: "skipped",
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
      // What the same command did before anything was instrumented, or null on
      // a route that instrumented nothing. Absent is not "it passed": it is
      // "nobody looked", and the failure path below says so rather than naming
      // a cause it cannot establish.
      baseline: ctx.checkpoint.applicationBaseline ?? null,
      cwd: service.path === "." ? ctx.root : join(ctx.root, service.path),
      parentEnv: deps.env,
      // The same virtualenv the baseline measured in. `detect_stack` names the
      // check as the project documents it — `pytest`, not `.venv/bin/pytest` —
      // and that command resolves for the user because their shell has the
      // virtualenv activated. Without this the check below spawns against the
      // CLI's own environment and fails with ENOENT after the instrumentation
      // itself had succeeded, which reads to the user as changes that broke
      // their suite. It is also the comparison's premise: a baseline taken in
      // one environment and a verification taken in another are not the same
      // measurement, so the two must not disagree about where `pytest` is.
      //
      // Resolved here rather than carried over from `instrument`. Creating the
      // virtualenv is one of the things the agent is told to do, so an answer
      // from before the launch is null in exactly the case this matters; and
      // this stage also runs on a resume, where nothing instrumented anything
      // in this process and there is no earlier answer to carry. The import
      // check resolves it again for the first of those reasons.
      interpreter:
        service.language === "python"
          ? detectPythonEnvironment(ctx.root, service.path, deps.env).interpreter
          : null,
      credential: credential.key,
      // The credential-free run is only credential-free if the key goes out of
      // every file the entry point loads for itself, not just the one this run
      // wrote — see {@link applicationCredentialFiles}. An empty list is an
      // answer rather than an omission: a key that reaches the application only
      // through the environment is withheld by building that environment
      // without it.
      credentialFiles: applicationCredentialFiles(ctx),
      runProcess: deps.runProcess,
      signal: ctx.signal,
    });
    ctx.application = verification;
    ctx.checkpoint.application = verification;

    // A command that never started is not "inconclusive" in the sense this
    // branch means. `outcome` is inconclusive whenever nothing baselined the
    // check, and a command that cannot spawn cannot be baselined either, so
    // without the second half of this condition it is unconditionally true for
    // exactly the case a spawn failure is: the run warns that the suite "does
    // not pass" — which asserts it ran — and then carries on as though the
    // check had been made.
    //
    // Third incarnation of one bug, which is why this is spelled out rather
    // than left to the next reader. cli#153 was "instrumentation blamed for a
    // suite that was already failing". The fix for that warned on the
    // baseline's exit code, which fired when the baseline had not run at all.
    // The fix for *that* is the branch below, and it swallowed a command that
    // could not be started. All three conflated "did not run" with "ran and
    // failed"; a fourth will too unless the distinction is made here.
    if (verification.outcome === "inconclusive") {
      // Not a failure of this run, by one of two routes, and the sentence has
      // to say which. Measured and already red is a finding about the project.
      // Never measured is the absence of one, and it carries the failing output
      // because nothing else in the run explains it. Said once, plainly, and
      // then the run carries on to the thing it can still establish: whether a
      // trace arrives.
      wizardWarn(
        ctx,
        verification.baseline?.ran === true
          ? `${command} does not pass on this project yet. It was failing before setup changed anything, so it cannot show whether the instrumentation is correct — nothing here is evidence against the changes.`
          : `This run could not establish whether ${command} passes: nothing ran it before the code was instrumented, and the run after did not succeed either.${failure === null ? "" : `\n\n${outputTail(failure.output)}`}`,
      );
      return "skipped";
    }

    if (!verification.passed) {
      const tail = failure === null ? "" : `\n\n${outputTail(failure.output)}`;
      // Only one of these three is a claim this run can support. "Failed after
      // instrumentation" was printed whether or not anything had established
      // that it passed before — which on a suite that was already red sent the
      // user looking for a fault in work that had just been done correctly.
      const measuredBefore = verification.baseline?.ran === true;
      const message = measuredBefore
        ? `\`${command}\` passed before this run instrumented anything, and fails now.${tail}`
        : `\`${command}\` failed. Setup did not run it beforehand, so whether the instrumentation caused this is not established.${tail}`;
      // Paused, which is what this remedy has always promised and what the
      // rollback used to contradict: the run revoked the key and took the
      // credential back out of the env file, and then told the user to resume
      // with it.
      throw new PausedSetupError({
        stage: "verify_application",
        code: "APP_VERIFICATION_FAILED",
        message,
        remedy:
          "Nothing was reverted. Fix the failure, then rerun `traceroot setup --resume` to finish verification.",
      });
    }

    // What ran, and only then what it shows. The check ran with TraceRoot
    // switched off, so a pass says the application does not depend on TraceRoot
    // being configured — when the code it ran was the agent's instrumentation.
    // A route that hands the task over edits nothing and takes no baseline, and
    // its check ran on code setup had not touched, so the line says that and
    // nothing about TraceRoot: any claim about it there would be about
    // instrumentation the check never saw. The report reads the same field and
    // says the same thing.
    wizardProgress(
      ctx,
      verification.baseline === null
        ? "Application passes its checks. Setup made no edits itself, so this checked your code as it is."
        : "Application passes its checks with TraceRoot switched off, so it doesn't depend on TraceRoot being configured.",
    );
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
    const session = requireSession(ctx);
    // The wizard's own client, not the generated one. The single read this
    // stage makes must not depend on which operations the tool registry chooses
    // to expose — it is the same public endpoint either way.
    //
    // Read on the user's own credential, never the application's. The
    // application's key is ingest-scoped: it can send telemetry and nothing
    // else, which is the whole point of giving the repository its own. Reading
    // traces with it worked only because the trace routes do not enforce scope
    // yet, so this stage would have broken on the day they started to.
    const client = deps.createSetupApi({
      host: session.host,
      apiKey: session.userKey.reveal(),
      timeoutMs: 15_000,
    });

    // How long to wait is a question about what can still send a trace — see
    // {@link traceCanArrive}, and note that setup's own check is not one of
    // those things.
    //
    // When something can, the whole budget. Ingest lags the run that sent the
    // trace, and the agent's run of the application may have ended a second
    // ago, so a single look straight after it reports a timeout for a trace
    // that was a moment from arriving. When nothing can, one look and no
    // spinner: waiting two minutes for a trace nothing could send is the wizard
    // patiently hoping for something it already knows cannot happen, and the
    // one look still finds a trace the user sent before they resumed.
    const canArrive = traceCanArrive(ctx);
    const timeoutMs = canArrive ? ctx.flags.traceTimeoutSec * 1000 : 0;

    // A hand-over that nothing has acted on, which decides how the stage ends
    // when that one look finds nothing.
    //
    // `--no-instrument`, `--manual` and the task-file answer all leave the
    // repository exactly as they found it, and the stage that did so recorded
    // that as `mode: "prompt-only"` — read here rather than re-derived, because
    // the branch that hands over is the only thing that knows it did.
    //
    // Whether that leaves the service uninstrumented is the other half, and
    // `detect_stack` already answered it: `existingInstrumentation.present` is
    // an actual `initialize()` call in the entry point, measured before the
    // hand-over. A hand-over changes no code, so on this route that reading is
    // still current — and a repository the user had instrumented by hand before
    // running setup is therefore not caught by this, which is the point. It
    // still gets its full wait and its verification.
    //
    // Nothing on this route can send a trace, so `traceCanArrive` has already
    // given it one look rather than the budget; what this adds is the ending.
    const unrunHandover =
      ctx.instrumentation?.mode === "prompt-only" &&
      ctx.stack?.existingInstrumentation.present !== true
        ? ctx.instrumentation
        : null;
    // The other long unattended wait. Nothing arrives to report on until the
    // trace does, so the elapsed counter is the whole of what a user can be
    // told — and it is the difference between waiting and suspecting a hang.
    //
    // A blank rail line above it, the same way the agent block gets one: this
    // is the run's other two-minute wait and it sat flush against the
    // verification lines over it, reading as one more of them rather than as
    // the state of the whole run. Written only when the spinner is: with
    // nothing to wait for no line is drawn at all, and a `--json` run has no
    // frame for one to sit in, so either way the gap would be a blank line with
    // nothing under it.
    let waiting: LineSpinner | null = null;
    if (!ctx.json && canArrive) {
      wizardLine(ctx, "");
      waiting = startLineSpinner({
        sink: ctx.writers.err,
        message: `Waiting for your first trace (up to ${ctx.flags.traceTimeoutSec}s)`,
      });
    }

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
    // The size, whatever it is. This is the one line in the run where the
    // application's own output arrives, and the count is the one thing a list
    // row says about how much of the application the trace shows — stated, and
    // never judged, because whether it is enough depends on the program.
    // Omitted rather than guessed at when the response did not carry a count.
    const received =
      outcome.found && outcome.attribution.spanCount !== null
        ? `First trace received (${spanPhrase(outcome.attribution.spanCount)}).`
        : "First trace received.";
    waiting?.stop(
      outcome.found ? received : `No trace after ${Math.round(outcome.waitedMs / 1000)}s.`,
    );

    if (!outcome.found && unrunHandover !== null) {
      // Named before "nothing ran it", because it is the cause underneath it —
      // and ended as a pause, not a failure, because nothing has failed.
      //
      // This route reported a missing trace as "nothing has run your
      // application", which sent the user off to run an application that has
      // no TraceRoot in it — a loop that cannot terminate, since running it
      // again produces the same nothing. Then as a stopped run, which was no
      // better: a red `error:` block and exit 14 over the very hand-over the
      // user had just chosen, read as a crash. The instrumentation is simply
      // the user's to do now, so the run ends normally and the closing block
      // in `commands/setup/run.ts` says what is outstanding. Nothing is
      // recorded as the trace, so `--resume` looks again; the key stays put,
      // because the resume needs it.
      return "skipped";
    }

    if (!outcome.found && !canArrive) {
      // Say the actual reason rather than reporting a timeout that never
      // really elapsed. Nothing in this run could have sent a trace, so there
      // is nothing to have waited for — and the reason is about what runs the
      // application, not about whether setup found a test command, because
      // setup's own check sends nothing either way.
      throw new PausedSetupError({
        stage: "verify_trace",
        code: "TRACE_TIMEOUT",
        message:
          "No trace yet, and nothing has run your application: setup did not run it, and found no TraceRoot initialization in it, so nothing else could have sent a trace either.",
        remedy: [
          "Instrument it if you have not yet, run it once, then:",
          "  traceroot setup --resume",
        ].join("\n"),
      });
    }

    if (!outcome.found) {
      throw new PausedSetupError({
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

    // Kept on the record rather than only mentioned. The report is rendered
    // from this, including on a `--resume` that rehydrates it from the
    // checkpoint, so a count held only in this invocation would leave a later
    // run's report without it.
    const spanCount = outcome.attribution.spanCount;
    const trace = spanCount === null ? outcome.trace : { ...outcome.trace, spanCount };
    ctx.trace = trace;
    ctx.checkpoint.trace = trace;
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
      await rollback(ctx, deps, error);
      ctx.emit({
        event: "result",
        ok: false,
        data: resultData(ctx),
        error: { stage, code: error.code, message: error.message },
      });
      return { ok: false, stagesRun, checkpoint: ctx.checkpoint, trace: null, error };
    }
  }

  // Nothing is orphaned any more: the keys this run minted are the ones it just
  // finished installing. Cleared so the record means what it says — keys a
  // setup run created and no run put into service.
  if ((ctx.checkpoint.mintedKeys ?? []).length > 0) {
    ctx.checkpoint.mintedKeys = [];
    writeCheckpoint(ctx.artifactDir, ctx.checkpoint);
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
 * Undoes only what this run created, and only once the run is over.
 *
 * A paused run is left exactly as it is. That used to be decided by whether
 * `--resume` was on the command line, which is a fact about the *previous* run
 * and says nothing about how this one ended: a first run that stopped at
 * verification printed "rerun `traceroot setup --resume` to finish" and then
 * revoked the key the resume would have needed. The failure says which ending
 * it is now — see {@link PausedSetupError}.
 *
 * Every part works from what this run recorded as it went, never from a path
 * or a credential recomputed here, so none can reach anything a previous run
 * left behind.
 */
async function rollback(ctx: SetupContext, deps: SetupDeps, error: SetupError): Promise<void> {
  if (error instanceof PausedSetupError) {
    return;
  }

  const revoked = await revokeMintedKeys(ctx, deps);
  restoreCliConfig(ctx, deps, revoked);
  restoreEnvFile(ctx);
}

/**
 * Revokes every key this run minted, and says which.
 *
 * Named, because the user cannot act on "a key". The failure they are reading
 * is about something else entirely, and a line that says a credential appeared
 * and was taken away again is only useful if they can match it to a row in
 * their project's key list.
 *
 * Best-effort per key, and the ones that could not be revoked are reported as
 * still live with where to remove them. A revoke needs the network and a
 * session, which are two of the things that fail in the first place; claiming a
 * rollback that did not happen would leave the user believing a live key is
 * gone. So does a deployment without the route for a sign-in's keys, and a
 * user whose role may mint a key but not revoke one.
 *
 * Each key goes back through the kind of credential that minted it. The two
 * keys a sign-in mints used to be sent to the key-authenticated route on the
 * user's token, which that route refuses outright, so every one of them was
 * reported as still live.
 *
 * Returns the ids it revoked.
 */
async function revokeMintedKeys(ctx: SetupContext, deps: SetupDeps): Promise<ReadonlySet<string>> {
  const minted = mintedKeys.get(ctx) ?? [];
  if (minted.length === 0) {
    return new Set();
  }

  const revoked: MintedKey[] = [];
  const kept: MintedKey[] = [];
  for (const key of minted) {
    try {
      if (key.authenticatedBy === "user") {
        await key.api.revokeProjectApiKey(key.projectId, key.id);
      } else {
        await key.api.revokeApiKey(key.id);
      }
      revoked.push(key);
    } catch {
      kept.push(key);
    }
  }

  if (revoked.length > 0) {
    wizardProgress(ctx, `Revoked ${describeKeys(revoked)}, created by this run.`);
  }
  if (kept.length > 0) {
    wizardWarn(
      ctx,
      `could not revoke ${describeKeys(kept)}, created by this run — ${kept.length === 1 ? "it is" : "they are"} still live. Delete ${kept.length === 1 ? "it" : "them"} from the project's API keys at ${deps.resolvedAuth.hostUrl.value ?? ctx.session?.host ?? "your TraceRoot deployment"}.`,
    );
  }

  // The durable record keeps exactly what is still out there.
  const remaining = new Set(kept.map((key) => key.id));
  const mine = new Set(minted.map((key) => key.id));
  ctx.checkpoint.mintedKeys = (ctx.checkpoint.mintedKeys ?? []).filter(
    (key) => !mine.has(key.id) || remaining.has(key.id),
  );
  writeCheckpoint(ctx.artifactDir, ctx.checkpoint);
  return new Set(revoked.map((key) => key.id));
}

/** `name (hint)` for each, which is how the dashboard's key list reads. */
function describeKeys(keys: readonly MintedKey[]): string {
  const listed = keys.map((key) => `${key.name ?? "an unnamed key"} (${key.hint})`).join(", ");
  return keys.length === 1 ? `the API key ${listed}` : `the ${keys.length} API keys ${listed}`;
}

/**
 * Takes this run's credential back out of the project's env file.
 *
 * Not conditional on a key having been minted, which is what it used to be: the
 * line is just as stale when the credential came from the sign-in stage, and
 * that is the commonest route. A `TRACEROOT_API_KEY` left in a project's own
 * configuration naming a key no run is using is worse than untidy — the next
 * person to ask why no traces are arriving finds a configured credential,
 * concludes configuration is done, and looks somewhere else.
 *
 * Only the keys this run wrote come out, so every other line in the file is
 * left exactly as it was; `configure_repository` writes into one of the
 * project's own files, which may be full of things that have nothing to do with
 * TraceRoot. A key the file already had is put back rather than taken out — see
 * {@link restoreReplacedValues}.
 *
 * A file this run *created* is removed outright once nothing but its own header
 * is left in it. That header says "Created by `traceroot setup`. This file
 * contains a live API key" — true when it was written and false the moment the
 * key comes out — and a `.env` that exists at all is read as configuration by
 * the next tool to look. A file that was already there is never removed,
 * whatever is left in it: it is the user's.
 */
function restoreEnvFile(ctx: SetupContext): void {
  const written = wroteEnvKeys.get(ctx);
  if (written === undefined || written.keys.length === 0) {
    return;
  }
  const shown = relativeToRoot(ctx.root, written.path);
  if (Object.keys(written.previous).length > 0) {
    restoreReplacedValues(ctx, written, shown);
    return;
  }
  try {
    const removed = removeEnvKeys(written.path, written.keys);
    if (written.created && holdsNothingButComments(written.path)) {
      rmSync(written.path, { force: true });
      wizardProgress(ctx, `Removed ${shown}, which this run created.`);
      return;
    }
    if (removed.length > 0) {
      wizardProgress(ctx, `Removed ${removed.join(", ")} from ${shown}.`);
    }
  } catch {
    wizardWarn(
      ctx,
      `could not take ${written.keys.join(", ")} back out of ${shown}; that line names a key this run did not finish setting up, so remove it by hand`,
    );
  }
}

/**
 * Puts back the values this run wrote over, and takes out the keys it added.
 *
 * Deleting a replaced line was a full undo only while setup wrote a file of its
 * own. Now that it writes the project's, a rerun that replaced a working
 * `TRACEROOT_API_KEY` and then failed, or was cancelled, left the application
 * with no key at all — under a closing line saying nothing was changed.
 *
 * Byte for byte when nothing has touched the file since this run wrote it, so
 * the line comes back as it was spelt, an `export` or quotes included. When
 * something has, key by key, so that change survives too.
 */
function restoreReplacedValues(
  ctx: SetupContext,
  written: NonNullable<ReturnType<typeof wroteEnvKeys.get>>,
  shown: string,
): void {
  const replaced = Object.keys(written.previous);
  const added = written.keys.filter((key) => !replaced.includes(key));
  try {
    if (written.before !== null && readFileSync(written.path, "utf8") === written.after) {
      writeFileSync(written.path, written.before, { mode: 0o600 });
    } else {
      removeEnvKeys(written.path, added);
      upsertEnvFile(written.path, written.previous);
    }
    wizardProgress(ctx, `Restored the previous ${replaced.join(", ")} in ${shown}.`);
    if (added.length > 0) {
      wizardProgress(ctx, `Removed ${added.join(", ")} from ${shown}.`);
    }
  } catch {
    wizardWarn(
      ctx,
      `could not put the previous ${replaced.join(", ")} back into ${shown}; it now names a key this run did not finish setting up, so restore it by hand`,
    );
  }
}

/** Whether a dotenv file has nothing left in it but blank lines and comments. */
function holdsNothingButComments(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // Gone already, or unreadable. Either way this is not the function that
    // decides to delete something it cannot see.
    return false;
  }
  return content
    .split("\n")
    .every((line) => line.trim() === "" || line.trimStart().startsWith("#"));
}

/**
 * What a sign-in wrote into the CLI's config, when the key it wrote is one this
 * run minted and the file could be read either side of the write: the key and
 * its id, and the file's text before (null for no file) and just after. Present
 * exactly when the rollback will act on the config.
 */
const wroteConfig = new WeakMap<
  SetupContext,
  { keyId: string; key: string; before: string | null; after: string }
>();

/** The CLI config's text, null when there is none, or undefined when it cannot be read. */
function configText(deps: SetupDeps): string | null | undefined {
  try {
    return deps.readConfigText();
  } catch {
    return undefined;
  }
}

/**
 * Puts the CLI's config back once the rollback has revoked the key this run
 * wrote into it.
 *
 * Left as it was, every later command would sign in with a key that no longer
 * exists: hidden while a saved sign-in outranks it, and the first thing to fail
 * after `traceroot logout`. The same rule as the env file: byte for byte when
 * nothing has touched the file since this run wrote it, and field by field when
 * something has, so that change survives. A field something else has changed
 * since is that thing's, and is left alone.
 *
 * A key the rollback could not revoke still works, so the config holding it is
 * kept, and said to be, under the line naming that key as still live.
 */
function restoreCliConfig(ctx: SetupContext, deps: SetupDeps, revoked: ReadonlySet<string>): void {
  const wrote = wroteConfig.get(ctx);
  if (wrote === undefined) {
    return;
  }
  try {
    const now = deps.readConfigText();
    // Removed since, or holding another key: it no longer names this run's.
    if (now === null || !namesKey(now, wrote.key)) {
      return;
    }
    if (!revoked.has(wrote.keyId)) {
      wizardProgress(ctx, "Kept the CLI's config, since the key in it still works.");
      return;
    }
    const restored = now === wrote.after ? wrote.before : configFieldsRestored(now, wrote);
    deps.restoreConfigText(restored);
    wizardProgress(
      ctx,
      restored === null
        ? "Removed the CLI's config, which this run created."
        : wrote.before === null
          ? "Removed the revoked key from the CLI's config."
          : "Restored the CLI's previous config.",
    );
  } catch {
    wizardWarn(
      ctx,
      "could not put the CLI's config back, and it names a key this run revoked; run `traceroot login` to replace it",
    );
  }
}

/**
 * The config's text with every field still as this run's write left it put
 * back as it was before — present with its old value, or absent — and every
 * field something has changed since left as that thing left it. Null when that
 * leaves nothing in a file this run created.
 */
function configFieldsRestored(
  now: string,
  wrote: NonNullable<ReturnType<typeof wroteConfig.get>>,
): string | null {
  const parse = (text: string | null): Record<string, unknown> =>
    text === null ? {} : (JSON.parse(text) as Record<string, unknown>);
  const current = parse(now);
  const previous = parse(wrote.before);
  const left = parse(wrote.after);
  const restored: Record<string, unknown> = {};
  for (const field of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    const untouched =
      field in current ? field in left && current[field] === left[field] : !(field in left);
    const from = untouched ? previous : current;
    if (field in from) {
      restored[field] = from[field];
    }
  }
  if (wrote.before === null && Object.keys(restored).length === 0) {
    return null;
  }
  return `${JSON.stringify(restored, null, 2)}\n`;
}

/** Whether a config's text holds `key` as its API key. */
function namesKey(text: string, key: string): boolean {
  try {
    return (JSON.parse(text) as { api_key?: unknown } | null)?.api_key === key;
  } catch {
    return false;
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
            // `passed` is kept for the consumers that already read it, and is
            // true only for an outright pass. `outcome` is what distinguishes
            // the two false cases, which a reader acts on differently.
            passed: ctx.application.passed,
            outcome: ctx.application.outcome,
            // Both, because the exit code alone cannot say which kind of
            // nothing it is: a baseline that was never taken and one that
            // could not be spawned both report a null code, and only the
            // second is a fact about this run.
            baseline_ran: ctx.application.baseline?.ran ?? false,
            baseline_exit_code: ctx.application.baseline?.exitCode ?? null,
            // The check itself, which runs once and with TraceRoot switched
            // off. It replaced a pair, and `ran_without_credentials` was the
            // pair's second half.
            ran: ctx.application.run.ran,
            skipped_reason: ctx.application.skippedReason,
          };
    case "verify_trace":
      return ctx.trace === undefined
        ? undefined
        : {
            trace_id: ctx.trace.traceId,
            trace_url: ctx.trace.traceUrl,
            waited_ms: ctx.trace.waitedMs,
            // Null for "the response did not say", which a consumer has to be
            // able to tell apart from a trace it should go and look at. The
            // warning reaches json mode as a `warn` event; this is the number
            // behind it, so a caller does not have to parse the sentence.
            span_count: ctx.trace.spanCount ?? null,
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
    // Four values, because "did not pass" and "could not say" are different
    // answers and a consumer branches on them differently.
    application_outcome: ctx.application?.outcome ?? null,
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
