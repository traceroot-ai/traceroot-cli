import type { Command } from "commander";
import { createApiClient } from "../api/client.js";
import { createTokenProvider } from "../auth/token.js";
import { configPath } from "../config/manager.js";
import type { Context } from "../context.js";
import { CliError, ExitCode, type Writers, defaultWriters } from "../output.js";
import { relativeToRoot, serviceArtifactDir } from "../setup/artifacts.js";
import {
  clearCheckpoint,
  hasCompleted,
  newCheckpoint,
  readCheckpoint,
  setupRoot,
  writeCheckpoint,
} from "../setup/checkpoint.js";
import { acknowledgeTraces } from "../setup/ending.js";
import { STAGE_LABELS, type SetupEmitter, jsonEmitter, stageLineEmitter } from "../setup/events.js";
import { type SetupDeps, defaultSetupDeps, runSetupMachine } from "../setup/machine.js";
import { acknowledgeProduction } from "../setup/production.js";
import type { SelectInput } from "../setup/select.js";
import type { SetupCheckpoint, SetupContext, SetupFlags, SetupResult } from "../setup/types.js";
import { wizardIntro, wizardLine, wizardOutro, wizardProgress } from "../setup/wizard.js";
import { runDoctor } from "./doctor.js";
import { contextFromCommand } from "./shared.js";

/** Default bound on VERIFY_TRACE, in seconds. */
const DEFAULT_TRACE_TIMEOUT_SEC = 120;

/**
 * Ceiling on `--trace-timeout`, in seconds (~24.8 days).
 *
 * The value becomes a millisecond budget the trace poll compares elapsed time
 * against, and that loop's own sleep is capped — so an absurd value raises no
 * error, it just means a wait that never ends. Bounded at the global
 * `--timeout`'s ceiling (Node's timer range) expressed in seconds, so the CLI
 * has one answer to "how long may a duration be".
 */
const MAX_TRACE_TIMEOUT_SEC = 2_147_483;

/**
 * Resolves `--trace-timeout`, in seconds.
 *
 * A value that is not a positive whole number of seconds is a usage error, not a
 * different run. Falling back to the default meant `--trace-timeout 6O` (a
 * letter O) waited two minutes rather than the six seconds the caller asked
 * for, and then reported a timeout — the flag appearing to be ignored, with
 * nothing said about why. The global `--timeout` already throws here, with the
 * same digits-only rule, so the two flags cannot be learned separately.
 */
export function resolveTraceTimeoutSec(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TRACE_TIMEOUT_SEC;
  }
  // Digits only, like `--timeout` and `--limit`: a bare `Number()` would accept
  // hex (`0x10`), scientific (`1e2`) and decimal forms, each of which means
  // something other than what it looks like.
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!(parsed > 0 && parsed <= MAX_TRACE_TIMEOUT_SEC)) {
    throw new CliError(
      `invalid trace timeout: ${raw} (expected a positive integer of seconds, at most ${MAX_TRACE_TIMEOUT_SEC})`,
      ExitCode.usage,
    );
  }
  return parsed;
}

/**
 * Whether the CLI may ask the user anything.
 *
 * Four conditions, all of which have to hold — including one (CI) that the
 * CLI's existing `isInteractive()` does not check. A CI runner can present a
 * TTY; prompting there hangs the job
 * until it times out, which is the worst possible failure mode because the log
 * shows nothing.
 */
export function canPrompt(input: {
  json: boolean;
  noInput: boolean;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): boolean {
  const inCi = input.env.CI !== undefined && input.env.CI !== "" && input.env.CI !== "false";
  return !input.json && !input.noInput && !inCi && input.stdinIsTTY && input.stdoutIsTTY;
}

/**
 * The one line that closes the wizard.
 *
 * Three outcomes, three sentences. "Complete" printed over a run that never saw
 * a trace, or over one that failed, is a claim the user discovers is false
 * later — which is exactly when a first-run tool loses their trust. A failure
 * names the step it stopped on; the error itself follows, rendered by the CLI's
 * central handler like every other error.
 */
export function closingLine(result: SetupResult): string {
  if (!result.ok) {
    // A user who declined a question did not hit a failure, and the frame must
    // not tell them they did.
    if (result.error?.code === "CANCELLED") {
      return "Setup cancelled.";
    }
    const stage = result.error?.stage;
    return stage === undefined
      ? "Setup stopped."
      : `Setup stopped at: ${STAGE_LABELS[stage].toLowerCase()}.`;
  }
  return result.trace === null
    ? "Setup paused — rerun `traceroot setup --resume` to finish."
    : "TraceRoot setup complete.";
}

/**
 * The one sentence printed *below* the closed frame, and only when the run
 * earned it.
 *
 * Separate from {@link closingLine} because they answer different questions.
 * The `└` line says how this run ended; this says what the user can now do,
 * and a run that stopped at the agent or never saw a trace can say nothing of
 * the kind. Returning null is how "there is nothing to add" is expressed.
 */
export function closingSentence(result: SetupResult): string | null {
  return result.ok && result.trace !== null ? "You can now use TraceRoot in production." : null;
}

/**
 * The question a run asks when it finds a previous run's checkpoint.
 *
 * Two different situations, and they cannot share a sentence. A checkpoint that
 * stops part-way is unfinished work to continue; a checkpoint holding all twelve
 * stages is a run that *succeeded*, and the terminal stage's label is "Finish" —
 * so the single wording told a user who had just watched setup complete that "a
 * previous setup for this service did not finish. It stopped after finish.
 * Continue from there?", which reads as the tool being broken.
 *
 * The finished case keeps the previous run by default. Starting over mints a
 * second API key and points a coding agent at code it has already edited, so it
 * is offered rather than taken on an unread keypress.
 */
export function resumeQuestion(found: SetupCheckpoint): SelectInput {
  if (hasCompleted(found, "complete")) {
    return {
      stage: "precheck",
      message:
        "A previous setup for this service already finished. Leave it as it is, or run setup again from the beginning?",
      options: [
        {
          value: "resume",
          label: "Leave it as it is",
          hint: "report what the finished run set up",
        },
        {
          value: "fresh",
          label: "Run setup again",
          hint: "discard the previous run and start from the beginning",
        },
      ],
    };
  }
  const stopped = found.completedStages.at(-1);
  const where =
    stopped === undefined ? "" : ` It stopped after ${STAGE_LABELS[stopped].toLowerCase()}.`;
  return {
    stage: "precheck",
    message: `A previous setup for this service did not finish.${where} Continue from there?`,
    options: [
      { value: "resume", label: "Continue", hint: "pick up where it stopped" },
      { value: "fresh", label: "Start over", hint: "discard the previous run and begin again" },
    ],
  };
}

/** Dependencies for the testable core of `setup`. */
export interface RunSetupDeps {
  ctx: Context;
  cwd: string;
  flags: SetupFlags;
  writers: Writers;
  /** Full machine wiring; production supplies `defaultSetupDeps`. */
  setupDeps: SetupDeps;
  canPrompt: boolean;
  /** Injected so tests can assert cancellation without sending signals. */
  signal?: AbortSignal;
}

/**
 * Runs the setup state machine and renders its outcome.
 *
 * Thin by design: everything of substance is a stage in `setup/machine.ts`, so
 * this function only builds the context, chooses an emitter, and turns a
 * `SetupResult` into terminal output. Hundreds of lines of orchestration at
 * this level is what makes a wizard impossible to test and impossible to
 * resume.
 */
export async function runSetup(deps: RunSetupDeps): Promise<SetupResult> {
  const { flags, writers } = deps;
  const json = deps.ctx.json;

  // The repository root, which is also where PRECHECK will resolve `ctx.root`
  // to. It is what the git checks and the agent's working directory are about.
  const root = setupRoot(deps.cwd);
  // Where this run's own files go. Resolved here rather than inside the machine
  // because `--resume` has to read the checkpoint before any stage has run, and
  // the checkpoint now lives with the credential rather than at the root.
  const artifactDir = serviceArtifactDir({ root, cwd: deps.cwd, service: flags.service });
  // Opened before anything else runs, so the sign-in link and the verification
  // code are already inside the frame rather than loose above it. `--json` gets
  // no chrome at all.
  if (!json) {
    wizardIntro(writers);
  }
  // Resume where you ran, with the repository root as a fallback.
  //
  // The fallback is for one specific case and is worth the extra lookup: every
  // checkpoint written by an older version of the CLI is at the root, and without it the
  // first `--resume` after upgrading would look like a fresh run and mint a
  // second API key. It reads the old location once; from then on the run writes
  // to the new one.
  const here = readCheckpoint(artifactDir);
  // The root is a migration path, not a second search location. A checkpoint there
  // may belong to a different service — `serviceArtifactDir` returns the root while
  // stack detection can still have selected a subdirectory — and adopting it would
  // let this run inherit that service's application verification and its trace, and
  // report a success it never earned.
  const atRoot = here === null ? readCheckpoint(root) : null;
  const inherited =
    atRoot !== null &&
    (atRoot.service === undefined || atRoot.service.path === relativeToRoot(root, artifactDir))
      ? atRoot
      : null;
  const foundAt = here !== null ? artifactDir : root;
  const found = here ?? inherited;

  // A checkpoint is offered, not demanded by flag.
  //
  // Gating it behind a flag would mean a user who does not know the flag exists
  // silently starts over, minting a second API key and re-doing work they have
  // already sat through — and the moment they are least inclined to read help
  // is a run that just failed. So a run that finds a previous run's checkpoint
  // says what it found and asks — see {@link resumeQuestion}.
  //
  // The flag survives for `--no-input`, where there is nobody to ask and the
  // caller has to state the intent. Asked and declined means starting fresh:
  // the answer is about this run, so it must not be sticky.
  let existing = found;
  // Answering "Continue" *is* the resume intent. The machine only rehydrates a
  // completed stage under `flags.resume`, so leaving the flag false here kept the
  // checkpoint and still reran every stage — minting a second key and pointing the
  // agent at code it had already edited.
  let resume = flags.resume;
  if (found !== null && !flags.resume) {
    if (deps.canPrompt) {
      const answer = await deps.setupDeps.select(resumeQuestion(found));
      if (answer === "resume") {
        resume = true;
      } else {
        existing = null;
        // Delete it now, not on the next successful stage write. A run
        // interrupted between here and the first stage completing would
        // otherwise still find the old checkpoint and offer to resume the very
        // work the user just chose to discard.
        clearCheckpoint(foundAt);
      }
    } else {
      // Non-interactive: never silently resume, and never silently discard.
      existing = null;
      wizardProgress(
        { writers, json },
        "A previous setup was found but not resumed; pass --resume to continue it.",
      );
    }
  }
  if (flags.resume && found === null) {
    wizardProgress({ writers, json }, "No previous setup to resume; starting from the beginning.");
  }
  const checkpoint = existing ?? newCheckpoint(deps.setupDeps.now());

  // One renderer per audience, both fed the same events: compact JSON lines for
  // a machine, one rail-prefixed line per stage for a human. Nothing captures
  // or replays what the stages print — they write straight through, in order.
  const emit: SetupEmitter = json ? jsonEmitter(writers) : stageLineEmitter(writers);

  const ctx: SetupContext = {
    cwd: deps.cwd,
    root,
    artifactDir,
    json,
    canPrompt: deps.canPrompt,
    // Copied rather than mutated, so the caller's object is untouched.
    flags: resume === flags.resume ? flags : { ...flags, resume },
    writers,
    checkpoint,
    emit,
    signal: deps.signal ?? new AbortController().signal,
    inGitRepo: false,
  };

  const result = await runSetupMachine(ctx, deps.setupDeps);
  writeCheckpoint(ctx.artifactDir, result.checkpoint);

  if (!json && result.ok && result.trace === null) {
    // A run that ended without a trace but without an error: `--no-instrument`
    // stopped the flow early. Say what happens next rather than implying success.
    wizardLine(
      { writers, json },
      "\nSetup did not reach a first trace yet. Finish the instrumentation task, then run `traceroot setup --resume`.",
    );
  }

  // The two blocks that close a successful run, in the order a user acts on
  // them: this machine first, then everywhere else. Only for a run that
  // actually got a trace — telling someone how to deploy an instrumentation
  // that has not been shown to work yet is premature.
  if (!json && result.ok && result.trace !== null) {
    const prompt = deps.canPrompt ? deps.setupDeps.prompt : null;
    await acknowledgeTraces({ writers, traceUrl: result.trace.traceUrl, prompt });
    await acknowledgeProduction({
      writers,
      language: result.checkpoint.service?.language ?? null,
      // The credential follows the service, so the notice has to name where it
      // actually landed rather than always saying `./`.
      envFileDir: relativeToRoot(root, artifactDir),
      // The host, because it decides how many variables the user has to carry.
      // Off the default host the credential file holds `TRACEROOT_HOST_URL` as
      // well, and the notice used to name only the key — so a user who followed
      // it exactly pointed their SDK at the hosted product while holding a
      // credential for somewhere else.
      host: result.checkpoint.host,
      prompt,
    });
  }

  if (!json) {
    wizardOutro(writers, closingLine(result), { closing: closingSentence(result) });
  }

  return result;
}

export function registerSetup(program: Command): void {
  const setup = program
    .command("setup")
    .description("Connect this repository to TraceRoot and verify your first trace")
    .option("--agent <agent>", "coding agent to run: claude, codex, or generic")
    .option("--language <language>", "language to instrument: python or typescript")
    .option("--service <path>", "path of the service to instrument (disambiguates a monorepo)")
    .option("--project <name-or-id>", "TraceRoot project to send traces to")
    .option("--no-browser", "authenticate by pasting an API key instead of using a browser")
    .option("--no-instrument", "write the instrumentation task instead of running an agent")
    .option("--manual", "print manual instructions instead of running or writing a task")
    .option("--resume", "continue from the saved setup checkpoint")
    .option("--no-input", "never prompt; fail with the flag to pass instead")
    .option(
      "--trace-timeout <seconds>",
      `how long to wait for the first trace (default: ${DEFAULT_TRACE_TIMEOUT_SEC})`,
    )
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals();
      const ctx = contextFromCommand(command);
      const json = ctx.json;
      // `--json` implies `--no-input`: an event stream and an interactive prompt
      // cannot share stdout, and a machine consumer has nobody to ask.
      const noInput = opts.input === false || json;

      const traceTimeoutSec = resolveTraceTimeoutSec(opts.traceTimeout as string | undefined);

      const flags: SetupFlags = {
        agent: opts.agent as string | undefined,
        language: opts.language as string | undefined,
        service: opts.service as string | undefined,
        project: opts.project as string | undefined,
        // commander maps `--no-x` to `x: false`, defaulting to true.
        // An explicit route wins over the prompt. Without one, an interactive run
        // asks and an unattended run writes the task file.
        method: opts.manual === true ? "manual" : undefined,
        browser: opts.browser !== false,
        instrument: opts.instrument !== false,
        resume: opts.resume === true,
        traceTimeoutSec,
      };

      const result = await runSetup({
        ctx,
        cwd: process.cwd(),
        flags,
        writers: defaultWriters,
        setupDeps: defaultSetupDeps(ctx.auth),
        canPrompt: canPrompt({
          json,
          noInput,
          env: process.env,
          stdinIsTTY: process.stdin.isTTY === true,
          stdoutIsTTY: process.stdout.isTTY === true,
        }),
      });

      if (!result.ok && result.error !== null && result.error.exitCode !== 0) {
        // Thrown so the central handler renders it exactly like every other
        // command's error, and so its per-class exit code is honoured.
        //
        // Except a cancellation, which exits 0 by design: rendering "error:" in
        // red over a question the user simply answered no to would be the tool
        // arguing with them, and the closing line has already said what
        // happened.
        throw result.error;
      }
    });

  setup
    .command("doctor")
    .description("Diagnose a setup that did not complete")
    // The same option `setup` takes: nothing outside the per-service checkpoint
    // records which service a run chose, so without it a run under `--service`
    // cannot be diagnosed from the repository root — the one case this exists for.
    .option("--service <path>", "path of the service whose setup run to diagnose")
    .action(async (opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const report = await runDoctor({
        ctx,
        cwd: process.cwd(),
        service: opts.service as string | undefined,
        env: process.env,
        configPath: configPath(),
        writers: defaultWriters,
        includeSetup: true,
        verifyCredentials: async (host, credential) => {
          try {
            if (credential.kind === "session") {
              // `whoami` is API-key-only; a successful mint proves the session.
              await createTokenProvider({
                authHost: ctx.auth.authHost.value ?? host,
                sessionToken: credential.value ?? "",
                timeoutMs: ctx.timeoutMs,
              }).getAccessToken();
              return true;
            }
            await createApiClient({
              host,
              auth: { kind: "api-key", key: credential.value ?? "" },
              timeoutMs: ctx.timeoutMs,
            }).whoami();
            return true;
          } catch {
            return false;
          }
        },
      });
      if (report.summary.fail > 0) {
        process.exitCode = 1;
      }
    });
}
