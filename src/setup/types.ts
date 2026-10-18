import type { AgentId } from "../agents/types.js";
import type { Writers } from "../output.js";
import type { PackageManager } from "../repo/detect.js";
import type { SetupError, SetupErrorCode } from "./errors.js";
import type { SetupEvent } from "./events.js";
import type { Secret } from "./secret.js";

/**
 * The stages of `traceroot setup`, in the only order they ever run. A stage may
 * be skipped (already satisfied, or disabled by a flag) but the sequence is
 * fixed — that is what makes a checkpoint's `completedStages` a meaningful
 * resume point.
 */
export const SETUP_STAGES = [
  "precheck",
  "authenticate",
  "select_context",
  "acquire_project_key",
  "configure_repository",
  "detect_stack",
  "select_agent",
  "install_agent_context",
  "instrument",
  "verify_application",
  "verify_trace",
  "complete",
] as const;

export type SetupStage = (typeof SETUP_STAGES)[number];

/** Outcome of a single stage. `skipped` is a success, not a failure. */
export type SetupStageStatus = "ok" | "skipped" | "failed";

/** An authenticated *user* session. The user key is never given to a child process. */
export interface AuthSession {
  host: string;
  uiBaseUrl: string;
  userKey: Secret;
  workspaceId: string;
  workspaceName: string | null;
  /** How the session was established; recorded (non-secret) for doctor. */
  via: "existing-config" | "pasted-key" | "flag" | "env" | "user-credential";
}

/** The project this repository will send traces to. */
export interface ProjectSelection {
  projectId: string;
  projectName: string;
  workspaceId: string;
  origin: "existing" | "created" | "from-session" | "from-flag" | "from-whoami";
}

/**
 * The *application* credential. Distinct from {@link AuthSession.userKey}: this
 * is what the instrumented app authenticates with, it is handed to child
 * processes through a scoped environment, and only its id and hint are ever
 * persisted.
 */
export interface ProjectCredential {
  key: Secret;
  keyId: string | null;
  keyName: string | null;
  projectId: string;
  expiresAt: string | null;
  origin: "minted" | "reused" | "existing-config";
}

/** Languages the CLI can drive an instrumentation run for. */
export type StackLanguage = "python" | "typescript" | "javascript";

/** One candidate application within the repository. */
export interface DetectedService {
  /** Repo-root-relative path; `.` for a root-level service. */
  path: string;
  language: StackLanguage;
  framework: string | null;
  entryPoint: string | null;
  packageManager: PackageManager | undefined;
  /** The project's own verification command, e.g. `npm test`. */
  testCommand: string | null;
  /** Why this candidate was produced, e.g. `pyproject.toml in api/`. */
  evidence: string[];
  /**
   * True when no manifest identified this service and the language came from
   * the user. The CLI has not chosen a target; the agent must find it, and the
   * task tells it to ask rather than guess.
   */
  agentMustIdentify?: boolean;
}

export interface DetectedStack {
  root: string;
  services: DetectedService[];
  /**
   * True when the repository offers more than one candidate and no flag
   * disambiguated it. Setup stops rather than guessing.
   */
  ambiguous: boolean;
  selected: DetectedService | null;
  /** Languages seen but not supported for instrumentation (e.g. Go, Java). */
  unsupportedLanguages: string[];
  existingInstrumentation: { present: boolean; evidence: string[] };
}

/** A coding agent, with `runnable` distinguished from merely `configured`. */
export interface DetectedAgent {
  id: AgentId;
  displayName: string;
  /** The agent's binary resolves on PATH — only these can actually be launched. */
  runnable: boolean;
  /** A configuration directory exists (project-local or in the home directory). */
  configured: boolean;
  evidence: string[];
  /**
   * Why a binary that does resolve on PATH still cannot be launched, as one
   * line naming the remedy. Only ever set alongside `runnable: false`.
   */
  unlaunchable?: string;
}

/** What the instrumentation stage did, and what actually changed on disk. */
export interface InstrumentationResult {
  agentId: AgentId;
  mode: "interactive" | "background" | "prompt-only";
  exitCode: number;
  durationMs: number;
  /**
   * The agent's self-reported completion block, when it emitted a parseable
   * one. Diagnostics only — never used to decide pass/fail.
   */
  reported: {
    filesChanged: string[];
    sdkVersion: string | null;
    traceId: string | null;
    notes: string | null;
  } | null;
  /** From `git status --porcelain`: what changed, independent of any claim. */
  observedChangedFiles: string[];
  /** Where the prompt was written, when `mode` is `prompt-only`. */
  promptPath: string | null;
}

/** One execution of the project's own verification command. */
export interface VerificationRun {
  ran: boolean;
  exitCode: number | null;
  durationMs: number;
}

/**
 * What the application check established.
 *
 * `passed` and `failed` are claims about the instrumented application.
 * `inconclusive` is a claim about the *check* — that its result afterwards
 * says nothing about the instrumentation — and it covers the two ways that
 * happens: the check was measured before anything changed and was failing
 * then, or it was never measured, so there is nothing its result can be
 * compared against. Reporting either as a failure sent users to look for a
 * fault in work that had just been done correctly. `skipped` is no command to
 * run at all.
 *
 * Four values rather than a boolean because the fourth has to survive into the
 * report and the `--json` envelope, where a reader has only the field to go on.
 */
export type VerificationOutcome = "passed" | "failed" | "inconclusive" | "skipped";

export interface ApplicationVerification {
  /** The command as run. Never contains a secret. */
  command: string | null;
  /**
   * The same command before anything was instrumented, or null when no baseline
   * was taken — a run that hands the task over edits nothing, and a checkpoint
   * written before baselines existed carries none.
   *
   * This is what makes a later failure attributable. Without it, "the suite
   * fails" and "the suite still fails" are indistinguishable.
   */
  baseline: VerificationRun | null;
  withCredentials: VerificationRun;
  /** Proves the app still behaves with `TRACEROOT_API_KEY` absent. */
  withoutCredentials: VerificationRun;
  outcome: VerificationOutcome;
  /**
   * Whether the instrumented application passed its own check.
   *
   * Narrower than `outcome !== "failed"`: it is true only for `passed`. An
   * inconclusive run did not establish that the application passes, so this is
   * false there — `outcome` is what says that the reason lies with the project's
   * own suite rather than with the instrumentation.
   */
  passed: boolean;
  skippedReason: string | null;
}

export interface TraceVerification {
  traceId: string;
  /** The backend's own permalink, echoed verbatim — never constructed here. */
  traceUrl: string;
  observedAt: string;
  waitedMs: number;
  /**
   * How many spans the trace holds; absent when the response did not say.
   *
   * The one thing a list row carries about how much of the application a trace
   * covers, and the reason it is kept on the record rather than only remarked
   * on: `--resume` rehydrates the trace from the checkpoint and renders the
   * report from it, so a count that lived only in the invocation that polled
   * would let a resumed run print the unqualified verdict over the very trace
   * the first run had qualified.
   *
   * Absent rather than null, because a response that did not carry the field
   * leaves exactly one thing to say and two spellings of it would both have to
   * be handled by every reader.
   */
  spanCount?: number;
}

/**
 * The resumable, **non-secret** record of a setup run. Every field is either a
 * plain scalar or a structure with no {@link Secret} in it; a test asserts that
 * serializing a checkpoint built from a full context leaks nothing.
 */
export interface SetupCheckpoint {
  version: 1;
  startedAt: string;
  updatedAt: string;
  cliVersion: string;
  completedStages: SetupStage[];
  host?: string;
  uiBaseUrl?: string;
  workspaceId?: string;
  projectId?: string;
  projectName?: string;
  projectKeyId?: string;
  projectKeyHint?: string;
  agentId?: AgentId;
  service?: { path: string; language: StackLanguage; framework: string | null };
  sdkVersion?: string;
  application?: ApplicationVerification;
  trace?: TraceVerification;
  lastError?: { stage: SetupStage; code: SetupErrorCode; message: string };
}

/**
 * How the SDK gets added to the application.
 *
 * `agent` edits the user's code, so it is never the default for a run that
 * cannot ask — a CI job or `--json` invocation must not discover that something
 * rewrote its repository. `task-file` is the safe fallback: it produces the
 * exact instructions and changes nothing.
 */
export type InstrumentMethod = "agent" | "task-file" | "manual";

/** Parsed `traceroot setup` flags. */
export interface SetupFlags {
  agent?: string;
  language?: string;
  service?: string;
  project?: string;
  browser: boolean;
  instrument: boolean;
  /** Explicit method; when absent the run prompts, or defaults to `task-file`. */
  method?: InstrumentMethod;
  resume: boolean;
  traceTimeoutSec: number;
}

/** Shared state threaded through every stage. */
export interface SetupContext {
  cwd: string;
  /** Repository root (git root when inside one, else `cwd`). */
  root: string;
  /**
   * Where this run's own files go: the credential env file and `.traceroot/`.
   *
   * The service directory, not the repository root — see `artifacts.ts`. Fixed
   * before the pipeline starts, because `--resume` has to find the checkpoint
   * before any stage has run.
   */
  artifactDir: string;
  /**
   * The project env file that holds the credential, absolute.
   *
   * Not "the file this run wrote". `configure_repository` sets this whenever the
   * file ends up holding the right key, and a file that already held it is not
   * written at all — `upsertEnvFile` diffs first and reports nothing written.
   * Callers use it to name the file the application loads, which is the same
   * file either way, so narrowing the contract to "newly written" would make
   * every one of them silent on a rerun.
   *
   * Undefined when no project file holds it: git tracks the one setup would have
   * used, or the application already resolves the key from its own environment.
   * Set by `configure_repository` so the closing notice and the report name the
   * file the user actually has rather than one this tool would have invented.
   */
  credentialEnvFile?: string;
  json: boolean;
  /** True when the CLI may prompt: TTYs, not CI, not `--json`, not `--no-input`. */
  canPrompt: boolean;
  flags: SetupFlags;
  writers: Writers;
  checkpoint: SetupCheckpoint;
  emit(event: SetupEvent): void;
  signal: AbortSignal;
  inGitRepo: boolean;
  session?: AuthSession;
  project?: ProjectSelection;
  credential?: ProjectCredential;
  stack?: DetectedStack;
  agent?: DetectedAgent;
  /** How the SDK will be added; settled in the same answer that names the agent. */
  method?: InstrumentMethod;
  instrumentation?: InstrumentationResult;
  application?: ApplicationVerification;
  trace?: TraceVerification;
}

export interface SetupStageOutcome {
  stage: SetupStage;
  status: SetupStageStatus;
  durationMs: number;
}

export interface SetupResult {
  ok: boolean;
  stagesRun: SetupStageOutcome[];
  checkpoint: SetupCheckpoint;
  trace: TraceVerification | null;
  error: SetupError | null;
}
