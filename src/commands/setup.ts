/**
 * Registration for `traceroot setup` — declaration only, deliberately thin.
 *
 * `commands/index.ts` imports this file, so it is in the module graph of every
 * `traceroot` invocation. The wizard's prompts come from `@clack/prompts`,
 * whose core begins `import { styleText } from "node:util"`, an export that
 * landed in Node 20.12 — so while this file imported the wizard statically,
 * `traceroot traces`, `login`, `status` and `doctor` all died at startup on an
 * older Node with a module-resolution error that named none of them. The
 * wizard therefore lives in `./setup/run.js` and is reached only by
 * `await import()` inside the action, behind {@link requireSetupNode}.
 *
 * What may live here: the commander declaration, and checks that read nothing
 * but argv or the runtime. Anything that renders, prompts or runs a stage
 * belongs in `./setup/run.js`.
 */
import type { Command } from "commander";
import { createApiClient } from "../api/client.js";
import { createTokenProvider } from "../auth/token.js";
import { configPath } from "../config/manager.js";
import { CliError, ExitCode, defaultWriters } from "../output.js";
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
 * Rejects an invocation that names two different ways to instrument.
 *
 * `--manual` prints instructions for the user to follow; `--no-instrument`
 * writes the task file for their own agent to follow. They are alternatives, and
 * the machine's choice tests the method before the flag — so `--manual
 * --no-instrument` quietly did the first and said nothing about the second. No
 * precedence is invented here: there is no reading of the pair under which the
 * dropped flag was what the caller meant, so the pair is a usage error.
 */
export function rejectConflictingMethodFlags(opts: {
  manual?: unknown;
  instrument?: unknown;
}): void {
  if (opts.manual === true && opts.instrument === false) {
    throw new CliError(
      "--manual cannot be combined with --no-instrument: --manual prints manual instructions, --no-instrument writes the instrumentation task for your own agent. Pass one.",
      ExitCode.usage,
    );
  }
}

/**
 * Reads `--service` for a command nested under `setup`.
 *
 * `setup` declares the flag as well, and an ancestor parses before its
 * subcommands do: commander assigns the value to the first command that
 * recognises the flag, so `setup doctor --service api` leaves `doctor`'s own
 * options empty. Reading those options therefore always saw `undefined`, and
 * `doctor` fell back to the repository root — answering "setup has not been run
 * here" for a monorepo run that had completed under `--service api`, which is
 * the one situation the flag exists for.
 */
export function resolveServiceOption(command: Command): string | undefined {
  return command.optsWithGlobals().service as string | undefined;
}

/**
 * The Node version `setup` needs, which is higher than the package's own floor
 * in `engines`.
 *
 * `setup` is the only command that prompts, and `@clack/prompts` needs
 * `node:util`'s `styleText` — added in Node 20.12. Every other command runs on
 * the `engines` floor, and `engines` states that one: npm only warns on a
 * mismatch, so a floor declared there is not a check, and one declared for the
 * whole package over a single command's dependency is not true.
 */
export const MIN_SETUP_NODE = "20.12.0";

/** `major.minor.patch` as numbers, ignoring any pre-release suffix. */
function versionTriple(version: string): [number, number, number] {
  const part = (index: number): number => {
    const value = Number.parseInt(version.split(".")[index] ?? "", 10);
    return Number.isFinite(value) ? value : 0;
  };
  return [part(0), part(1), part(2)];
}

/** Whether `version` is at least `floor`, both `major.minor.patch`. */
export function meetsNodeFloor(version: string, floor: string): boolean {
  const [haveMajor, haveMinor, havePatch] = versionTriple(version);
  const [needMajor, needMinor, needPatch] = versionTriple(floor);
  if (haveMajor !== needMajor) return haveMajor > needMajor;
  if (haveMinor !== needMinor) return haveMinor > needMinor;
  return havePatch >= needPatch;
}

/**
 * Rejects a runtime that cannot load the wizard, before anything tries to.
 *
 * Compared explicitly rather than inferred from a failed `await import()`: a
 * caught `ERR_MODULE_NOT_FOUND` would also swallow a genuine packaging fault —
 * a missing or half-published `dist/` reported as "upgrade Node" is a worse
 * error than the one it replaced. A usage error because the invocation cannot
 * be satisfied as given; it names the floor and says what still works, since
 * the user reaching this has a working CLI and one broken command.
 */
export function requireSetupNode(version: string = process.versions.node): void {
  if (meetsNodeFloor(version, MIN_SETUP_NODE)) {
    return;
  }
  throw new CliError(
    `setup needs Node ${MIN_SETUP_NODE} or newer (its prompts use node:util's styleText), but this is Node ${version}. Upgrade Node to run setup; every other traceroot command works on this version.`,
    ExitCode.usage,
  );
}

export function registerSetup(program: Command): void {
  const setup = program
    .command("setup")
    .description("Connect this repository to TraceRoot and verify your first trace")
    .option(
      "--agent <agent>",
      "coding agent to run: claude; for any other agent use --no-instrument",
    )
    .option("--language <language>", "language to instrument: python or typescript")
    .option("--service <path>", "path of the service to instrument (disambiguates a monorepo)")
    .option("--project <name-or-id>", "TraceRoot project to send traces to")
    // On `setup`, never on the program. Program options are rendered in every
    // subcommand's "Global Options" section, so a one-shot onboarding
    // credential declared there would appear in `traceroot traces list --help`.
    .option("--handoff <code>", "one-shot sign-in code printed by the TraceRoot web app")
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
      // The runtime before the argv: on an older Node there is no invocation of
      // `setup` that can succeed, so saying so once beats correcting a flag and
      // then being told the whole command is unavailable.
      requireSetupNode();
      const opts = command.optsWithGlobals();
      // Both of these read nothing but the argv, so they run before anything is
      // resolved from disk — and before the wizard is even loaded: a bad
      // invocation fails without having touched the repository, the config or
      // the network.
      rejectConflictingMethodFlags(opts);
      const traceTimeoutSec = resolveTraceTimeoutSec(opts.traceTimeout as string | undefined);
      // Loaded here rather than at the top of the file: see the module header.
      const { runSetupCommand } = await import("./setup/run.js");
      await runSetupCommand(command, traceTimeoutSec);
    });

  setup
    .command("doctor")
    .description("Diagnose a setup that did not complete")
    // The same option `setup` takes: nothing outside the per-service checkpoint
    // records which service a run chose, so without it a run under `--service`
    // cannot be diagnosed from the repository root — the one case this exists for.
    //
    // Declared here so it is listed in `setup doctor --help`; where the value
    // actually lands is {@link resolveServiceOption}'s problem.
    .option("--service <path>", "path of the service whose setup run to diagnose")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const report = await runDoctor({
        ctx,
        cwd: process.cwd(),
        service: resolveServiceOption(command),
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
