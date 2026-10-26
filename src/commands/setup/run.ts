/**
 * Everything `traceroot setup` does once it has decided to run.
 *
 * Split from `../setup.js` for one reason: this module reaches
 * `@clack/prompts`, whose core's first line is
 * `import { styleText } from "node:util"` — an export that landed in Node
 * 20.12. While the command's registration imported it statically, that import
 * sat in every `traceroot` invocation's module graph, so on Node 20.11 *every*
 * command died at startup with "The requested module 'node:util' does not
 * provide an export named 'styleText'". `../setup.js` now reaches this file
 * through `await import()` inside the action, so the prompt graph is loaded
 * only by a run of `setup` itself, after that file's own version check has
 * confirmed the runtime can take it.
 *
 * The rule this encodes: nothing on the common command path may import this
 * module, or anything under `../../setup/` that renders — see
 * `tests/cli.node-floor.test.ts`, which walks the graph and fails if it does.
 */
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { displaySkillPath } from "../../agents/index.js";
import { loadOptionalEnvFileFromDisk } from "../../config/envFile.js";
import { configPath, loadConfigOrThrow } from "../../config/manager.js";
import type { ResolvedAuth } from "../../config/resolve.js";
import { type Context, type ContextDeps, type GlobalOptions, buildContext } from "../../context.js";
import { type Writers, defaultWriters } from "../../output.js";
import { relativeToRoot, serviceArtifactDir } from "../../setup/artifacts.js";
import {
  clearCheckpoint,
  hasCompleted,
  newCheckpoint,
  pendingHandover,
  readCheckpoint,
  setupRoot,
  writeCheckpoint,
} from "../../setup/checkpoint.js";
import { acknowledgeTraces, skippedTraceNotice } from "../../setup/ending.js";
import { applicationEnvKeys } from "../../setup/envWrite.js";
import type { SetupError } from "../../setup/errors.js";
import {
  STAGE_LABELS,
  type SetupEmitter,
  jsonEmitter,
  stageLineEmitter,
} from "../../setup/events.js";
import { setupCommand } from "../../setup/invocation.js";
import {
  type SetupDeps,
  applicationKeyLocation,
  defaultSetupDeps,
  runSetupMachine,
  runTaskSentence,
} from "../../setup/machine.js";
import { acknowledgeProduction, nameList } from "../../setup/production.js";
import type { SelectInput } from "../../setup/select.js";
import type { SetupCheckpoint, SetupContext, SetupFlags, SetupResult } from "../../setup/types.js";
import {
  wizardIntro,
  wizardLine,
  wizardNote,
  wizardOutro,
  wizardProgress,
} from "../../setup/wizard.js";

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
export function closingLine(result: SetupResult, ending: SetupEnding = {}): string {
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
  // Scoped, because what finished is scoped. This said "TraceRoot setup
  // complete." one line under a block that had just told the user their
  // production environment still needs the key — a line that claims the whole
  // job is done directly above the half that is not. The run configured this
  // machine; that is the thing to claim, and naming it as local is also what
  // makes the sentence below it legible as the rest.
  if (result.trace !== null) {
    return "TraceRoot local setup complete.";
  }
  // Two different endings share "ok, and no trace", and the frame must not
  // describe one as the other. A user who stopped the wait themselves has a
  // finished run; a run that stopped before the wait has work outstanding, and
  // "paused" is the word for that one only.
  return ending.traceWaitSkipped === true
    ? "TraceRoot local setup complete — no trace seen yet."
    : `Setup paused — rerun \`${setupCommand()} --resume\` to finish.`;
}

/**
 * What the machine recorded about *how* a run ended, beyond whether it did.
 *
 * Separate from {@link SetupResult} because it is a presentation detail of this
 * invocation rather than part of the machine's result: nothing is checkpointed,
 * nothing is in the `--json` envelope, and `--resume` starts from a clean one.
 * Optional throughout, so the two closing functions keep their old meaning when
 * nothing is passed.
 */
export interface SetupEnding {
  /** The user ended the trace wait early; see `SetupContext.traceWaitSkipped`. */
  traceWaitSkipped?: boolean;
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
  if (!result.ok || result.trace === null) {
    return null;
  }
  // "You can now use TraceRoot in production." is what this said, and it was
  // not true of any run that printed it: the block immediately above it asks
  // the user to go and put the key in their production environment, and an
  // unattended run has nobody to even read that. The condition is the whole
  // content of the sentence, so the sentence carries it.
  //
  // A skipped wait does not change this either: the sentence is earned by a
  // trace that actually arrived, and a run that has not seen one has not
  // established that the instrumentation works.
  //
  // The variables come from `applicationEnvKeys`, like every other place the
  // run names them, so a non-default host's second variable is named here too
  // rather than this becoming the one line that forgets it.
  const keys = applicationEnvKeys(result.checkpoint.host);
  return `You can use TraceRoot in production once ${nameList(keys)} ${keys.length === 1 ? "is" : "are"} in its environment.`;
}

/**
 * How a failed run leaves the process: by rethrowing, or by exit code alone.
 *
 * Non-`--json` rethrows, so the central handler renders the message exactly
 * like every other command's error.
 *
 * `--json` must not. {@link SetupError} extends `CliError`, so a rethrow reached
 * the shared reporter, which derives the error's name from its *numeric* exit
 * status — and setup's codes are numbered separately from the shared table's:
 * NOT_AUTHENTICATED is 2, which that table reads as `usage`, and AGENT_FAILED is
 * 5, which it reads as `network`. One failure therefore produced two envelopes,
 * and the second named a class the run had nothing to do with. The `result`
 * event has already reported the failure with setup's own code and message, so
 * json mode needs the exit status and nothing else.
 *
 * A cancellation exits 0 by design and is neither: rendering "error:" in red
 * over a question the user simply answered no to would be the tool arguing with
 * them, and the closing line has already said what happened.
 */
export type SetupFailureExit =
  | { kind: "none" }
  | { kind: "throw"; error: SetupError }
  | { kind: "exit"; code: number };

export function setupFailureExit(result: SetupResult, json: boolean): SetupFailureExit {
  const error = result.error;
  if (result.ok || error === null || error.exitCode === 0) {
    return { kind: "none" };
  }
  return json ? { kind: "exit", code: error.exitCode } : { kind: "throw", error };
}

/**
 * The question a run asks when it finds a previous run's checkpoint.
 *
 * Two different situations, and they cannot share a sentence. A checkpoint that
 * stops part-way is unfinished work to continue; a checkpoint holding every
 * stage is a run that *succeeded*, and the terminal stage's label is "Finish" —
 * so the single wording told a user who had just watched setup complete that "a
 * previous setup for this service did not finish. It stopped after finish.
 * Continue from there?", which reads as the tool being broken.
 *
 * The finished case keeps the previous run by default. Starting over mints a
 * second API key and points a coding agent at code it has already edited, so it
 * is offered rather than taken on an unread keypress.
 *
 * Holding every stage is not quite enough, though: see {@link pendingHandover}.
 */
export function resumeQuestion(found: SetupCheckpoint): SelectInput {
  const ranToTheEnd = hasCompleted(found, "complete");
  const awaitingHandover = pendingHandover(found) !== null;
  if (ranToTheEnd && !awaitingHandover) {
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
  const where = awaitingHandover
    ? " It is waiting for the instrumentation it handed over."
    : stopped === undefined
      ? ""
      : ` It stopped after ${STAGE_LABELS[stopped].toLowerCase()}.`;
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
  // The fallback is for one specific case and is worth the extra lookup: a run
  // started at the root writes its checkpoint there even when it instruments a
  // service in a subdirectory, and without it a `--resume` from that service's
  // directory would look like a fresh run and mint a second API key. It reads
  // the root once; from then on the run writes beside the service.
  const here = readCheckpoint(artifactDir);
  // The root is that one case, not a second search location. A checkpoint there
  // may belong to a different service — `serviceArtifactDir` returns the root while
  // stack detection can still have selected a subdirectory — and adopting it would
  // let this run inherit that service's trace, and report a success it never
  // earned.
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

  // The two ways a run ends ok with no trace, as one decision: they are
  // mutually exclusive answers to the same question, and the block each one
  // prints is the wrong one for the other.
  if (!json && result.ok && result.trace === null) {
    if (ctx.traceWaitSkipped !== true) {
      // A run that ended without a trace but without an error: a hand-over —
      // `--no-instrument`, `--manual` or either menu answer that edits nothing —
      // that nothing setup can see has acted on. Say what happens next rather than implying
      // success, and only the half the closing line does not: that line already
      // says to rerun with `--resume`, and a third copy of it is noise.
      //
      // "No TraceRoot in it" only in the run that made the hand-over. On a
      // resume the user may have done the task, with `initialize()` in a module
      // the entry point imports where detection cannot see it, so that claim
      // would be false — and the steps are no longer "above".
      const task = ctx.instrumentation?.promptPath ?? null;
      const runTask = task === null ? null : runTaskSentence(ctx, displaySkillPath(ctx.root, task));
      const said =
        ctx.handedOverThisRun === true
          ? `No trace yet: setup changed no code, so the service has no TraceRoot in it. ${runTask === null ? "Apply the steps above." : `${runTask}.`}`
          : runTask === null
            ? "No trace yet, and setup cannot tell whether the manual steps were applied. Apply them if not, or run your application once if so."
            : `No trace yet, and setup cannot tell whether the task was done. ${runTask} if not, or run your application once if so.`;
      wizardLine({ writers, json }, `\n${said}`);
    } else {
      // The other way to end without a trace: the user stopped the wait. The
      // sentence above is the wrong one for it twice over — it tells somebody
      // who just watched an agent instrument their service that it has no
      // TraceRoot in it, and sends them off to do an instrumentation task that
      // is already done.
      wizardNote(
        writers,
        skippedTraceNotice({ uiBaseUrl: result.checkpoint.uiBaseUrl ?? null }, writers.err),
        { settled: true },
      );
    }
  }

  // The two blocks that close a successful run, in the order a user acts on
  // them: this machine first, then everywhere else. Only for a run that
  // actually got a trace — telling someone how to deploy an instrumentation
  // that has not been shown to work yet is premature.
  if (!json && result.ok && result.trace !== null) {
    // Named a stage so that Ctrl+C here ends the run with 130, as it does at
    // every question before it. With none, readline closed on the keypress, the
    // question never settled, and the process exited 0.
    const prompt = deps.canPrompt
      ? (question: string) => deps.setupDeps.prompt(question, "complete")
      : null;
    await acknowledgeTraces({ writers, traceUrl: result.trace.traceUrl, prompt });
    await acknowledgeProduction({
      writers,
      language: result.checkpoint.service?.language ?? null,
      // Where the key actually is, asked of the machine rather than assembled
      // here. This was the credential file or nothing, and nothing fell back to
      // `./.env` inside the notice — so the two runs that write no file at all,
      // one because the user's own environment already held the key and one
      // because git tracks the file it would have gone in, both ended on an
      // instruction to open a file that in the second case holds nothing.
      keyLocation: applicationKeyLocation(ctx, deps.setupDeps),
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
    wizardOutro(writers, closingLine(result, { traceWaitSkipped: ctx.traceWaitSkipped }), {
      closing: closingSentence(result),
    });
  }

  return result;
}

/** Sources for {@link setupContext}: the context's own, plus one fact about the config file. */
export interface SetupContextDeps extends ContextDeps {
  /**
   * Whether the config file is this directory's own `./.traceroot/config.json`
   * rather than one `TRACEROOT_CONFIG_PATH` names. Injectable for tests.
   */
  configIsLocal?: boolean;
}

export interface SetupRunContext {
  context: Context;
  /** The warning naming the repository-local hosts a `--handoff` run set aside. */
  hostsSetAside?: string;
}

/**
 * The context a `setup` run resolves.
 *
 * Without `--handoff` it is every command's context. With it, the hosts come
 * only from flags, `--env-file`, the process environment or the default, and
 * never from this directory's `.env` or `./.traceroot/config.json`. The code is
 * a bearer credential minted by the real web page, and it redeems into a
 * seven-day session: a cloned repository whose `.env` names a host would
 * otherwise receive it, and whoever runs that host could redeem it at the real
 * deployment. The hand-back command needs nothing from the repository anyway:
 * it passes `--host` for every deployment but the hosted product, which is the
 * default.
 *
 * For the whole run, not only the redemption, so the session is stored under
 * the host it was redeemed at and every later stage talks to that host.
 */
export function setupContext(
  opts: GlobalOptions & { handoff?: string },
  deps: SetupContextDeps = {},
): SetupRunContext {
  const handoff = opts.handoff?.trim();
  if (handoff === undefined || handoff === "") {
    return { context: buildContext(opts, deps) };
  }

  // The repository's two files, read once so both resolutions below see the same contents.
  const autoEnv = (
    deps.loadAutoEnvFile ?? (() => loadOptionalEnvFileFromDisk(join(process.cwd(), ".env")))
  )();
  const config = (deps.readConfig ?? (() => loadConfigOrThrow()))();
  const configIsLocal =
    deps.configIsLocal ??
    resolve(configPath()) === join(process.cwd(), ".traceroot", "config.json");
  const read: ContextDeps = { ...deps, loadAutoEnvFile: () => autoEnv, readConfig: () => config };

  // What every other command would resolve, kept only to say what was set aside.
  const ambient = buildContext(opts, read).auth;
  const {
    TRACEROOT_HOST_URL: _host,
    TRACEROOT_AUTH_URL: _authHost,
    ...autoEnvWithoutHosts
  } = autoEnv;
  const context = buildContext(opts, {
    ...read,
    loadAutoEnvFile: () => autoEnvWithoutHosts,
    readConfig: () =>
      config !== null && configIsLocal ? { ...config, host_url: undefined } : config,
  });

  const setAside: string[] = [];
  if (ambient.hostUrl.value !== context.auth.hostUrl.value) {
    setAside.push(
      ambient.hostUrl.source === "config"
        ? "host_url in ./.traceroot/config.json"
        : "TRACEROOT_HOST_URL in ./.env",
    );
  }
  if (
    ambient.authHost.source === "auto-env-file" &&
    ambient.authHost.value !== context.auth.authHost.value
  ) {
    setAside.push("TRACEROOT_AUTH_URL in ./.env");
  }
  return {
    context,
    hostsSetAside:
      setAside.length === 0
        ? undefined
        : `ignored ${setAside.join(" and ")} for --handoff; the hand-back command names its deployment with --host`,
  };
}

/**
 * What {@link runSetupCommand} otherwise takes from the process. Injectable so a
 * test can drive the command itself: the line that hands `setupContext`'s hosts
 * and warning to the run is where the `--handoff` protection lives.
 */
export interface SetupCommandDeps {
  context?: SetupContextDeps;
  setupDeps?: (auth: ResolvedAuth) => SetupDeps;
  writers?: Writers;
  cwd?: string;
}

/**
 * The body of the `setup` action, behind the lazy boundary.
 *
 * `--trace-timeout` is already resolved by the caller: it is a pure reading of
 * argv, and a bad value must be rejected without loading this module or
 * touching the repository, the config or the network.
 */
export async function runSetupCommand(
  command: Command,
  traceTimeoutSec: number,
  deps: SetupCommandDeps = {},
): Promise<void> {
  const opts = command.optsWithGlobals();
  const { context: ctx, hostsSetAside } = setupContext(opts, deps.context);
  const json = ctx.json;
  // `--json` implies `--no-input`: an event stream and an interactive prompt
  // cannot share stdout, and a machine consumer has nobody to ask.
  const noInput = opts.input === false || json;

  const flags: SetupFlags = {
    agent: opts.agent as string | undefined,
    language: opts.language as string | undefined,
    service: opts.service as string | undefined,
    project: opts.project as string | undefined,
    handoff: opts.handoff as string | undefined,
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
    cwd: deps.cwd ?? process.cwd(),
    flags,
    writers: deps.writers ?? defaultWriters,
    setupDeps: { ...(deps.setupDeps ?? defaultSetupDeps)(ctx.auth), hostsSetAside },
    canPrompt: canPrompt({
      json,
      noInput,
      env: process.env,
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
    }),
  });

  const failure = setupFailureExit(result, json);
  if (failure.kind === "throw") {
    // Thrown so the central handler renders it exactly like every other
    // command's error, and so its per-class exit code is honoured.
    throw failure.error;
  }
  if (failure.kind === "exit") {
    process.exitCode = failure.code;
  }
}
