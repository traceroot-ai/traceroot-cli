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
   * one.
   *
   * Diagnostics, with one exception: an agent that reports having changed no
   * files fails the stage, because a run that edited nothing cannot have
   * instrumented anything. Even there the claim is not taken on its own — the
   * worktree has to show no change either (`observedChangedFiles`), since a
   * report is a claim and `git status` is evidence.
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
   * covers, and the reason it is kept on the record rather than only printed
   * once: `--resume` rehydrates the trace from the checkpoint and renders the
   * report from it, so a count that lived only in the invocation that polled
   * would leave a resumed run's report without the number the first run had.
   *
   * Absent rather than null, because a response that did not carry the field
   * leaves exactly one thing to say and two spellings of it would both have to
   * be handled by every reader.
   */
  spanCount?: number;
  /** The trace's root span name; absent when the row carried none. */
  name?: string;
  /** How many traces since setup started were on the page this one was chosen from. */
  candidates?: number;
  /** That page came back full, so an earlier trace may have fallen off it. */
  truncated?: boolean;
  /**
   * False when the project already had traces from before setup started, so
   * this trace may come from another sender; true when it had none. Absent
   * when that could not be learned, and on a checkpoint written before it was
   * recorded: both are "unknown", and neither is printed as a doubt.
   */
  attributed?: boolean;
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
  /**
   * How the instrument stage completed: an agent ran, or the task was handed
   * over and nothing was edited.
   *
   * On the checkpoint because the next invocation cannot re-derive it. A
   * hand-over leaves the repository exactly as it found it, so `--resume`
   * restores the stage rather than re-running it — and a restored result that
   * claimed an agent had edited the code is what sent a resumed run off to wait
   * for a trace from an application with no TraceRoot in it.
   *
   * Every route writes its own value, `"agent"` included, so a completed stage
   * without one is a file something other than setup has edited. That is not
   * evidence of an agent run, and the instrument stage declines to restore
   * rather than assume one — the assumption is the bug.
   */
  instrumentHandover?: "agent" | "task-file" | "manual";
  /**
   * Keys a setup run minted in this repository that no run has put into
   * service and no rollback has revoked.
   *
   * Written the moment a key is created, because a process that dies takes
   * every other record of it with it, and a key nobody knows about cannot be
   * found again except by date in a list of keys that all look alike. Emptied
   * when a run completes — then the keys are the ones in use — and pruned by a
   * rollback as it revokes them, so what is left is exactly what is still out
   * there.
   *
   * Never the key itself. The hint and the name are what identify a row in the
   * project's key list, and a checkpoint is a file people paste into issues.
   */
  mintedKeys?: { id: string; name: string | null; hint: string }[];
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
  /**
   * A one-shot handoff code from browser-first onboarding, redeemed once at the
   * start of `authenticate`. Never stored and never passed on: it enters as a
   * flag, goes to one function, and is discarded.
   */
  handoff?: string;
  browser: boolean;
  instrument: boolean;
  /** Explicit method; when absent the run prompts, or defaults to `task-file`. */
  method?: InstrumentMethod;
  resume: boolean;
  traceTimeoutSec: number;
}

/**
 * Where the key an instrumented application reads sits on this machine, once
 * the run is over.
 *
 * Three cases rather than a filename with a default behind it, because the
 * default is a guess and the whole job of the closing production block is to
 * send the user to the value they actually have. A run that names `./.env` to
 * someone who has no `.env` has not told them anything; it has given them a
 * file to go and fail to find.
 *
 * - `file`: the ordinary run. A project env file holds the key, and `path` is
 *   that file as the user should see it — relative to the repository root,
 *   because the file follows the service and a monorepo's is not at the root.
 * - `environment`: nothing was written, because the key was already resolving
 *   from the user's own environment. There is a value to copy; it is just not
 *   in a file.
 * - `refused`: the key exists and is written down nowhere, because git tracks
 *   the file it would have gone in (`path`). This is the only case where the
 *   user cannot copy the value from anywhere, and the only one where the
 *   honest instruction is to use a different key for the deployment.
 *
 * Derived by `applicationKeyLocation` in `machine.ts`, which is where the two
 * facts behind it live.
 */
export type ApplicationKeyLocation =
  | { kind: "file"; path: string }
  | { kind: "environment" }
  | { kind: "refused"; path: string };

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
  /**
   * The project env file this run would have written and did not, absolute.
   *
   * Set by the one refusal `configure_repository` has: git tracks the file, so
   * writing a live key into it would put the key one `git commit -a` from a
   * public repository. The run carries on — the child environment handoff still
   * works, so the trace still arrives — and that is exactly why this is
   * recorded. Without it, "no credential file" is one fact covering two
   * situations the user has to be told apart: here the key was written down
   * nowhere, while in the other the user's own environment already holds it.
   *
   * See {@link ApplicationKeyLocation}, which is the three-way answer the
   * closing notice needs and the reason a second field is worth having.
   */
  refusedCredentialEnvFile?: string;
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
  trace?: TraceVerification;
  /**
   * True when the user ended the trace wait themselves and no trace had arrived.
   *
   * The difference between "setup stopped early and something is outstanding"
   * and "setup finished, and the last fact is an observation nobody can hurry".
   * Both leave {@link SetupContext.trace} undefined, so without this the
   * closing output has to guess, and it guessed the first — sending a user who
   * had just watched an agent instrument their service off to "finish the
   * instrumentation task".
   *
   * Deliberately not on the checkpoint: it describes how this invocation ended,
   * and `--resume` re-runs the wait rather than inheriting the decision.
   */
  traceWaitSkipped?: boolean;
  /**
   * True when this invocation handed the instrumentation over — `--no-instrument`,
   * `--manual` or a menu answer that edits nothing — rather than restoring a
   * hand-over an earlier run recorded.
   *
   * The difference is whether anyone has had the chance to act on it. Straight
   * after a hand-over nobody has, and the code is exactly as detection read it,
   * so a run with no trace can say the service has no TraceRoot in it yet. A
   * resumed hand-over may be the user back from the task, and detection reads
   * only the entry point: an `initialize()` the task put in an imported module
   * is not there to see, and saying "no TraceRoot" over it is false.
   *
   * Not on the checkpoint, for the reason {@link SetupContext.traceWaitSkipped}
   * is not.
   */
  handedOverThisRun?: boolean;
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
