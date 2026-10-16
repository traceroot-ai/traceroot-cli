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

export interface ApplicationVerification {
  /** The command as run. Never contains a secret. */
  command: string | null;
  withCredentials: VerificationRun;
  /** Proves the app still behaves with `TRACEROOT_API_KEY` absent. */
  withoutCredentials: VerificationRun;
  passed: boolean;
  skippedReason: string | null;
}

export interface TraceVerification {
  traceId: string;
  /** The backend's own permalink, echoed verbatim — never constructed here. */
  traceUrl: string;
  observedAt: string;
  waitedMs: number;
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
   * Where this run's own files go: `.env.traceroot` and `.traceroot/`.
   *
   * The service directory, not the repository root — see `artifacts.ts`. Fixed
   * before the pipeline starts, because `--resume` has to find the checkpoint
   * before any stage has run.
   */
  artifactDir: string;
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
