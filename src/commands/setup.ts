import type { Command } from "commander";
import { createApiClient } from "../api/client.js";
import { createTokenProvider } from "../auth/token.js";
import { configPath } from "../config/manager.js";
import type { Context } from "../context.js";
import { type Writers, defaultWriters } from "../output.js";
import { serviceArtifactDir } from "../setup/artifacts.js";
import {
  clearCheckpoint,
  newCheckpoint,
  readCheckpoint,
  setupRoot,
  writeCheckpoint,
} from "../setup/checkpoint.js";
import { acknowledgeTraces } from "../setup/ending.js";
import { STAGE_LABELS, type SetupEmitter, jsonEmitter, stageLineEmitter } from "../setup/events.js";
import { type SetupDeps, defaultSetupDeps, runSetupMachine } from "../setup/machine.js";
import { acknowledgeProduction } from "../setup/production.js";
import type { SetupContext, SetupFlags, SetupResult } from "../setup/types.js";
import { wizardIntro, wizardLine, wizardOutro, wizardProgress } from "../setup/wizard.js";
import { runDoctor } from "./doctor.js";
import { contextFromCommand } from "./shared.js";

/** Default bound on VERIFY_TRACE, in seconds. */
const DEFAULT_TRACE_TIMEOUT_SEC = 120;

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
  const foundAt = readCheckpoint(artifactDir) !== null ? artifactDir : root;
  const found = readCheckpoint(artifactDir) ?? readCheckpoint(root);

  // A checkpoint is offered, not demanded by flag.
  //
  // Gating it behind a flag would mean a user who does not know the flag exists
  // silently starts over, minting a second API key and re-doing work they have
  // already sat through — and the moment they are least inclined to read help
  // is a run that just failed. So a run that finds unfinished work says so and
  // asks.
  //
  // The flag survives for `--no-input`, where there is nobody to ask and the
  // caller has to state the intent. Asked and declined means starting fresh:
  // the answer is about this run, so it must not be sticky.
  let existing = found;
  if (found !== null && !flags.resume) {
    if (deps.canPrompt) {
      const stopped = found.completedStages.at(-1);
      const where =
        stopped === undefined ? "" : ` It stopped after ${STAGE_LABELS[stopped].toLowerCase()}.`;
      const answer = await deps.setupDeps.select({
        stage: "precheck",
        message: `A previous setup for this service did not finish.${where} Continue from there?`,
        options: [
          { value: "resume", label: "Continue", hint: "pick up where it stopped" },
          { value: "fresh", label: "Start over", hint: "discard the previous run and begin again" },
        ],
      });
      if (answer !== "resume") {
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
    flags,
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

      const timeoutRaw = opts.traceTimeout as string | undefined;
      const parsedTimeout = timeoutRaw === undefined ? Number.NaN : Number.parseInt(timeoutRaw, 10);
      const traceTimeoutSec =
        Number.isFinite(parsedTimeout) && parsedTimeout > 0
          ? parsedTimeout
          : DEFAULT_TRACE_TIMEOUT_SEC;

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
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const report = await runDoctor({
        ctx,
        cwd: process.cwd(),
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
