import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS } from "../../src/api/client.js";
import { buildProgram } from "../../src/cli.js";
import { runDoctor } from "../../src/commands/doctor.js";
import {
  rejectConflictingMethodFlags,
  resolveServiceOption,
  resolveTraceTimeoutSec,
} from "../../src/commands/setup.js";
import { DEFAULT_HOST } from "../../src/commands/constants.js";
import {
  type SetupContextDeps,
  canPrompt,
  closingLine,
  resumeQuestion,
  runSetup,
  runSetupCommand,
  setupContext,
  setupFailureExit,
} from "../../src/commands/setup/run.js";
import { loadOptionalEnvFileFromDisk } from "../../src/config/envFile.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import { type Context, buildContext } from "../../src/context.js";
import type { DoctorCheck } from "../../src/doctor/types.js";
import type { RepoDetection } from "../../src/repo/detect.js";
import { newCheckpoint, readCheckpoint, writeCheckpoint } from "../../src/setup/checkpoint.js";
import { ExitCode, isCliError, reportError } from "../../src/output.js";
import { ALL_AGENTS, displaySkillPath } from "../../src/agents/index.js";
import { LAUNCHABLE_AGENTS } from "../../src/setup/agents.js";
import { SetupError } from "../../src/setup/errors.js";
import { SETUP_STAGES } from "../../src/setup/types.js";
import { WIZARD_TITLE } from "../../src/setup/wizard.js";
import { StringSink } from "../helpers/stringSink.js";
import { plain } from "../setup/colour.js";
import {
  authEmpty,
  authWithKey,
  defaultFlags,
  fakeApiClient,
  fakeRunProcess,
  fakeSetupApi,
  listTracesFrom,
  makeDeps,
  makeWriters,
  traceRow,
} from "../setup/helpers.js";

let dir: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-setup-cmd-"));
  // Codex's skills directory is global, not project-local: it is read from
  // `$CODEX_HOME`, falling back to the real `~/.codex`. This file drives the
  // whole of `runSetup`, and the hand-over route reaches `detectConfiguredAgents`
  // and then installs the skill wherever the chosen adapter points — so a test
  // here that does not pass `agent: "claude"` would write into the home
  // directory of whoever is running the suite. That has happened once already,
  // and it had to be undone by hand. Pointed at the fixture, the same way
  // `machine`, `doctor` and `skills` already do.
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(dir, "codex-home");
});

afterEach(() => {
  if (prevCodexHome === undefined) {
    // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = prevCodexHome;
  }
  rmSync(dir, { recursive: true, force: true });
});

function ctxWith(json = false): Context {
  return { auth: authWithKey(), json, timeoutMs: DEFAULT_TIMEOUT_MS };
}

describe("canPrompt", () => {
  const base = { json: false, noInput: false, stdinIsTTY: true, stdoutIsTTY: true };

  it("allows prompting on an interactive terminal", () => {
    expect(canPrompt({ ...base, env: {} })).toBe(true);
  });

  it("refuses in CI even when a TTY is present", () => {
    // A CI runner can present a TTY; prompting there hangs the job silently.
    expect(canPrompt({ ...base, env: { CI: "true" } })).toBe(false);
    expect(canPrompt({ ...base, env: { CI: "1" } })).toBe(false);
  });

  it("treats CI=false as not CI", () => {
    expect(canPrompt({ ...base, env: { CI: "false" } })).toBe(true);
  });

  it("refuses under --json and --no-input", () => {
    expect(canPrompt({ ...base, json: true, env: {} })).toBe(false);
    expect(canPrompt({ ...base, noInput: true, env: {} })).toBe(false);
  });

  it("refuses when either stream is not a TTY", () => {
    expect(canPrompt({ ...base, stdinIsTTY: false, env: {} })).toBe(false);
    expect(canPrompt({ ...base, stdoutIsTTY: false, env: {} })).toBe(false);
  });
});

describe("setup command registration", () => {
  it("registers `setup` and `setup doctor`", () => {
    const program = buildProgram();
    const setup = program.commands.find((c) => c.name() === "setup");
    expect(setup).toBeDefined();
    expect(setup?.commands.map((c) => c.name())).toContain("doctor");
  });

  it("names on `--agent` exactly the agents setup can run", () => {
    // The help text is a literal rather than built from `LAUNCHABLE_AGENTS`,
    // because this file is in the module graph of every `traceroot`
    // invocation and importing the selector would pull the agent registry
    // into the startup path of commands that never touch it. The cost of the
    // literal is that it can drift from the list, so the two are compared
    // here instead — a test is free to import what this file must not.
    const program = buildProgram();
    const setup = program.commands.find((c) => c.name() === "setup");
    const description = (setup?.options ?? []).find((o) => o.long === "--agent")?.description ?? "";

    for (const adapter of LAUNCHABLE_AGENTS) {
      expect(description, `\`--agent\` help names ${adapter.id}`).toContain(adapter.id);
    }
    // And names no agent it cannot run. `generic` and `codex` are still valid
    // `skills install` targets and still reachable through `--no-instrument`,
    // so the help has to point there rather than list them as runnable.
    const unlaunchable = ALL_AGENTS.filter(
      (adapter) => !LAUNCHABLE_AGENTS.some((a) => a.id === adapter.id),
    );
    expect(
      unlaunchable.length,
      "a non-launchable agent exists to make this assertion mean something",
    ).toBeGreaterThan(0);
    for (const adapter of unlaunchable) {
      expect(description, `\`--agent\` help does not offer ${adapter.id}`).not.toContain(
        adapter.id,
      );
    }
    expect(description).toContain("--no-instrument");
  });

  it("exposes only flags that map to a real decision", () => {
    const program = buildProgram();
    const setup = program.commands.find((c) => c.name() === "setup");
    const flags = (setup?.options ?? []).map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--agent",
        "--language",
        "--service",
        "--project",
        "--handoff",
        "--no-browser",
        "--no-instrument",
        "--resume",
        "--no-input",
        "--trace-timeout",
      ]),
    );
    // `--mcp` gated nothing but a warning that the endpoint does not exist, and
    // `--no-skills` turned off the reference the agent instruments from, which
    // only ever produced a worse run. A flag is cheap to add and a breaking
    // change to remove, so neither ships.
    expect(flags).not.toContain("--mcp");
    expect(flags).not.toContain("--no-skills");
    // Deliberately absent: bypass-all-permissions and an arbitrary agent command.
    expect(flags).not.toContain("--yolo");
    expect(flags).not.toContain("--agent-cmd");
  });

  it("declares --handoff on `setup`, never on the program", () => {
    // A program option is rendered in EVERY subcommand's "Global Options"
    // section, and a one-shot onboarding credential has no business being
    // offered by `traceroot traces list --help`.
    const program = buildProgram();
    const setup = program.commands.find((c) => c.name() === "setup");
    expect((setup?.options ?? []).map((o) => o.long)).toContain("--handoff");
    expect(program.options.map((o) => o.long)).not.toContain("--handoff");
  });

  it("still parses --handoff with it hidden from the help", () => {
    const setup = buildProgram().commands.find((c) => c.name() === "setup");
    if (setup === undefined) {
      throw new Error("setup is not registered");
    }
    expect(setup.parseOptions(["--handoff", "trh_code"]).unknown).toEqual([]);
    expect(setup.opts().handoff).toBe("trh_code");
  });

  it("refuses a stray operand at the parse, before any action runs", async () => {
    // `traceroot setup doctr` used to run the whole wizard: commander 12 allows
    // excess arguments by default, so the typo reached `setup`'s own action as
    // an ignored operand. Both actions are swapped for recorders, and what is
    // asserted is that neither was entered — every effect setup has (the mint,
    // the env write, the agent launch) happens inside one, and the wizard is not
    // even loaded until the action runs. `doctor` takes no operand either, and
    // inherits the rule from `setup` rather than declaring it.
    for (const argv of [
      ["setup", "doctr"],
      ["setup", "doctor", "api"],
    ]) {
      const program = buildProgram();
      const setup = program.commands.find((c) => c.name() === "setup");
      const doctor = setup?.commands.find((c) => c.name() === "doctor");
      expect(doctor).toBeDefined();
      let entered = 0;
      setup?.action(() => {
        entered += 1;
      });
      doctor?.action(() => {
        entered += 1;
      });

      let thrown: unknown;
      try {
        await program.parseAsync(["node", "traceroot", ...argv]);
      } catch (err) {
        thrown = err;
      }

      const named = `\`${argv.join(" ")}\``;
      expect(thrown, named).toBeInstanceOf(CommanderError);
      expect((thrown as CommanderError).code, named).toBe("commander.excessArguments");
      expect(entered, named).toBe(0);
    }
  });

  // The shim is a shell script, so not on Windows.
  it.skipIf(process.platform === "win32")(
    "exits 2 on the typo having called, launched and written nothing (spawned)",
    async () => {
      // The exit code is decided in `run()`, so it can only be read from a real
      // process. Each effect the wizard has gets a recorder, so its absence is
      // observed rather than inferred: the credential points at a local server
      // that counts requests (a key is minted over the API, after the key in
      // hand has been checked there); a `git` shim first on PATH logs a launch
      // (in a repository, `git` is the first program the wizard runs); and the
      // directory is where the checkpoint, the env file and the agent's task
      // file would land.
      mkdirSync(join(dir, ".git"), { recursive: true });
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.writeHead(401).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const shims = mkdtempSync(join(tmpdir(), "tr-setup-shims-"));
      const launches = join(shims, "launches.log");
      writeFileSync(join(shims, "git"), `#!/bin/sh\necho "git $*" >> '${launches}'\nexit 1\n`, {
        mode: 0o755,
      });

      try {
        const { port } = server.address() as AddressInfo;
        const bin = fileURLToPath(new URL("../../bin/traceroot.mjs", import.meta.url));
        const child = spawn(process.execPath, [bin, "setup", "doctr"], {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            CI: "true",
            PATH: `${shims}${delimiter}${process.env.PATH ?? ""}`,
            TRACEROOT_CONFIG_PATH: join(dir, "no-such-config", "config.json"),
            TRACEROOT_CREDENTIALS_PATH: join(dir, "no-such-creds", "credentials.json"),
            TRACEROOT_API_KEY: "tr-not-a-real-key",
            TRACEROOT_HOST_URL: `http://127.0.0.1:${port}`,
            TRACEROOT_TOKEN: "",
            TRACEROOT_AUTH_URL: "",
            TRACEROOT_PROJECT_ID: "",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const status = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });

        expect(status).toBe(ExitCode.usage);
        expect(stdout).toBe("");
        const said = plain(stderr);
        expect(said).toContain("too many arguments");
        // The frame's first line: with the operand ignored the wizard opened,
        // printed this, and went on to do the rest of it.
        expect(said).not.toContain(WIZARD_TITLE);
        expect(requests).toEqual([]);
        expect(existsSync(launches)).toBe(false);
        expect(readdirSync(dir, { recursive: true })).toEqual([".git"]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        rmSync(shims, { recursive: true, force: true });
      }
    },
  );
});

describe("the line that closes the wizard", () => {
  const base = { stagesRun: [], checkpoint: newCheckpoint(new Date()), error: null };

  const trace = {
    traceId: "t_1",
    traceUrl: "https://app.example.test/trace/t_1",
    observedAt: "2026-07-26T12:01:00.000Z",
    waitedMs: 1,
  };

  it("claims only the half of the setup that this machine is", () => {
    // It said "TraceRoot setup complete." one line below a block asking the
    // user to go and put the key in their production environment — the frame
    // signing off on a job of which the run had done one half.
    expect(closingLine({ ...base, ok: true, trace })).toBe("TraceRoot local setup complete.");
  });

  it("says paused, not complete, when the run stopped short of a trace", () => {
    // "Complete" over a run with no trace is a claim the user discovers is
    // false the first time they go looking for one.
    expect(closingLine({ ...base, ok: true, trace: null })).toContain("paused");
  });

  it("does not call a wait the user ended a pause", () => {
    // Two endings share "ok, and no trace". One has work outstanding and the
    // other does not, and "paused — rerun to finish" is the word for the first
    // only: a user who stopped the wait themselves has a finished run.
    const line = closingLine({ ...base, ok: true, trace: null }, { traceWaitSkipped: true });
    expect(line).toContain("complete");
    expect(line).not.toContain("paused");
    // And it still does not claim the trace was seen.
    expect(line).toContain("no trace seen yet");
  });

  it("does not call a cancellation a failure", () => {
    // Declining the uncommitted-changes gate is a decision the tool asked for.
    const error = new SetupError({
      stage: "precheck",
      code: "CANCELLED",
      message: "Setup cancelled — the repository has uncommitted changes.",
    });
    expect(error.exitCode).toBe(0);
    expect(closingLine({ ...base, ok: false, trace: null, error })).toBe("Setup cancelled.");
  });

  it("names the step a failure stopped on", () => {
    const error = new SetupError({
      stage: "verify_trace",
      code: "TRACE_TIMEOUT",
      message: "no trace",
    });
    expect(closingLine({ ...base, ok: false, trace: null, error })).toBe(
      "Setup stopped at: wait for the first trace.",
    );
  });
});

describe("runSetup", () => {
  it("persists a checkpoint and reports the trace", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, out, err } = makeWriters();

    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    expect(result.ok).toBe(true);
    // The permalink is part of the closing block, inside the frame on stderr.
    // One sentence written bare to stdout would put the single most important
    // line of the run visibly outside the box around it.
    expect(err.data).toContain("https://app.example.test/trace/t_1");
    expect(out.data).toBe("");
    expect(readCheckpoint(dir)?.completedStages).toContain("complete");
  });

  it("closes on the trace that arrived, without asking for another", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    const said = plain(err.data);
    expect(said).toContain("◇  Your first trace:\n│  https://app.example.test/trace/t_1\n");
    // The trace is the proof the application sends traces. Telling the user to
    // run it, that traces "will appear", or where to look if they do not, is
    // all about a state this run is already past.
    expect(said).not.toContain("Run your application");
    expect(said).not.toContain("will appear here");
    expect(said).not.toContain("troubleshoot");
  });

  it("gives the production instruction once, and nothing after the frame but where to get help", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    const said = plain(err.data);
    // Once, inside the frame, naming both variables this fixture's host needs.
    // Asserted on the opening fragment, because the row wraps to the terminal.
    expect(said.split("production").length - 1).toBe(1);
    expect(said).toContain("◇  Add TRACEROOT_API_KEY and TRACEROOT_HOST_URL from .env");
    // Below the frame, only where to get help: no sentence repeating it.
    const after = said.split("└  TraceRoot local setup complete.\n")[1] ?? "";
    expect(after.split("\n").filter((line) => line !== "")).toEqual([
      "If you ran into anything during setup, please open an issue at https://github.com/traceroot-ai/traceroot-cli/issues/new",
      "- Contact support: https://discord.gg/TM2m3CtKuC",
      "- Further documentation: https://traceroot.ai/docs/cli/get-started",
    ]);
  });

  it("does not call the trace the user's own when the project already had traces", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();
    const setupDeps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    // The read bounded by `end_before` asks whether anything sent to this
    // project before setup started. Answering with an older trace makes this
    // run's trace one that may have come from somewhere else.
    const earlier = traceRow({ trace_id: "t_old", trace_start_time: "2026-07-25T09:00:00.000000" });
    const createApi = setupDeps.createSetupApi;
    setupDeps.createSetupApi = (options) => {
      const api = createApi(options);
      return {
        ...api,
        listTraces: async (params) =>
          params?.endBefore === undefined
            ? api.listTraces(params)
            : listTracesFrom([earlier])(params),
      };
    };

    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps,
    });

    expect(result.trace?.attributed).toBe(false);
    const said = plain(err.data);
    expect(said).toContain("may not come from this service");
    expect(said).toContain(
      "◇  First trace since setup started:\n│  https://app.example.test/trace/t_1\n",
    );
    expect(said).not.toContain("Your first trace");
  });

  it("closes a skipped wait by saying where the trace will appear", async () => {
    // The run is finished: the service is instrumented and the only unobserved
    // fact is a trace arriving. So the closing block says where it will show up
    // — and must not send somebody who just watched an agent instrument their
    // service off to "finish the instrumentation task".
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(
      join(dir, "main.py"),
      'import traceroot\n\nif __name__ == "__main__":\n    traceroot.initialize()\n',
    );
    const { writers, out, err } = makeWriters();

    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ instrument: false, traceTimeoutSec: 120 }),
      writers,
      // The wait is only offered where there is somebody to press a key.
      canPrompt: true,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
        skipTraceWait: true,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.trace).toBeNull();
    const said = plain(err.data);
    expect(said).toContain("your first trace just has not been seen yet");
    // The UI this session belongs to, as the backend reported it — never a URL
    // this CLI assembled, which on a self-hosted deployment 404s.
    expect(said).toContain("It will appear here:");
    expect(said).toContain("https://app.example.test");
    expect(said).toContain("traceroot traces list");
    expect(said).toContain("traceroot setup --resume");
    // Not the sentence for a run that stopped before the instrumentation was
    // done, which is the other way to end with no trace.
    expect(said).not.toContain("Finish the instrumentation task");
    // Nor the production instruction, which waits for a trace that shows the
    // instrumentation works.
    expect(said).not.toContain("production environment");
    // Still nothing on stdout: the closing blocks live inside the frame.
    expect(out.data).toBe("");
  });

  it("emits JSON events on stdout and human progress on stderr", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    const { writers, out, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(true),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey("tr-secret-key-for-json-test"),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    // Every stdout line is a standalone JSON object.
    const lines = out.data.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines.at(-1) ?? "{}").event).toBe("result");

    // No secret in either stream.
    expect(out.data).not.toContain("tr-secret-key-for-json-test");
    expect(err.data).not.toContain("tr-secret-key-for-json-test");
  });

  it("finds the checkpoint from a subdirectory of the repository", async () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });

    // A first run from the repository root writes the checkpoint there.
    const first = makeWriters();
    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers: first.writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    // A resume from a subdirectory must find it rather than starting over.
    const second = makeWriters();
    const process2 = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const result = await runSetup({
      ctx: ctxWith(),
      cwd: nested,
      flags: defaultFlags({ agent: "claude", resume: true }),
      writers: second.writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: process2.run,
      }),
    });

    expect(second.err.data).not.toContain("No previous setup to resume");
    expect(result.ok).toBe(true);
    // Instrumentation is not repeated for a repository already set up.
    expect(process2.runs.filter((r) => r.program === "claude")).toHaveLength(0);
  });

  it("frames the run: a titled opening line and a closing block", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    expect(plain(err.data)).toContain(`┌  ${WIZARD_TITLE}`);
    expect(plain(err.data)).toContain("└  TraceRoot local setup complete.");
    // Where to go next, on the way out — the moment it is most likely to be read.
    expect(plain(err.data)).toContain("https://traceroot.ai/docs/cli/get-started");
    expect(err.data).toContain("https://github.com/traceroot-ai/traceroot-cli/issues");
    // Opened before anything the run prints, so the sign-in half is inside it.
    expect(plain(err.data).indexOf("┌")).toBe(0);
    expect(plain(err.data).indexOf("┌")).toBeLessThan(plain(err.data).indexOf("└"));
  });

  it("prints every documentation link on the host the docs are served from", async () => {
    // Pinned by host rather than by page. The links used to point at
    // `docs.traceroot.ai`, which has no DNS record, and the tests that asserted
    // them checked only that a link was printed, never where it went.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    const docs = (plain(err.data).match(/https?:\/\/\S+/g) ?? []).filter((url) =>
      url.includes("docs"),
    );
    // At least the documentation link under the closed frame, so the loop below
    // cannot pass on a run that printed none.
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const url of docs) {
      expect(url).toMatch(/^https:\/\/traceroot\.ai\/docs\//);
    }
  });

  it("leaves no line of a whole run outside the frame, until the frame closes", async () => {
    // One line printed bare — "Signed in as a returning user …" was the one
    // that gave this away — and the wizard visibly stops being a frame.
    //
    // Everything after `└` is a different matter: the wizard has ended, and the
    // support and docs links that follow are the CLI talking to its user, not
    // one more step of a flow that is over.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    // Every glyph that legitimately opens a line: the rail, the frame's
    // corners, a step marker, a note, a warning.
    const framed = plain(err.data).slice(0, plain(err.data).indexOf("└"));
    for (const line of framed.split("\n").filter((l) => l !== "")) {
      expect(line).toMatch(/^[│┌└◇◆▲■]/u);
    }
    // And the frame really did close after all of it, rather than the split
    // above quietly excusing an empty run.
    expect(framed).toContain("┌");
    expect(framed.split("\n").length).toBeGreaterThan(10);
  });

  it("keeps the chrome out of --json entirely", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    const { writers, out, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(true),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    expect(err.data).not.toContain(WIZARD_TITLE);
    expect(out.data).not.toContain(WIZARD_TITLE);
  });

  it("names the step a failed run stopped on", async () => {
    writeFileSync(join(dir, "go.mod"), "module x\n");
    const { writers, err } = makeWriters();

    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags(),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authWithKey(), client: fakeApiClient() }),
    });

    expect(result.ok).toBe(false);
    expect(plain(err.data)).toContain("└  Setup stopped at: work out what to instrument.");
  });

  it("ends by saying the key does not travel, inside the frame", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    // Both variables, because this fixture authenticates against a host that
    // is not the hosted product — so `configure_repository` wrote
    // `TRACEROOT_HOST_URL` into the file as well as the key. The notice named
    // the key alone until this fixture's own host was taken seriously: a
    // staging or self-hosted user who carried only what they were told to
    // carry pointed the SDK at the hosted product, which is not where their
    // credential works, and nothing anywhere said so.
    expect(plain(err.data)).toContain("Add TRACEROOT_API_KEY and TRACEROOT_HOST_URL from");
    expect(plain(err.data)).toContain("Exporting only TRACEROOT_API_KEY leaves the SDK");
    // The service was Python, so the local caveat has to be there too.
    expect(plain(err.data)).toContain("os.environ");
    // Between everything the run printed and the line that closes the frame.
    const at = plain(err.data).indexOf("Add TRACEROOT_API_KEY");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(plain(err.data).indexOf("└"));
  });

  it("says nothing about production for a run that never got a trace", async () => {
    // Telling someone how to deploy an instrumentation that has not been shown
    // to work is premature.
    writeFileSync(join(dir, "go.mod"), "module x\n");
    const { writers, err } = makeWriters();

    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags(),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authWithKey(), client: fakeApiClient() }),
    });

    expect(result.ok).toBe(false);
    expect(err.data).not.toContain("In production");
  });

  it("asks nothing once the first trace has arrived", async () => {
    // The trace is the confirmation, so there is nothing left to acknowledge,
    // and a closing "I have added the key to production" would record a claim
    // whatever the user typed.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const asked: { question: string; stage: string | undefined }[] = [];
    const setupDeps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const inner = setupDeps.prompt;
    setupDeps.prompt = async (question, stage) => {
      asked.push({ question: plain(question), stage });
      return inner(question, stage);
    };
    const { writers, err } = makeWriters();

    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: true,
      setupDeps,
    });

    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
    const said = plain(err.data);
    expect(said).not.toContain("I've confirmed");
    expect(said).not.toContain("I have added");
    // Both closing blocks are still there, and the frame still closes.
    expect(said).toContain("◇  Your first trace:");
    expect(said).toContain("◇  Add TRACEROOT_API_KEY and TRACEROOT_HOST_URL from .env");
    expect(said).toContain("└  TraceRoot local setup complete.");
  });

  it("notes when there is no checkpoint to resume", async () => {
    writeFileSync(join(dir, "go.mod"), "module x\n");
    const { writers, err } = makeWriters();
    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ resume: true }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authWithKey(), client: fakeApiClient() }),
    });
    expect(err.data).toContain("No previous setup to resume");
  });
});

describe("the hosts a --handoff run resolves", () => {
  const CODE = `trh_${"A".repeat(43)}`;
  /** A host only the repository names: what a cloned `.env` would point at. */
  const REPO = "https://repo-chosen.example.test";
  /** A self-hosted deployment, named the way the hand-back command names one. */
  const SELF = "https://traceroot.self.example.test";
  const REMEDY = "the hand-back command names its deployment with --host";

  const hermetic: SetupContextDeps = {
    env: {},
    readConfig: () => null,
    loadEnvFile: () => ({}),
    loadAutoEnvFile: () => ({}),
    readCredential: () => null,
    configIsLocal: true,
  };
  const withEnv = (vars: Record<string, string>): SetupContextDeps => ({
    ...hermetic,
    loadAutoEnvFile: () => vars,
  });

  it("leaves a run without a code resolving exactly as every other command does", () => {
    const deps = withEnv({ TRACEROOT_HOST_URL: REPO, TRACEROOT_AUTH_URL: REPO });
    const run = setupContext({}, deps);

    expect(run.context).toEqual(buildContext({}, deps));
    expect(run.context.auth.hostUrl).toEqual({ value: REPO, source: "auto-env-file" });
    expect(run.hostsSetAside).toBeUndefined();
  });

  it("resolves the two approved hand-backs exactly as before, and says nothing", () => {
    // Cloud: the page omits --host, because the hosted product is the default.
    const cloud = setupContext({ handoff: CODE }, hermetic);
    expect(cloud.context).toEqual(buildContext({}, hermetic));
    expect(cloud.context.auth.authHost).toEqual({ value: DEFAULT_HOST, source: "default" });
    expect(cloud.hostsSetAside).toBeUndefined();

    // Self-hosted: the page passes --host.
    const self = setupContext({ handoff: CODE, host: SELF }, hermetic);
    expect(self.context).toEqual(buildContext({ host: SELF }, hermetic));
    expect(self.context.auth.authHost).toEqual({ value: SELF, source: "default" });
    expect(self.hostsSetAside).toBeUndefined();
  });

  it("sends the code to the default host, not to a TRACEROOT_HOST_URL in this directory's .env", () => {
    const run = setupContext({ handoff: CODE }, withEnv({ TRACEROOT_HOST_URL: REPO }));

    expect(run.context.auth.hostUrl).toEqual({ value: DEFAULT_HOST, source: "default" });
    expect(run.context.auth.authHost).toEqual({ value: DEFAULT_HOST, source: "default" });
    expect(run.hostsSetAside).toBe(`ignored TRACEROOT_HOST_URL in ./.env for --handoff; ${REMEDY}`);
  });

  it("sends the code to the default host, not to a TRACEROOT_AUTH_URL in this directory's .env", () => {
    const run = setupContext({ handoff: CODE }, withEnv({ TRACEROOT_AUTH_URL: REPO }));

    expect(run.context.auth.hostUrl).toEqual({ value: DEFAULT_HOST, source: "default" });
    expect(run.context.auth.authHost).toEqual({ value: DEFAULT_HOST, source: "default" });
    expect(run.hostsSetAside).toBe(`ignored TRACEROOT_AUTH_URL in ./.env for --handoff; ${REMEDY}`);
  });

  it("names both in one line when the .env set both", () => {
    const run = setupContext(
      { handoff: CODE },
      withEnv({ TRACEROOT_HOST_URL: REPO, TRACEROOT_AUTH_URL: `${REPO}:3000` }),
    );

    expect(run.context.auth.authHost.value).toBe(DEFAULT_HOST);
    expect(run.hostsSetAside).toBe(
      `ignored TRACEROOT_HOST_URL in ./.env and TRACEROOT_AUTH_URL in ./.env for --handoff; ${REMEDY}`,
    );
  });

  it("ignores a host_url in this directory's ./.traceroot/config.json, and only the host", () => {
    const run = setupContext(
      { handoff: CODE },
      { ...hermetic, readConfig: () => ({ host_url: REPO, api_key: "tr-config-key" }) },
    );

    expect(run.context.auth.hostUrl).toEqual({ value: DEFAULT_HOST, source: "default" });
    expect(run.context.auth.authHost.value).toBe(DEFAULT_HOST);
    // The key is still there for the ladder's ambient-key rung to set aside.
    expect(run.context.auth.credential).toEqual({
      kind: "api-key",
      value: "tr-config-key",
      source: "config",
    });
    expect(run.hostsSetAside).toBe(
      `ignored host_url in ./.traceroot/config.json for --handoff; ${REMEDY}`,
    );
  });

  it("honours a config file that TRACEROOT_CONFIG_PATH names", () => {
    // Named by the process environment, which is an explicit source.
    const run = setupContext(
      { handoff: CODE },
      { ...hermetic, configIsLocal: false, readConfig: () => ({ host_url: SELF }) },
    );

    expect(run.context.auth.hostUrl).toEqual({ value: SELF, source: "config" });
    expect(run.hostsSetAside).toBeUndefined();
  });

  it("still lets an explicit --host win, and is quiet when the repository's host lost anyway", () => {
    const run = setupContext({ handoff: CODE, host: SELF }, withEnv({ TRACEROOT_HOST_URL: REPO }));

    expect(run.context.auth.hostUrl).toEqual({ value: SELF, source: "flag" });
    expect(run.context.auth.authHost).toEqual({ value: SELF, source: "default" });
    expect(run.hostsSetAside).toBeUndefined();
  });

  it("does not let the .env's auth URL split a --host hand-back", () => {
    const run = setupContext({ handoff: CODE, host: SELF }, withEnv({ TRACEROOT_AUTH_URL: REPO }));

    expect(run.context.auth.authHost).toEqual({ value: SELF, source: "default" });
    expect(run.hostsSetAside).toBe(`ignored TRACEROOT_AUTH_URL in ./.env for --handoff; ${REMEDY}`);
  });

  it("keeps the hosts named by --auth-host, the process environment and --env-file", () => {
    const repoEnv = { TRACEROOT_HOST_URL: REPO, TRACEROOT_AUTH_URL: REPO };

    const authFlag = setupContext(
      { handoff: CODE, host: SELF, authHost: `${SELF}:3000` },
      withEnv(repoEnv),
    );
    expect(authFlag.context.auth.authHost).toEqual({ value: `${SELF}:3000`, source: "flag" });
    expect(authFlag.hostsSetAside).toBeUndefined();

    const fromEnv = setupContext(
      { handoff: CODE },
      {
        ...withEnv(repoEnv),
        env: { TRACEROOT_HOST_URL: SELF, TRACEROOT_AUTH_URL: `${SELF}:3000` },
      },
    );
    expect(fromEnv.context.auth.hostUrl).toEqual({ value: SELF, source: "env" });
    expect(fromEnv.context.auth.authHost).toEqual({ value: `${SELF}:3000`, source: "env" });
    expect(fromEnv.hostsSetAside).toBeUndefined();

    const fromFile = setupContext(
      { handoff: CODE, envFile: "deploy.env" },
      { ...withEnv(repoEnv), loadEnvFile: () => ({ TRACEROOT_HOST_URL: SELF }) },
    );
    expect(fromFile.context.auth.hostUrl).toEqual({ value: SELF, source: "env-file" });
    // The .env's auth URL still loses: the file named only the API host.
    expect(fromFile.context.auth.authHost).toEqual({ value: SELF, source: "default" });
    expect(fromFile.hostsSetAside).toBe(
      `ignored TRACEROOT_AUTH_URL in ./.env for --handoff; ${REMEDY}`,
    );
  });

  it("looks up the saved sign-in under the host it will redeem at, not the repository's", () => {
    // The whole run reads this resolution, so a session saved for the
    // repository's host must not ride along to the default one.
    const looked: string[] = [];
    const run = setupContext(
      { handoff: CODE },
      {
        ...withEnv({ TRACEROOT_HOST_URL: REPO }),
        readCredential: (host) => {
          looked.push(host);
          return host === REPO
            ? { session_token: "repo-session", created_at: "2026-10-01T00:00:00.000Z" }
            : null;
        },
      },
    );

    expect(looked.at(-1)).toBe(DEFAULT_HOST);
    expect(run.context.auth.credential.kind).toBe("none");
  });

  it("reaches the run through the setup command itself, warning included", async () => {
    // Everything above holds only if `runSetupCommand` hands the run
    // `setupContext`'s hosts and its warning. Drop either and a repository
    // `.env` chooses where the code goes again, or does so without a word.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    writeFileSync(join(dir, ".env"), `TRACEROOT_HOST_URL=${REPO}\n`);

    // The real `setup` command, its flags parsed by commander as on a command line.
    const setup = buildProgram().commands.find((c) => c.name() === "setup");
    if (setup === undefined) {
      throw new Error("setup is not registered");
    }
    setup.parseOptions(["--handoff", CODE, "--no-input", "--agent", "claude"]);

    const redeemedAt: string[] = [];
    const { writers, err } = makeWriters();
    await runSetupCommand(setup, 5, {
      cwd: dir,
      writers,
      context: {
        ...hermetic,
        loadAutoEnvFile: () => loadOptionalEnvFileFromDisk(join(dir, ".env")),
      },
      setupDeps: (auth) =>
        makeDeps({
          auth,
          traces: [traceRow()],
          setupApi: fakeSetupApi({
            listProjects: async () => [
              { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
            ],
            createProjectApiKey: async (input) => ({
              id: "ak_1",
              name: input.name,
              hint: "tr-4444-5555",
              project_id: input.projectId,
              scope: input.scope,
              expires_at: null,
              key: "tr-handoff-minted-key-1234",
            }),
          }),
          runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
          redeemHandoff: async ({ authHost }) => {
            redeemedAt.push(authHost);
            return {
              kind: "redeemed",
              credential: { sessionToken: "handoff-session-token", email: "bob@new.example" },
            };
          },
        }),
    });

    expect(redeemedAt).toEqual([DEFAULT_HOST]);
    const warning = `warning: ignored TRACEROOT_HOST_URL in ./.env for --handoff; ${REMEDY}`;
    expect(plain(err.data).split(warning)).toHaveLength(2);
  });
});

describe("a hand-over nothing has acted on yet", () => {
  async function handover(
    flags: Parameters<typeof defaultFlags>[0],
    json = false,
  ): Promise<{ result: Awaited<ReturnType<typeof runSetup>>; out: StringSink; err: StringSink }> {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, out, err } = makeWriters();
    const result = await runSetup({
      ctx: ctxWith(json),
      cwd: dir,
      flags: defaultFlags(flags),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [],
        runProcess: fakeRunProcess().run,
      }),
    });
    return { result, out, err };
  }

  it("ends the task-file route normally, saying once what is outstanding", async () => {
    // It used to stop with exit 14 under a red `error:` block, which read as a
    // crash over the route the user had just picked.
    const { result, err } = await handover({ agent: "claude", instrument: false });
    const said = plain(err.data);

    expect(result.ok).toBe(true);
    expect(setupFailureExit(result, false)).toEqual({ kind: "none" });
    expect(said).toContain(
      "│  No trace yet: setup changed no code, so the service has no TraceRoot in it. Run .traceroot/prompts/setup-instrument.md in Claude Code.\n",
    );
    expect(said).toContain("└  Setup paused — rerun `traceroot setup --resume` to finish.");
    expect(said).not.toContain("Setup stopped at");
    expect(said).not.toContain("▲  Wait for the first trace");
    // Twice: the hand-over's own instruction, and the closing line.
    expect(said.split("setup --resume").length - 1).toBe(2);
  });

  it("says which directory to open the agent in, for a service below the root", async () => {
    // The task's paths and commands are relative to `api/`, while the user is
    // standing at the repository root where they ran setup. The task itself is
    // at the root, so it is named as the agent opened in `api/` resolves it.
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(join(dir, "api", "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "api", "main.py"), "x = 1\n");
    const { writers, err } = makeWriters();
    const result = await runSetup({
      ctx: ctxWith(false),
      cwd: dir,
      flags: defaultFlags({ agent: "claude", instrument: false, service: "api" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authWithKey(), traces: [], runProcess: fakeRunProcess().run }),
    });
    const said = plain(err.data);

    expect(result.ok).toBe(true);
    const task = join("..", ".traceroot", "prompts", "setup-instrument.md");
    expect(said).toContain(`Open Claude Code in api/ and run ${task} there, then rerun`);
    expect(said).toContain(
      `│  No trace yet: setup changed no code, so the service has no TraceRoot in it. Open Claude Code in api/ and run ${task} there.\n`,
    );
    expect(existsSync(join(dir, "api", task))).toBe(true);
  });

  it("points the manual route at the printed steps instead", async () => {
    const { result, err } = await handover({ agent: "claude", method: "manual" });
    const said = plain(err.data);

    expect(result.ok).toBe(true);
    expect(said).toContain(
      "│  No trace yet: setup changed no code, so the service has no TraceRoot in it. Apply the steps above.\n",
    );
    expect(said).not.toContain(".traceroot/prompts");
    expect(said).toContain("└  Setup paused — rerun `traceroot setup --resume` to finish.");
    expect(said.split("setup --resume").length - 1).toBe(2);
  });

  it("reports it under --json as a run that ended without a trace", async () => {
    const { result, out } = await handover({ agent: "claude", instrument: false }, true);
    const events = out.data
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const settled = (stage: string) =>
      events.find((e) => e.event === "stage" && e.stage === stage && e.status !== "start");

    expect(events.at(-1)).toMatchObject({
      event: "result",
      ok: true,
      data: { trace_id: null, trace_url: null },
    });
    expect(settled("instrument")).toMatchObject({ data: { mode: "prompt-only" } });
    expect(settled("verify_trace")?.status).toBe("skipped");
    expect(setupFailureExit(result, true)).toEqual({ kind: "none" });
  });

  it("is offered as unfinished work to the next run, not as a finished one", async () => {
    await handover({ agent: "claude", instrument: false });
    const found = readCheckpoint(dir);

    expect(found?.completedStages).toContain("complete");
    expect(found && resumeQuestion(found).message).toBe(
      "A previous setup for this service did not finish. It is waiting for the instrumentation it handed over. Continue from there?",
    );
  });

  it.each([
    [
      "the task file",
      { agent: "claude", instrument: false },
      "│  No trace yet, and setup cannot tell whether the task was done. Run .traceroot/prompts/setup-instrument.md in Claude Code if not, or run your application once if so.\n",
    ],
    [
      "the manual steps",
      { agent: "claude", method: "manual" },
      "│  No trace yet, and setup cannot tell whether the manual steps were applied. Apply them if not, or run your application once if so.\n",
    ],
  ] as const)(
    "does not say the service has no TraceRoot on a resume after %s",
    async (_, flags, line) => {
      // Detection reads only the entry point, and the task done in the user's
      // own agent may put `initialize()` in a module the entry point imports.
      // The resume's one look finds no trace yet, and "setup changed no code,
      // so the service has no TraceRoot in it" over that is false.
      await handover(flags);
      writeFileSync(join(dir, "tracing.py"), "import traceroot\n\ntraceroot.initialize()\n");
      writeFileSync(join(dir, "main.py"), "import tracing\n\nprint('hi')\n");
      const { writers, err } = makeWriters();
      const result = await runSetup({
        ctx: ctxWith(false),
        cwd: dir,
        flags: defaultFlags({ ...flags, resume: true }),
        writers,
        canPrompt: false,
        setupDeps: makeDeps({ auth: authWithKey(), traces: [], runProcess: fakeRunProcess().run }),
      });
      const said = plain(err.data);

      expect(result.ok).toBe(true);
      expect(said).toContain(line);
      expect(said).not.toContain("has no TraceRoot in it");
      expect(said).toContain("└  Setup paused — rerun `traceroot setup --resume` to finish.");
    },
  );
});

describe("doctor reports setup state", () => {
  function detection(): RepoDetection {
    return {
      root: dir,
      hasPackageJson: false,
      hasPyprojectToml: true,
      hasRequirementsTxt: false,
      hasTsconfigJson: false,
      likelyLanguages: ["python"],
    };
  }

  function auth(): ResolvedAuth {
    return {
      credential: { kind: "api-key" as const, value: "tr-key", source: "config" as const },
      authHost: { value: "https://api.example.test", source: "default" as const },
      projectId: { value: undefined, source: "none" as const },
      hostUrl: { value: "https://api.example.test", source: "config" },
    };
  }

  it("does not call an interrupted run a failure", async () => {
    // An interrupt exits 130, but only so that `traceroot setup && <next>`
    // cannot continue through the keypress meant to stop it. A non-zero status
    // is not the same thing as a fault, and `doctor` must not report the user
    // pressing Ctrl+C as a broken setup — it is the same kind of stop as
    // declining, which exits 0.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck", "authenticate");
    checkpoint.lastError = {
      stage: "select_agent",
      code: "INTERRUPTED",
      message: "Setup interrupted.",
    };
    writeCheckpoint(dir, checkpoint);

    const out = new StringSink();
    const err = new StringSink();
    const report = await runDoctor({
      ctx: { auth: auth(), json: false, timeoutMs: DEFAULT_TIMEOUT_MS },
      cwd: dir,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out, err },
      detection: detection(),
      includeSetup: true,
    });

    const setupChecks = report.checks.filter((c) => c.category === "setup");
    expect(setupChecks.find((c) => c.name === "setup_completed")?.status).toBe("warn");
    expect(setupChecks.find((c) => c.name === "setup_last_error")?.status).toBe("warn");
  });

  it("reports an incomplete setup as a hard failure with the resume hint", async () => {
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck", "authenticate", "instrument");
    checkpoint.lastError = {
      stage: "verify_trace",
      code: "TRACE_TIMEOUT",
      message: "No trace arrived within 120s.",
    };
    writeCheckpoint(dir, checkpoint);

    const out = new StringSink();
    const err = new StringSink();
    const report = await runDoctor({
      ctx: { auth: auth(), json: false, timeoutMs: DEFAULT_TIMEOUT_MS },
      cwd: dir,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out, err },
      detection: detection(),
      includeSetup: true,
    });

    const setupChecks = report.checks.filter((c) => c.category === "setup");
    expect(setupChecks.find((c) => c.name === "setup_completed")?.status).toBe("fail");
    expect(setupChecks.find((c) => c.name === "setup_last_error")?.message).toContain(
      "TRACE_TIMEOUT",
    );
    expect(out.data).toContain("--resume");
    expect(report.summary.fail).toBeGreaterThan(0);
  });

  it("reports a completed setup as passing, with the permalink", async () => {
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("complete");
    checkpoint.projectName = "demo";
    checkpoint.projectKeyHint = "tr-…abcd";
    checkpoint.trace = {
      traceId: "t_1",
      traceUrl: "https://app.example.test/trace/t_1",
      observedAt: "2026-07-26T12:01:00.000Z",
      waitedMs: 4000,
    };
    writeCheckpoint(dir, checkpoint);

    const out = new StringSink();
    const report = await runDoctor({
      ctx: { auth: auth(), json: false, timeoutMs: DEFAULT_TIMEOUT_MS },
      cwd: dir,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out, err: new StringSink() },
      detection: detection(),
      includeSetup: true,
    });

    const setupChecks = report.checks.filter((c) => c.category === "setup");
    expect(setupChecks.every((c) => c.status === "pass")).toBe(true);
    expect(out.data).toContain("https://app.example.test/trace/t_1");
    // Only the hint is ever shown for a credential.
    expect(out.data).toContain("tr-…abcd");
  });

  it("says setup has not run rather than inventing a failure", async () => {
    const report = await runDoctor({
      ctx: { auth: auth(), json: false, timeoutMs: DEFAULT_TIMEOUT_MS },
      cwd: dir,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out: new StringSink(), err: new StringSink() },
      detection: detection(),
      checkpoint: null,
      includeSetup: true,
    });
    const check = report.checks.find((c) => c.name === "setup_run");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("has not been run");
  });

  it("omits the Setup section entirely for a plain doctor run with no checkpoint", async () => {
    mkdirSync(join(dir, ".traceroot"), { recursive: true });
    const report = await runDoctor({
      ctx: { auth: auth(), json: false, timeoutMs: DEFAULT_TIMEOUT_MS },
      cwd: dir,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out: new StringSink(), err: new StringSink() },
      detection: detection(),
      checkpoint: null,
    });
    expect(report.checks.filter((c) => c.category === "setup")).toEqual([]);
  });

  function doctorFor(checkpoint: ReturnType<typeof newCheckpoint>) {
    writeCheckpoint(dir, checkpoint);
    return runDoctor({
      ctx: { auth: auth(), json: false, timeoutMs: DEFAULT_TIMEOUT_MS },
      cwd: dir,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out: new StringSink(), err: new StringSink() },
      detection: detection(),
      includeSetup: true,
    });
  }

  it("warns rather than fails for a cancelled run", async () => {
    // `setup` exits 0 on a cancellation, so `doctor` exiting non-zero for the same
    // run contradicts it — and the Setup section appears on a plain `doctor` too.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck");
    checkpoint.lastError = {
      stage: "instrument",
      code: "CANCELLED",
      message: "Cancelled.",
    };

    const report = await doctorFor(checkpoint);
    const setupChecks = report.checks.filter((c) => c.category === "setup");
    expect(setupChecks.find((c) => c.name === "setup_completed")?.status).toBe("warn");
    expect(setupChecks.find((c) => c.name === "setup_last_error")?.status).toBe("warn");
  });

  it("warns rather than fails for a run that stopped on purpose", async () => {
    // `--no-instrument` records no error at all; it is a pause, not a failure.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck", "authenticate");

    const report = await doctorFor(checkpoint);
    const setupChecks = report.checks.filter((c) => c.category === "setup");
    expect(setupChecks.find((c) => c.name === "setup_completed")?.status).toBe("warn");
    expect(setupChecks.find((c) => c.name === "setup_first_trace")?.status).toBe("warn");
  });
});

describe("doctor on a run that ended without a trace", () => {
  // Every checkpoint here is the one a real run wrote, not one built by hand:
  // the bug was a state no hand-built fixture had, a last stage recorded with
  // neither a trace nor an error.
  async function setupRun(
    cwd: string,
    flags: Parameters<typeof defaultFlags>[0],
    options: { canPrompt?: boolean; skipTraceWait?: boolean } = {},
  ): Promise<string> {
    const { writers, err } = makeWriters();
    await runSetup({
      ctx: ctxWith(),
      cwd,
      flags: defaultFlags(flags),
      writers,
      canPrompt: options.canPrompt ?? false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
        skipTraceWait: options.skipTraceWait,
      }),
    });
    return plain(err.data);
  }

  async function setupChecks(cwd: string = dir): Promise<DoctorCheck[]> {
    const report = await runDoctor({
      ctx: ctxWith(),
      cwd,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out: new StringSink(), err: new StringSink() },
      includeSetup: true,
    });
    return report.checks.filter((c) => c.category === "setup");
  }

  function pythonService(at: string = dir): void {
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(at, "main.py"), "x = 1\n");
  }

  /** The entry point once it calls `initialize()`, so a trace wait has something to wait for. */
  function instrumentEntryPoint(): void {
    writeFileSync(
      join(dir, "main.py"),
      'import traceroot\n\nif __name__ == "__main__":\n    traceroot.initialize()\n',
    );
  }

  /** What the next `setup` asks, given the checkpoint the last run left. */
  function nextQuestion(): string | undefined {
    const found = readCheckpoint(dir);
    return found === null ? undefined : resumeQuestion(found).message;
  }

  it("calls a run whose wait the user ended complete, with no trace seen yet", async () => {
    pythonService();
    const said = await setupRun(
      dir,
      { agent: "claude", traceTimeoutSec: 120 },
      { canPrompt: true, skipTraceWait: true },
    );
    expect(said).toContain("└  TraceRoot local setup complete — no trace seen yet.");

    const checks = await setupChecks();
    const completed = checks.find((c) => c.name === "setup_completed");
    expect(completed?.status).toBe("pass");
    expect(completed?.message).toMatch(/^Setup completed on .+ — no trace seen yet$/);
    expect(completed?.message).not.toContain("stopped at");
    // The trace is still what is missing, and the next step is still to look again.
    expect(checks.find((c) => c.name === "setup_first_trace")?.status).toBe("warn");
  });

  it("names the task a task-file hand-over left to do", async () => {
    pythonService();
    const said = await setupRun(dir, { agent: "claude", instrument: false });
    expect(said).toContain("└  Setup paused — rerun `traceroot setup --resume` to finish.");

    const completed = (await setupChecks()).find((c) => c.name === "setup_completed");
    expect(completed?.status).toBe("warn");
    expect(completed?.message).toBe(
      "Setup is paused, waiting for the instrumentation it handed over. Run the task in .traceroot/prompts/setup-instrument.md in your coding agent.",
    );
  });

  it("names the manual steps a manual hand-over left to do", async () => {
    pythonService();
    await setupRun(dir, { agent: "claude", method: "manual" });

    const completed = (await setupChecks()).find((c) => c.name === "setup_completed");
    expect(completed?.status).toBe("warn");
    expect(completed?.message).toBe(
      "Setup is paused, waiting for the instrumentation it handed over. Apply the manual steps it printed.",
    );
  });

  it.each([
    [
      "after the task was done",
      async () => {
        await setupRun(dir, { agent: "claude", instrument: false });
        instrumentEntryPoint();
        return { agent: "claude", instrument: false, resume: true, traceTimeoutSec: 120 } as const;
      },
    ],
    [
      "in a repository that already called initialize()",
      async () => {
        instrumentEntryPoint();
        return { agent: "claude", instrument: false, traceTimeoutSec: 120 } as const;
      },
    ],
  ] as const)(
    "calls a hand-over complete once the user stopped its wait, %s",
    async (_, before) => {
      // Something could send a trace, so the hand-over route got the full wait,
      // and stopping it closed the run as complete. The route is still on the
      // record, and read alone it called the run paused.
      pythonService();
      const flags = await before();
      const said = await setupRun(dir, flags, { canPrompt: true, skipTraceWait: true });
      expect(said).toContain("└  TraceRoot local setup complete — no trace seen yet.");

      const completed = (await setupChecks()).find((c) => c.name === "setup_completed");
      expect(completed?.status).toBe("pass");
      expect(completed?.message).toMatch(/^Setup completed on .+ — no trace seen yet$/);
      expect(nextQuestion()).toBe(
        "A previous setup for this service already finished. Leave it as it is, or run setup again from the beginning?",
      );
    },
  );

  it("calls the hand-over paused again when a later resume pauses on it", async () => {
    // The stopped wait belongs to the run that stopped it. A resume that finds
    // nothing to wait for pauses as a hand-over does, and has to read as one.
    pythonService();
    instrumentEntryPoint();
    await setupRun(
      dir,
      { agent: "claude", instrument: false, traceTimeoutSec: 120 },
      { canPrompt: true, skipTraceWait: true },
    );
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const said = await setupRun(dir, { agent: "claude", instrument: false, resume: true });
    expect(said).toContain("└  Setup paused — rerun `traceroot setup --resume` to finish.");

    const completed = (await setupChecks()).find((c) => c.name === "setup_completed");
    expect(completed?.status).toBe("warn");
    expect(completed?.message).toContain("Setup is paused");
    expect(nextQuestion()).toBe(
      "A previous setup for this service did not finish. It is waiting for the instrumentation it handed over. Continue from there?",
    );
  });

  it("names the task at the repository root when run from a service directory", async () => {
    // Setup writes the task at the root wherever it was run from, so from the
    // service directory the path has to say so.
    mkdirSync(join(dir, ".git"));
    const api = join(dir, "api");
    pythonService(api);
    await setupRun(api, { agent: "claude", instrument: false });

    const completed = (await setupChecks(api)).find((c) => c.name === "setup_completed");
    expect(completed?.message).toBe(
      `Setup is paused, waiting for the instrumentation it handed over. Run the task in ${displaySkillPath(api, join(dir, ".traceroot", "prompts", "setup-instrument.md"))} in your coding agent.`,
    );
  });

  it("calls a resume that got past a timeout complete, not stopped at the timeout", async () => {
    pythonService();
    await setupRun(dir, { agent: "claude", traceTimeoutSec: 1 });
    expect(readCheckpoint(dir)?.lastError?.code).toBe("TRACE_TIMEOUT");

    await setupRun(
      dir,
      { agent: "claude", resume: true, traceTimeoutSec: 120 },
      { canPrompt: true, skipTraceWait: true },
    );

    const completed = (await setupChecks()).find((c) => c.name === "setup_completed");
    expect(completed?.status).toBe("pass");
    expect(completed?.message).toContain("no trace seen yet");
    expect((await setupChecks()).find((c) => c.name === "setup_last_error")).toBeUndefined();
  });

  it("still reports a later run that stopped, over an earlier one that finished", async () => {
    pythonService();
    await setupRun(
      dir,
      { agent: "claude", traceTimeoutSec: 120 },
      { canPrompt: true, skipTraceWait: true },
    );
    await setupRun(dir, { agent: "claude", resume: true, traceTimeoutSec: 1 });

    const checks = await setupChecks();
    expect(checks.find((c) => c.name === "setup_completed")).toMatchObject({
      status: "fail",
      message: "Setup is incomplete; it stopped at 'verify_trace'. Run `traceroot setup --resume`.",
    });
    expect(checks.find((c) => c.name === "setup_last_error")?.message).toContain("TRACE_TIMEOUT");
  });
});

describe("doctor's skill check after setup ran from a service directory", () => {
  it("finds the skill setup installed at the repository root", async () => {
    mkdirSync(join(dir, ".git"));
    const api = join(dir, "api");
    mkdirSync(api);
    writeFileSync(join(api, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(api, "main.py"), "x = 1\n");
    await runSetup({
      ctx: ctxWith(),
      cwd: api,
      flags: defaultFlags({ agent: "claude", instrument: false }),
      writers: makeWriters().writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authWithKey(), traces: [], runProcess: fakeRunProcess().run }),
    });
    expect(
      existsSync(join(dir, ".claude", "skills", "traceroot-instrument-repo", "SKILL.md")),
    ).toBe(true);

    const report = await runDoctor({
      ctx: ctxWith(),
      cwd: api,
      env: {},
      configPath: join(dir, ".traceroot", "config.json"),
      writers: { out: new StringSink(), err: new StringSink() },
      includeSetup: true,
    });
    expect(report.checks.find((c) => c.name === "skill_instrument")).toMatchObject({
      status: "pass",
      message: "Instrumentation skill installed for Claude Code",
    });
  });
});

describe("finding a previous, unfinished run", () => {
  it("offers to continue it rather than requiring a flag", async () => {
    // Requiring a flag to reach a checkpoint would mean the file is ignored,
    // the run starts over, and a second API key is minted — putting the burden
    // on the user to know a flag exists at the one moment they are least
    // inclined to read help, which is a run that just failed.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    // A finished trace verification, so continuing has something to rehydrate.
    checkpoint.completedStages.push("precheck", "authenticate", "verify_trace");
    checkpoint.trace = {
      traceId: "t_1",
      traceUrl: "https://app.example.test/trace/t_1",
      observedAt: "2026-07-26T12:00:30.000Z",
      waitedMs: 1000,
    };
    writeCheckpoint(dir, checkpoint);

    const asked: string[] = [];
    let polls = 0;
    const setupDeps = makeDeps({
      auth: authWithKey(),
      traces: () => {
        polls += 1;
        return [traceRow()];
      },
    });
    const inner = setupDeps.select;
    setupDeps.select = async (input) => {
      asked.push(input.message);
      return input.message.includes("Continue from there?") ? "resume" : inner(input);
    };

    const { writers } = makeWriters();
    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: true,
      setupDeps,
    });

    expect(asked.some((q) => q.includes("Continue from there?"))).toBe(true);
    // The question names where it stopped, so the answer is informed.
    expect(asked.find((q) => q.includes("Continue from there?"))).toContain("stopped after");
    // And continuing continued. The machine rehydrates a completed stage only
    // under the resume flag, so without it the kept checkpoint bought nothing and
    // every stage ran again — re-polling for a trace it had already seen, minting a
    // second key, and pointing the agent at code it had already edited. Asserting
    // the question alone let all of that pass.
    //
    // The success assertion is what makes the poll count mean something: a run
    // that failed at an earlier stage also polls zero times, so on its own
    // `polls === 0` proves nothing about continuation.
    expect(result.ok).toBe(true);
    expect(polls).toBe(0);
  });

  it("never resumes silently when there is nobody to ask", async () => {
    // Non-interactive must not guess in either direction: resuming silently
    // would repeat work the caller did not ask for, and discarding silently
    // would throw away a run they may have wanted.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck", "authenticate");
    writeCheckpoint(dir, checkpoint);

    const { writers, err } = makeWriters();
    const result = await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      // `--manual`, which reaches the run as this method. It was spelled
      // `manual: true` here, a flag `SetupFlags` has never had, so the run took
      // the default method instead and nothing noticed.
      flags: defaultFlags({ agent: "claude", method: "manual" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authWithKey(), traces: [traceRow()] }),
    });

    expect(err.data).toContain("pass --resume to continue it");
    // And it did not resume: the run is on a checkpoint of its own, not the one
    // it found. The message alone would pass for a run that printed it and then
    // carried on from the old checkpoint anyway.
    expect(result.checkpoint.startedAt).not.toBe(checkpoint.startedAt);
  });
});

describe("a failed run under --json", () => {
  /** A run that fails before any network call: no credential, nobody to ask. */
  async function failedRun(json: boolean): Promise<{
    result: Awaited<ReturnType<typeof runSetup>>;
    out: StringSink;
    err: StringSink;
  }> {
    const { writers, out, err } = makeWriters();
    const result = await runSetup({
      ctx: { auth: authEmpty(), json, timeoutMs: DEFAULT_TIMEOUT_MS },
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authEmpty() }),
    });
    return { result, out, err };
  }

  /**
   * Every JSON object either stream emitted that carries an `error`. Prose
   * lines are skipped: stderr may still carry a warning, which the output
   * contract allows — stdout is the stream that has to stay machine-readable.
   */
  function errorEnvelopes(out: StringSink, err: StringSink): Record<string, unknown>[] {
    return [...out.data.split("\n"), ...err.data.split("\n")]
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((value) => value.error !== undefined);
  }

  it("reports the failure exactly once, with setup's own code", async () => {
    const { result, out, err } = await failedRun(true);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_AUTHENTICATED");

    // What the command does with the failed result, as `registerSetup` does it.
    const failure = setupFailureExit(result, true);
    if (failure.kind === "throw") {
      reportError(failure.error, { json: true }, { out, err });
    }

    const envelopes = errorEnvelopes(out, err);
    expect(envelopes).toHaveLength(1);
    expect((envelopes[0]?.error as { code: string }).code).toBe("NOT_AUTHENTICATED");
    // The exit status still travels, so a script's `$?` is unchanged.
    expect(failure).toEqual({ kind: "exit", code: result.error?.exitCode });
  });

  it("classifies a missing credential as an authentication failure", async () => {
    // This test used to assert `usage`, and the name said the rethrow "would
    // have named the wrong class": setup's statuses were numbered from 1, so
    // NOT_AUTHENTICATED was 2, which is `usage` in the shared table — a
    // consumer taking that line read a bad invocation where the run had failed
    // to authenticate. The codes start above the shared table now and
    // NOT_AUTHENTICATED is the shared `auth` status, so the class is right.
    // What is left of the original point is the other half of it: the rethrow
    // is redundant, because the test above already proves the failure is
    // reported exactly once.
    const { result } = await failedRun(true);
    const { writers, err } = makeWriters();
    reportError(result.error, { json: true }, writers);
    expect((JSON.parse(err.data).error as { code: string }).code).toBe("auth");
  });

  it("still rethrows for a human, where the central handler is the only reporter", async () => {
    const { result, out, err } = await failedRun(false);
    expect(setupFailureExit(result, false)).toEqual({ kind: "throw", error: result.error });
    // Nothing reported it yet: the stage renderer ignores the `result` event.
    expect(out.data).toBe("");
    expect(err.data).not.toContain("error:");
  });

  it("leaves a successful run and a cancellation alone", async () => {
    const base = { stagesRun: [], checkpoint: newCheckpoint(new Date()), trace: null };
    expect(setupFailureExit({ ...base, ok: true, error: null }, true)).toEqual({ kind: "none" });
    const cancelled = new SetupError({
      stage: "select_agent",
      code: "CANCELLED",
      message: "Cancelled.",
    });
    expect(setupFailureExit({ ...base, ok: false, error: cancelled }, true)).toEqual({
      kind: "none",
    });
    expect(setupFailureExit({ ...base, ok: false, error: cancelled }, false)).toEqual({
      kind: "none",
    });
  });
});

describe("--manual with --no-instrument", () => {
  it("is a usage error naming both flags", () => {
    // `chooseInstrumentation` tests the method before the flag, so the pair
    // quietly printed manual instructions and dropped `--no-instrument` without
    // a word. Neither flag is obviously the one the caller meant, so neither is
    // allowed to win silently.
    let thrown: unknown;
    try {
      rejectConflictingMethodFlags({ manual: true, instrument: false });
    } catch (err) {
      thrown = err;
    }
    expect(isCliError(thrown)).toBe(true);
    expect((thrown as { exitCode: number }).exitCode).toBe(ExitCode.usage);
    expect((thrown as Error).message).toContain("--manual");
    expect((thrown as Error).message).toContain("--no-instrument");
  });

  it("leaves either flag on its own alone", () => {
    // `instrument` defaults to true, so only an explicit `--no-instrument`
    // conflicts.
    expect(() => rejectConflictingMethodFlags({ manual: true, instrument: true })).not.toThrow();
    expect(() => rejectConflictingMethodFlags({ instrument: false })).not.toThrow();
    expect(() => rejectConflictingMethodFlags({})).not.toThrow();
  });

  it("stops the real command before it reads anything from disk", async () => {
    // Rejected from the argv alone: no config, no repository, no network.
    await expect(
      buildProgram().parseAsync(["node", "traceroot", "setup", "--manual", "--no-instrument"]),
    ).rejects.toThrow(/--manual cannot be combined with --no-instrument/);
  });
});

describe("`setup doctor --service`", () => {
  /** The real command tree, with `doctor`'s action swapped for a recorder. */
  async function serviceSeenBy(argv: string[]): Promise<{
    local: unknown;
    resolved: string | undefined;
  }> {
    const program = buildProgram();
    const setup = program.commands.find((c) => c.name() === "setup");
    const doctor = setup?.commands.find((c) => c.name() === "doctor");
    expect(doctor).toBeDefined();
    let seen: { local: unknown; resolved: string | undefined } | null = null;
    // Replaces the registered handler, so nothing reads the real config, the
    // real working directory or the network.
    doctor?.action((opts: Record<string, unknown>, command: Command) => {
      seen = { local: opts.service, resolved: resolveServiceOption(command) };
    });
    await program.parseAsync(["node", "traceroot", ...argv]);
    expect(seen).not.toBeNull();
    return seen as unknown as { local: unknown; resolved: string | undefined };
  }

  it("finds the value commander handed to the parent command", async () => {
    // `setup` declares `--service` too and parses first, so `doctor`'s own
    // options stay empty however the flag is written — which is why reading them
    // always saw `undefined` and the run was diagnosed at the repository root.
    for (const argv of [
      ["setup", "doctor", "--service", "api"],
      ["setup", "doctor", "--service=api"],
      ["setup", "--service", "api", "doctor"],
    ]) {
      const seen = await serviceSeenBy(argv);
      expect(seen.local, `local options for \`${argv.join(" ")}\``).toBeUndefined();
      expect(seen.resolved, `resolved service for \`${argv.join(" ")}\``).toBe("api");
    }
  });

  it("stays undefined when the flag is not passed", async () => {
    expect((await serviceSeenBy(["setup", "doctor"])).resolved).toBeUndefined();
  });

  it("is what lets a monorepo run be diagnosed from the repository root", async () => {
    // The consequence the flag exists for: nothing outside the per-service
    // checkpoint records which service a run chose.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push(...SETUP_STAGES);
    checkpoint.service = { path: "api", language: "python", framework: null };
    checkpoint.trace = {
      traceId: "t_1",
      traceUrl: "https://app.example.test/trace/t_1",
      observedAt: "2026-07-26T12:00:30.000Z",
      waitedMs: 1000,
    };
    mkdirSync(join(dir, "api"), { recursive: true });
    writeCheckpoint(join(dir, "api"), checkpoint);

    const setupChecks = async (service: string | undefined): Promise<DoctorCheck[]> => {
      const result = await runDoctor({
        ctx: ctxWith(),
        cwd: dir,
        service,
        env: {},
        configPath: join(dir, ".traceroot", "config.json"),
        writers: { out: new StringSink(), err: new StringSink() },
        includeSetup: true,
      });
      return result.checks.filter((c) => c.category === "setup");
    };

    const named = await setupChecks("api");
    expect(named.find((c) => c.name === "setup_completed")?.status).toBe("pass");
    // Without it, the repository root is all doctor can see, and it reports a
    // run that completed as never having happened.
    const unnamed = await setupChecks(undefined);
    expect(unnamed.find((c) => c.name === "setup_completed")).toBeUndefined();
    expect(unnamed.find((c) => c.name === "setup_run")?.message).toContain("has not been run");
  });
});

describe("--trace-timeout", () => {
  it("defaults when the flag is absent", () => {
    expect(resolveTraceTimeoutSec(undefined)).toBe(120);
  });

  it("accepts a positive whole number of seconds", () => {
    expect(resolveTraceTimeoutSec("30")).toBe(30);
    expect(resolveTraceTimeoutSec(" 30 ")).toBe(30);
  });

  it("rejects a value that is not a positive whole number of seconds", () => {
    // Silently falling back to the default meant a typo'd flag produced a
    // different run — a two-minute wait and a timeout — rather than an error
    // naming the bad value. The global `--timeout` already throws here.
    for (const bad of ["0", "-5", "6O", "abc", "", "1.5", "0x10", "1e2", " "]) {
      let thrown: unknown;
      try {
        resolveTraceTimeoutSec(bad);
      } catch (err) {
        thrown = err;
      }
      expect(isCliError(thrown), `expected --trace-timeout ${bad} to be a usage error`).toBe(true);
      expect((thrown as { exitCode: number }).exitCode).toBe(ExitCode.usage);
      expect((thrown as Error).message).toContain("invalid trace timeout");
    }
  });

  it("rejects a value so large the wait could never end", () => {
    // The poll compares elapsed time against the budget and caps its own sleep,
    // so nothing errors on an absurd value — it simply never gives up.
    expect(() => resolveTraceTimeoutSec("2147484")).toThrow(/invalid trace timeout/);
    expect(() => resolveTraceTimeoutSec("99999999999")).toThrow(/invalid trace timeout/);
  });
});

describe("the question asked about a previous run", () => {
  const unfinished = (): ReturnType<typeof newCheckpoint> => {
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck", "authenticate");
    return checkpoint;
  };

  const finished = (): ReturnType<typeof newCheckpoint> => {
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push(...SETUP_STAGES);
    checkpoint.trace = {
      traceId: "t_1",
      traceUrl: "https://app.example.test/trace/t_1",
      observedAt: "2026-07-26T12:00:30.000Z",
      waitedMs: 1000,
    };
    return checkpoint;
  };

  it("offers to continue a run that stopped part-way, naming where", () => {
    const question = resumeQuestion(unfinished());
    expect(question.message).toBe(
      "A previous setup for this service did not finish. It stopped after sign in to traceroot. Continue from there?",
    );
    expect(question.options.map((o) => o.label)).toEqual(["Continue", "Start over"]);
  });

  it("never tells a user who finished that the run did not finish", () => {
    // The terminal stage's label is "Finish", so one wording for both cases told
    // a user who had just watched setup succeed that "a previous setup for this
    // service did not finish. It stopped after finish." — which is why the CLI
    // looked broken. A finished run says so, and the offer is to run it again
    // rather than to continue something that is over.
    const question = resumeQuestion(finished());
    expect(question.message).toBe(
      "A previous setup for this service already finished. Leave it as it is, or run setup again from the beginning?",
    );
    expect(question.message).not.toContain("did not finish");
    expect(question.message).not.toContain("stopped after");
    expect(question.options.map((o) => o.label)).toEqual(["Leave it as it is", "Run setup again"]);
    // Keeping the finished run is the default: starting over mints a second API
    // key and re-runs an agent over code it has already edited.
    expect(question.options[0]?.value).toBe("resume");
  });

  it("asks the finished question for real, on a checkpoint a completed run wrote", async () => {
    writeCheckpoint(dir, finished());

    const asked: string[] = [];
    const setupDeps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
    });
    const inner = setupDeps.select;
    setupDeps.select = async (input) => {
      asked.push(input.message);
      return input.message.includes("already finished") ? "resume" : inner(input);
    };

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers: makeWriters().writers,
      canPrompt: true,
      setupDeps,
    });

    expect(asked.some((q) => q.includes("already finished"))).toBe(true);
    expect(asked.some((q) => q.includes("did not finish"))).toBe(false);
  });
});

describe("a checkpoint at the repository root that belongs to another service", () => {
  it("is not adopted by a run targeting a different service", async () => {
    // The root lookup finds the checkpoint a run started at the root left there.
    // A root checkpoint can legitimately describe a subdirectory, so without a
    // service comparison a `--service web` run could inherit `api`'s completed
    // stages — and with them its trace.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck", "authenticate", "verify_trace");
    checkpoint.service = { path: "api", language: "python", framework: null };
    writeCheckpoint(dir, checkpoint);
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ name: "web" }), "utf8");

    const asked: string[] = [];
    const setupDeps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
    });
    const inner = setupDeps.select;
    setupDeps.select = async (input) => {
      asked.push(input.message);
      return inner(input);
    };

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude", service: "web" }),
      writers: makeWriters().writers,
      canPrompt: true,
      setupDeps,
    });

    // Never offered, because there was nothing of this service's to resume.
    expect(asked.some((q) => q.includes("Continue from there?"))).toBe(false);
  });
});

describe("the production block that closes a run", () => {
  /**
   * The block's own text, rails and wrapping taken off.
   *
   * It is written through `wizardNote`, which wraps at the frame's width and
   * puts a rail glyph in front of every row — so a phrase of any length
   * straddles a line break on some window and not on another, and asserting on
   * the raw capture is a test that passes because of the terminal it was
   * written for.
   */
  const flat = (text: string) =>
    plain(text)
      .split("\n")
      .map((line) => line.replace(/^[│◇◆▲■┌└]\s*/u, ""))
      .join(" ")
      .replace(/\s+/g, " ");

  /** A key distinctive enough that finding it in the output means something. */
  const KEY = "tr-production-step-secret-value";

  async function run(options: { canPrompt?: boolean; json?: boolean } = {}) {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const { writers, out, err } = makeWriters();
    const asked: string[] = [];
    const base = makeDeps({
      auth: authWithKey(KEY),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });

    const result = await runSetup({
      ctx: ctxWith(options.json ?? false),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers,
      canPrompt: options.canPrompt ?? false,
      setupDeps: {
        ...base,
        prompt: async (question: string) => {
          asked.push(question);
          return "";
        },
      },
    });

    return { result, out, err, asked };
  }

  it("names the env file the run actually wrote", async () => {
    const { result, err } = await run({ canPrompt: true });

    expect(result.ok).toBe(true);
    // Two variables because the fixture's host is not the hosted product's, so
    // the credential file holds `TRACEROOT_HOST_URL` as well — and the one
    // sentence has to name the file this run chose and the variables that host
    // implies, both of which were separately capable of going stale.
    expect(flat(err.data)).toContain(
      "Add TRACEROOT_API_KEY and TRACEROOT_HOST_URL from .env to your production environment.",
    );
  });

  it("names the .env.local a project already had, not the .env it does not", async () => {
    // `chooseCredentialEnvFile` prefers an existing `.env.local`, so this is the
    // file the key is in and the only one worth sending the user to. The notice
    // used to be able to name a constant instead, which on this very run is a
    // file the project does not have.
    writeFileSync(join(dir, ".env.local"), "EXISTING=1\n", "utf8");

    const { err } = await run({ canPrompt: true });

    expect(flat(err.data)).toContain("from .env.local to your production environment");
    expect(flat(err.data)).not.toContain("from .env to");
  });

  it("never puts the key itself in anything it prints", async () => {
    // The block names the variable and the file. The value goes into the env
    // file and the child's environment and nowhere a terminal, a CI log or a
    // scrollback buffer can keep it.
    const { result, out, err } = await run({ canPrompt: true });

    // Both assertions below are negative, and this is the only test guarding
    // the key against the terminal — so the run has to be pinned as having
    // succeeded and having printed the block. Without these two, a run that
    // died at `precheck`, or a block that stopped printing altogether, would
    // satisfy the test by printing nothing at all.
    expect(result.ok).toBe(true);
    expect(flat(err.data)).toContain("Add TRACEROOT_API_KEY and TRACEROOT_HOST_URL from");

    expect(err.data).not.toContain(KEY);
    expect(out.data).not.toContain(KEY);
  });

  it("does not ask the user to say the key is in production", async () => {
    // Nothing branched on the answer, so the run recorded "I have added …"
    // whatever was typed. The instruction is enough, and the run ends without
    // a question.
    const { result, err, asked } = await run({ canPrompt: true });

    expect(result.ok).toBe(true);
    expect(asked.map(plain).filter((q) => q.includes("production"))).toEqual([]);
    expect(err.data).not.toContain("I have added");
    expect(setupFailureExit(result, false)).toEqual({ kind: "none" });
    expect(plain(err.data)).toContain("└  TraceRoot local setup complete.");
  });

  it("prints the instruction without blocking when there is nobody to ask", async () => {
    // The notice reads as well in a CI log as on a terminal; the keypress does
    // not. An unattended run that waited here would hang with the reason three
    // screens up.
    const { result, err, asked } = await run({ canPrompt: false });

    expect(asked).toEqual([]);
    expect(result.ok).toBe(true);
    expect(flat(err.data)).toContain(
      "Add TRACEROOT_API_KEY and TRACEROOT_HOST_URL from .env to your production environment.",
    );
  });

  it("says none of it under --json, and still never prompts", async () => {
    // stdout belongs to the event stream, and a machine consumer has nobody to
    // ask. The `result` event already carries everything this run established.
    const { result, out, err, asked } = await run({ json: true });

    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
    for (const line of out.data.trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(out.data).not.toContain("production environment");
    expect(err.data).not.toContain("production environment");
    expect(err.data).not.toContain("I have added");
  });
});
