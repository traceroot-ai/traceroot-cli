import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli.js";
import { runDoctor } from "../../src/commands/doctor.js";
import { canPrompt, closingLine, runSetup } from "../../src/commands/setup.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import type { Context } from "../../src/context.js";
import type { RepoDetection } from "../../src/repo/detect.js";
import { newCheckpoint, readCheckpoint, writeCheckpoint } from "../../src/setup/checkpoint.js";
import { SetupError } from "../../src/setup/errors.js";
import { WIZARD_TITLE } from "../../src/setup/wizard.js";
import { StringSink } from "../helpers/stringSink.js";
import { plain } from "../setup/colour.js";
import {
  authWithKey,
  defaultFlags,
  fakeApiClient,
  fakeRunProcess,
  makeDeps,
  makeWriters,
  traceRow,
} from "../setup/helpers.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-setup-cmd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctxWith(json = false): Context {
  return { auth: authWithKey(), json };
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
});

describe("the line that closes the wizard", () => {
  const base = { stagesRun: [], checkpoint: newCheckpoint(new Date()), error: null };

  it("claims completion only when a trace actually arrived", () => {
    const trace = {
      traceId: "t_1",
      traceUrl: "https://app.example.test/trace/t_1",
      observedAt: "2026-07-26T12:01:00.000Z",
      waitedMs: 1,
    };
    expect(closingLine({ ...base, ok: true, trace })).toBe("TraceRoot setup complete.");
  });

  it("says paused, not complete, when the run stopped short of a trace", () => {
    // "Complete" over a run with no trace is a claim the user discovers is
    // false the first time they go looking for one.
    expect(closingLine({ ...base, ok: true, trace: null })).toContain("paused");
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
        client: fakeApiClient({ traces: [traceRow()] }),
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
        client: fakeApiClient({ traces: [traceRow()] }),
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
        client: fakeApiClient({ traces: [traceRow()] }),
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
        client: fakeApiClient({ traces: [traceRow()] }),
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
        client: fakeApiClient({ traces: [traceRow()] }),
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    expect(plain(err.data)).toContain(`┌  ${WIZARD_TITLE}`);
    expect(plain(err.data)).toContain("└  TraceRoot setup complete.");
    // Where to go next, on the way out — the moment it is most likely to be read.
    expect(plain(err.data)).toContain("https://docs.traceroot.ai");
    expect(err.data).toContain("https://github.com/traceroot-ai/traceroot-cli/issues");
    // Opened before anything the run prints, so the sign-in half is inside it.
    expect(plain(err.data).indexOf("┌")).toBe(0);
    expect(plain(err.data).indexOf("┌")).toBeLessThan(plain(err.data).indexOf("└"));
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
        client: fakeApiClient({ traces: [traceRow()] }),
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
        client: fakeApiClient({ traces: [traceRow()] }),
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
        client: fakeApiClient({ traces: [traceRow()] }),
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });

    expect(plain(err.data)).toContain("Add the TRACEROOT_API_KEY token");
    // The service was Python, so the local caveat has to be there too.
    expect(plain(err.data)).toContain("os.environ");
    // Between everything the run printed and the line that closes the frame.
    expect(plain(err.data).indexOf("Production Setup")).toBeLessThan(plain(err.data).indexOf("└"));
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

  it("waits for both acknowledgements where there is somebody to ask", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    const asked: string[] = [];
    const setupDeps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const inner = setupDeps.prompt;
    setupDeps.prompt = async (question) => {
      asked.push(question);
      return inner(question);
    };

    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers: makeWriters().writers,
      canPrompt: true,
      setupDeps,
    });

    // One per closing block, in the order a user acts on them: this machine
    // first, then everywhere else.
    const acknowledged = asked.map(plain).filter((q) => q.includes("(Press Enter to continue)"));
    expect(acknowledged).toHaveLength(2);
    expect(acknowledged[0]).toContain("I've confirmed my application is sending traces.");
    expect(acknowledged[1]).toContain("I have added TRACEROOT_API_KEY to my production env.");
    // Each one says how to answer it, once, on the right.
    for (const line of acknowledged) {
      expect(line).toContain("(Press Enter to continue)");
    }
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
      ctx: { auth: auth(), json: false },
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
      ctx: { auth: auth(), json: false },
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
      ctx: { auth: auth(), json: false },
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
      ctx: { auth: auth(), json: false },
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
      ctx: { auth: auth(), json: false },
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
      client: fakeApiClient({
        traces: () => {
          polls += 1;
          return [traceRow()];
        },
      }),
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
    await runSetup({
      ctx: ctxWith(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude", manual: true }),
      writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authWithKey(), client: fakeApiClient({ traces: [traceRow()] }) }),
    });

    expect(err.data).toContain("pass --resume to continue it");
  });
});

describe("a checkpoint at the repository root that belongs to another service", () => {
  it("is not adopted by a run targeting a different service", async () => {
    // The root lookup migrates checkpoints written there by an older version. A
    // root checkpoint can legitimately describe a subdirectory, so without a
    // service comparison a `--service web` run could inherit `api`'s completed
    // stages — and with them its application verification and its trace.
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.completedStages.push("precheck", "authenticate", "verify_trace");
    checkpoint.service = { path: "api", language: "python", framework: null };
    writeCheckpoint(dir, checkpoint);
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ name: "web" }), "utf8");

    const asked: string[] = [];
    const setupDeps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
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
