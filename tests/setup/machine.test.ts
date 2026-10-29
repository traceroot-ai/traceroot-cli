import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** `git status --porcelain -z` record separator. */
const NUL = String.fromCharCode(0);
import type { ApiClientOptions } from "../../src/api/client.js";
import {
  BackendUnavailableError,
  type ProjectSummary,
  type SetupApi,
  SetupApiError,
  type WorkspaceSummary,
} from "../../src/api/setup.js";
import type { CredentialEntry } from "../../src/auth/credentials.js";
import { openBrowserForPlatform, runDeviceFlow } from "../../src/auth/deviceFlow.js";
import { redeemHandoff } from "../../src/auth/handoff.js";
import { DEFAULT_HOST } from "../../src/commands/constants.js";
import { setupContext } from "../../src/commands/setup/run.js";
import { loadConfigOrThrow, writeConfig as writeCliConfig } from "../../src/config/manager.js";
import { type ResolvedAuth, resolveAuth } from "../../src/config/resolve.js";
import { CliError, ExitCode } from "../../src/output.js";
import { serviceArtifactDir } from "../../src/setup/artifacts.js";
import { newCheckpoint, readCheckpoint, writeCheckpoint } from "../../src/setup/checkpoint.js";
import { SETUP_EXIT_CODES } from "../../src/setup/errors.js";
import { type SetupEvent, jsonEmitter } from "../../src/setup/events.js";
import { setupCommand } from "../../src/setup/invocation.js";
import type { SetupDeps } from "../../src/setup/machine.js";
import {
  SETUP_PIPELINE,
  applicationKeyLocation,
  defaultSetupDeps,
  projectOptions,
  runSetupMachine,
  uniqueKeyName,
} from "../../src/setup/machine.js";
import { AGENT_OUTPUT_PATH } from "../../src/setup/transcript.js";
import type { TraceLister } from "../../src/setup/trace.js";
import { SETUP_STAGES, type SetupContext, type SetupFlags } from "../../src/setup/types.js";
import { wizardEmphasis } from "../../src/setup/wizard.js";
import { sleep } from "../../src/util/sleep.js";
import { getVersion } from "../../src/version.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
import type { StringSink } from "../helpers/stringSink.js";
import { plain } from "./colour.js";
import {
  type MakeDepsOptions,
  type RecordedRun,
  authEmpty,
  authWithKey,
  claudeResult,
  codexCapture,
  defaultFlags,
  fakeApiClient,
  fakeRunProcess,
  fakeSetupApi,
  listTracesFrom,
  makeDeps,
  makeWriters,
  traceRow,
  whoami,
} from "./helpers.js";

let dir: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-setup-machine-"));
  // Codex's skills directory is global, not project-local: it is read from
  // `$CODEX_HOME`, falling back to the real `~/.codex`. A hand-over route that
  // targets Codex installs the skill there, so leaving this unpinned makes the
  // suite's behaviour depend on whether the developer running it happens to
  // use Codex — and, worse, writes into their home directory. Pointed at the
  // fixture, the same way `doctor` and `skills` already do.
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

/** A minimal single-service Python repository. */
/**
 * An unsigned JWT carrying `claims`, for the one thing the wizard reads out of
 * an access token: who signed in. Nothing verifies it — `decodeJwtClaims` only
 * base64url-decodes the payload — so three dot-separated segments is the whole
 * of the shape that matters.
 */
function jwtWithClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function pythonRepo(): void {
  writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
  writeFileSync(join(dir, "main.py"), "print('hi')\n");
}

/**
 * Marks the fixture as a git worktree. `readGitState` walks for `.git` before
 * running anything, so without this the git-observing paths short-circuit to
 * "not in a repo" and never consult the fake process runner.
 */
function initGit(): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

interface HarnessOptions {
  flags?: Partial<SetupFlags>;
  deps?: SetupDeps;
  json?: boolean;
  canPrompt?: boolean;
  resumeFrom?: ReturnType<typeof newCheckpoint>;
  /** Where the user ran the command; defaults to the repository root. */
  cwd?: string;
}

function makeCtx(options: HarnessOptions = {}): {
  ctx: SetupContext;
  events: SetupEvent[];
  out: StringSink;
  err: StringSink;
} {
  const { writers, out, err } = makeWriters();
  const events: SetupEvent[] = [];
  const ctx: SetupContext = {
    // Defaults to the repository root; a test that cares about being run from
    // a subdirectory passes its own.
    cwd: options.cwd ?? dir,
    root: dir,
    // The real resolver, not a hardcoded path: where setup's files land is part
    // of what these tests are checking, and pinning it here would let the rule
    // change underneath them without a single failure.
    artifactDir: serviceArtifactDir({
      root: dir,
      cwd: options.cwd ?? dir,
      service: options.flags?.service,
    }),
    json: options.json ?? false,
    canPrompt: options.canPrompt ?? false,
    flags: defaultFlags(options.flags),
    writers,
    checkpoint: options.resumeFrom ?? newCheckpoint(new Date("2026-07-26T12:00:00.000Z")),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    inGitRepo: false,
  };
  return { ctx, events, out, err };
}

describe("happy path", () => {
  it("takes a fresh repository to a verified first trace", async () => {
    pythonRepo();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, events, out } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.trace?.traceUrl).toBe("https://app.example.test/trace/t_1");
    // The machine says nothing on stdout for a human run. Where the trace can
    // be read is the closing block's business (`setup/ending.ts`), inside the
    // frame. A summary sentence written bare to stdout would be the one line
    // of the whole wizard that falls outside it.
    expect(out.data).toBe("");
    expect(events.filter((e) => e.event === "stage").length).toBeGreaterThan(0);
  });

  it("echoes the backend's permalink verbatim rather than constructing one", async () => {
    pythonRepo();
    const odd = "https://selfhosted.internal:8443/x/y/trace/abc?tenant=1";
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow({ trace_url: odd })],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);
    // A self-hosted UI does not live where its API does, so anything the CLI
    // constructed itself would 404 on the first click.
    expect(result.trace?.traceUrl).toBe(odd);
  });

  it("withholds the credential from the agent once a file the application loads holds it", async () => {
    pythonRepo();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey("tr-live-project-key-abcd"),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const agentRun = process.runs.find((r) => r.program === "claude");
    expect(agentRun).toBeDefined();
    // Never on the command line, whichever channel carries it.
    expect(agentRun?.args.join(" ")).not.toContain("tr-live-project-key-abcd");
    // This run wrote the credential into a file the entry point loads, so the
    // environment is no longer the channel and the agent is not given the key.
    // With it present, anything the agent runs can export a trace — including
    // the project's own test suite, which is what made a suite-emitted trace
    // look like proof that the application was instrumented.
    expect(agentRun?.env.TRACEROOT_API_KEY).toBeUndefined();
    // The host is not a credential and travels either way, or the agent cannot
    // tell which deployment it is instrumenting against.
    expect(agentRun?.env.TRACEROOT_HOST_URL).toBeDefined();
    // The parent environment given to deps must be untouched.
    expect(deps.env.TRACEROOT_API_KEY).toBeUndefined();
  });

  it("warns before the launch when the shell exports another key, and drops its TRACEROOT_ENABLED", async () => {
    // Both reach the agent through the inherited environment. The key beats
    // the env file this run wrote, because dotenv does not override, and an
    // exported `false` switched off the application run the task asks for.
    pythonRepo();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey("tr-live-project-key-abcd"),
      env: {
        PATH: "/usr/bin",
        TRACEROOT_API_KEY: "tr-shell-other-project-wxyz",
        TRACEROOT_ENABLED: "false",
      },
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const said = plain(err.data);
    const warning = said.indexOf(
      "warning: your shell exports TRACEROOT_API_KEY (tr-…wxyz), which is not this run's key",
    );
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(said.indexOf("Claude Code finished."));
    const agentRun = process.runs.find((r) => r.program === "claude");
    expect(agentRun).toBeDefined();
    expect("TRACEROOT_ENABLED" in (agentRun?.env ?? {})).toBe(false);
  });

  it("says nothing about the shell's key when it is this run's", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey("tr-live-project-key-abcd"),
      env: { PATH: "/usr/bin", TRACEROOT_API_KEY: "tr-live-project-key-abcd" },
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    expect(plain(err.data)).not.toContain("your shell exports TRACEROOT_API_KEY");
  });

  it("runs none of the project's tests itself", async () => {
    // The suite is the agent's to run, behind `TRACEROOT_ENABLED=false`, and
    // the trace is what setup checks. So setup starts no test command of its
    // own, says nothing about one, and a suite that fails does not stop it.
    pythonRepo();
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: { pytest: { exitCode: 1, output: "1 failed" } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(process.runs.filter((r) => r.program === "pytest")).toEqual([]);
    expect(plain(err.data)).not.toMatch(/Verifying the application|passes its checks/);
  });

  it("records a non-secret checkpoint", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey("tr-live-project-key-abcd"),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const raw = readFileSync(join(dir, ".traceroot", "setup.json"), "utf8");
    expect(raw).not.toContain("tr-live-project-key-abcd");
    const checkpoint = readCheckpoint(dir);
    expect(checkpoint?.projectName).toBe("demo");
    expect(checkpoint?.trace?.traceId).toBe("t_1");
    expect(checkpoint?.completedStages).toContain("complete");
  });
});

describe("choosing what to instrument", () => {
  it("asks for the language, not the directory, when nothing is detected", async () => {
    // Ask which language and leave the service to the agent: the agent does
    // that part better, because it can read the repo.
    writeFileSync(join(dir, "error.py"), "import openai\n");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "run.py"), "import openai\n");

    const deps = makeDeps({ auth: authWithKey(), traces: [traceRow()] });
    const { ctx } = makeCtx({ canPrompt: false });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.remedy).toContain("--language");
    // No directory listing, and no suggestion to name one.
    expect(result.error?.message).not.toContain("scripts");
  });

  it("instruments the answer and leaves the service to the agent", async () => {
    writeFileSync(join(dir, "error.py"), "import openai\n");
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M error.py"] }).run,
      answers: ["python"],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude", method: "manual" } });
    await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.language).toBe("python");
    expect(ctx.stack?.selected?.path).toBe(".");
    // The CLI has not chosen a target; the task tells the agent to find it.
    expect(ctx.stack?.selected?.agentMustIdentify).toBe(true);
  });

  it("proceeds without asking when exactly one service is detected", async () => {
    // A single unambiguous match is not a question. Loose scripts elsewhere do
    // not turn it into one.
    mkdirSync(join(dir, "svc"), { recursive: true });
    writeFileSync(join(dir, "svc", "requirements.txt"), "fastapi\n");
    writeFileSync(join(dir, "svc", "main.py"), "print(1)\n");
    mkdirSync(join(dir, "loose"), { recursive: true });
    writeFileSync(join(dir, "loose", "run.py"), "import openai\n");

    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M svc/main.py"] }).run,
    });
    const { ctx } = makeCtx({ canPrompt: false, flags: { agent: "claude", method: "manual" } });
    await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.path).toBe("svc");
    expect(ctx.stack?.selected?.agentMustIdentify).toBeUndefined();
  });

  it("takes a single detected language as the answer", async () => {
    // Two Python services is not a language question; it is a service
    // question, and the agent settles those.
    for (const name of ["svc-a", "svc-b"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "requirements.txt"), "fastapi\n");
      writeFileSync(join(dir, name, "main.py"), "print(1)\n");
    }

    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M svc-a/main.py"] }).run,
    });
    const { ctx } = makeCtx({ canPrompt: false, flags: { agent: "claude", method: "manual" } });
    await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.language).toBe("python");
    expect(ctx.stack?.selected?.agentMustIdentify).toBe(true);
  });
});

describe("authentication", () => {
  it("skips re-authentication when a valid key is already configured", async () => {
    pythonRepo();
    let whoamiCalls = 0;
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => {
          whoamiCalls += 1;
          return whoami();
        },
      }),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const authEvent = events.find(
      (e) => e.event === "stage" && e.stage === "authenticate" && e.status === "ok",
    );
    expect(authEvent).toBeDefined();
    expect(whoamiCalls).toBeGreaterThan(0);
  });

  it("refuses to replace a credential it could not verify", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => {
          throw new Error("request to https://api.example.test failed: fetch failed");
        },
      }),
    });
    const { ctx } = makeCtx();
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.UNSAFE_OVERWRITE);
    expect(result.error?.message).toContain("rather than replacing it");
  });

  it("refuses to replace a credential on an unreachable host whose port contains 403", async () => {
    // The client's transport failure names the host. Matched against a
    // pattern, `localhost:4030` read as a 403, and setup set out to replace a
    // working key because the network was down.
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => {
          throw new CliError(
            "request to http://localhost:4030 failed: fetch failed",
            ExitCode.network,
          );
        },
      }),
    });
    const { ctx, err } = makeCtx();
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(plain(err.data)).not.toContain("credential was rejected");
  });

  it("fails with a flag hint when there are no credentials and no way to ask", async () => {
    pythonRepo();
    const deps = makeDeps({ auth: authEmpty() });
    const { ctx } = makeCtx({ canPrompt: false });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("NOT_AUTHENTICATED");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.NOT_AUTHENTICATED);
    expect(result.error?.message).toContain("--api-key");
  });

  it("completes a browser sign-in and mints the chosen project's key", async () => {
    // The device flow returns identity only. Choosing the project and minting
    // its key is the same work a returning user's run does — exercised here
    // through the single project the account happens to have, so it is picked
    // automatically with no prompt.
    pythonRepo();
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-browser-minted-key-1234",
      }),
    });
    const written: Array<{ api_key: string; host_url: string; project_id: string }> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      onWriteConfig: (config) => written.push(config),
    });
    const { ctx, err, out } = makeCtx({
      canPrompt: true,
      flags: { browser: true, agent: "claude" },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(ctx.session?.via).toBe("user-credential");
    expect(written).toEqual([
      {
        api_key: "tr-browser-minted-key-1234",
        host_url: "https://api.example.test",
        project_id: "p_1",
      },
    ]);
    expect(ctx.credential?.origin).toBe("minted");
    expect(ctx.credential?.keyId).toBe("ak_1");
    expect(ctx.project?.projectId).toBe("p_1");
    // The device code IS shown — the user compares it with the browser.
    // Neither the session credential nor the minted project key is ever
    // printed.
    expect(err.data).not.toContain("session-token-value");
    expect(err.data).not.toContain("tr-browser-minted-key-1234");
    expect(out.data).not.toContain("tr-browser-minted-key-1234");
  });

  it("shows the link and the code undecorated, and says what it is waiting for", async () => {
    pythonRepo();
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-browser-minted-key-1234",
      }),
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      // Stands in for the shared flow, which narrates itself through the
      // writers it is given.
      runDeviceFlow: async (flowDeps) => {
        flowDeps.writers.err.write("Confirm this code in your browser: ABCD-1234\n");
        flowDeps.writers.err.write("Open https://app.example.test/device?user_code=ABCD-1234\n");
        return { sessionToken: "session-token-value" };
      },
    });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // The heading is ours; everything below it is the shared device flow
    // narrating itself. What this command owns is that those lines land on the
    // rail rather than bare on stderr — the flow writes with `logInfo`, which
    // knows nothing about the frame drawn around it.
    const rows = plain(err.data).split("\n");
    const head = rows.findIndex((row) => row.startsWith("◇  Continue in your browser"));
    expect(rows.slice(head, head + 3)).toEqual([
      // Deliberately short: a heading that wraps would make this assertion
      // depend on the terminal width of whoever runs the suite.
      "◇  Continue in your browser to finish setup.",
      "│",
      // Both routes named, neither asserted. The CLI cannot know which one this
      // person needs — detecting account existence would mean probing for it,
      // an email-enumeration oracle — so it says nothing that a user without an
      // account would read as a precondition they fail.
      "│  Sign in — or create a free account — and approve this terminal.",
    ]);
    // The flow's own lines, on the rail.
    expect(plain(err.data)).toContain("│  Confirm this code in your browser: ABCD-1234");
    // The wait says who it is waiting for. "waiting for sign-in" left a user
    // who had tabbed away with no idea whose move it was. (The old escalating
    // "approved…"/"still waiting…" copy is gone with it: `pollDeviceCode` is
    // now an opaque promise with no intermediate "approved" signal to relay,
    // and the timed escalations it does have fire off a real 1s/25s/90s wall
    // clock the fake `sleep` cannot fast-forward, so they are not
    // deterministically testable here — see `pollDeviceCode`'s own suite in
    // the shared device flow's own tests for that transport behaviour.)
  });

  it("marks the signed-in line with one glyph, not two", async () => {
    pythonRepo();
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-browser-minted-key-1234",
      }),
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    // The name on the line comes from the access token's `email` claim, which
    // is the only identity a user credential carries.
    deps.createTokenProvider = () => ({
      getAccessToken: async () => jwtWithClaims({ email: "someone@example.test" }),
      invalidate: () => undefined,
    });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // One marker in the gutter. `wizardNote` puts the glyph on the block's
    // first row, so a line composed with one of its own arrived as
    // "◇  ◆  Signed in as …" — two markers for one step.
    const rows = plain(err.data).split("\n");
    expect(rows).toContain("◇  Signed in as someone@example.test.");
    expect(rows.some((row) => /^[◇◆]\s+[◇◆]/.test(row))).toBe(false);
  });

  it("persists the session credential the browser sign-in returned", async () => {
    pythonRepo();
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-browser-minted-key-1234",
      }),
    });
    const saved: Array<[string, string]> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      onWriteCredential: (host, entry) => saved.push([host, entry.session_token]),
      runDeviceFlow: async () => ({ sessionToken: "user-session-token-value" }),
    });
    const { ctx, err, out } = makeCtx({
      canPrompt: true,
      flags: { browser: true, agent: "claude" },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // This is the only moment the session credential is ever available in the
    // clear — it is what lets the next repository skip the browser entirely.
    expect(saved).toEqual([["https://api.example.test", "user-session-token-value"]]);
    // And it is no more printable than the project key.
    expect(err.data).not.toContain("user-session-token-value");
    expect(out.data).not.toContain("user-session-token-value");
  });

  it("does not fail a sign-in whose credential could not be saved to disk", async () => {
    // Persisting the session credential buys the NEXT run a skipped browser
    // trip — it must never cost THIS one. (There is no longer a "deployment
    // issues no token" case to cover here: the device flow always hands back
    // a session token, or `pollDeviceCode` itself fails — see
    // the shared device flow's own tests's "refuses an approval that carries no
    // credential". The realistic trigger for a lost credential now is the
    // write itself failing, e.g. a read-only home directory.)
    pythonRepo();
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-browser-minted-key-1234",
      }),
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      onWriteCredential: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    // A missing convenience, not an error.
    expect(result.ok).toBe(true);
    expect(ctx.credential?.origin).toBe("minted");
    expect(err.data).toContain("could not save the TraceRoot sign-in for future runs");
  });

  it("creates the first project when the account has none yet", async () => {
    // A brand-new account has no projects. The browser cannot name one usefully
    // — only the CLI knows the repository — so setup prompts for a name and
    // creates it itself.
    pythonRepo();
    const created: Array<[string, string | undefined]> = [];
    const setupApi = fakeSetupApi({
      listProjects: async () => [],
      listWorkspaces: async () => [{ id: "w_1", name: "acme", role: "admin" }],
      createProject: async (name, workspaceId) => {
        created.push([name, workspaceId]);
        return { project_id: "p_new", project_name: name, workspace_id: "w_1" };
      },
      createProjectApiKey: async (input) => ({
        id: "ak_new",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-key-for-the-new-project",
      }),
    });
    const written: Array<{ api_key: string; host_url: string; project_id: string }> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      onWriteConfig: (config) => written.push(config),
      // The prompt for a new project name; empty accepts the repo-name default.
      answers: [""],
    });
    const { ctx, err, out } = makeCtx({
      canPrompt: true,
      flags: { browser: true, agent: "claude" },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    // Named after the repository.
    expect(created[0]?.[0]).toBe(basename(ctx.root));
    // The device flow hands back identity only — no workspace comes attached
    // the way the old fat handoff payload carried one — so the workspace is
    // resolved here instead, from `listWorkspaces`. A sole workspace is used
    // without asking.
    expect(created[0]?.[1]).toBe("w_1");
    expect(ctx.project?.projectId).toBe("p_new");
    expect(ctx.credential?.origin).toBe("minted");
    expect(written).toEqual([
      {
        api_key: "tr-key-for-the-new-project",
        host_url: "https://api.example.test",
        project_id: "p_new",
      },
    ]);
    expect(err.data).not.toContain("tr-key-for-the-new-project");
    expect(out.data).not.toContain("tr-key-for-the-new-project");
  });

  it("asks which workspace when a new account belongs to several", async () => {
    // The device flow returns identity only, so nothing upstream has narrowed
    // the workspace. Creating the project in the wrong one is discovered weeks
    // later, after traces have been flowing into it — so this asks.
    pythonRepo();
    const created: Array<[string, string | undefined]> = [];
    const setupApi = fakeSetupApi({
      listProjects: async () => [],
      listWorkspaces: async () => [
        { id: "w_1", name: "acme", role: "admin" },
        { id: "w_2", name: "beta", role: "member" },
      ],
      createProject: async (name, workspaceId) => {
        created.push([name, workspaceId]);
        return { project_id: "p_new", project_name: name, workspace_id: workspaceId ?? "w_1" };
      },
      createProjectApiKey: async (input) => ({
        id: "ak_new",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-key-for-the-new-project",
      }),
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      // The workspace choice, then the project name (empty accepts the default).
      answers: ["w_2", ""],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(created[0]?.[1]).toBe("w_2");
  });

  it("does not offer a workspace the user can only view", async () => {
    // A viewer cannot create a project there, so offering it spends the
    // question on a destination the server will refuse with a 403.
    pythonRepo();
    const created: Array<[string, string | undefined]> = [];
    const setupApi = fakeSetupApi({
      listProjects: async () => [],
      listWorkspaces: async () => [
        { id: "w_ro", name: "readonly", role: "viewer" },
        { id: "w_2", name: "beta", role: "member" },
      ],
      createProject: async (name, workspaceId) => {
        created.push([name, workspaceId]);
        return { project_id: "p_new", project_name: name, workspace_id: workspaceId ?? "w_2" };
      },
      createProjectApiKey: async (input) => ({
        id: "ak_new",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-key-for-the-new-project",
      }),
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      // Only the project name: filtering leaves one workspace, so nothing is asked.
      answers: [""],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(created[0]?.[1]).toBe("w_2");
  });

  it("says so when the account has no workspace the user can create in", async () => {
    // Distinct from "no projects": the remedy is access, not a project name.
    pythonRepo();
    const setupApi = fakeSetupApi({
      listProjects: async () => [],
      listWorkspaces: async () => [{ id: "w_ro", name: "readonly", role: "viewer" }],
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      answers: [""],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.message).toContain("no workspace you can create a project in");
  });

  it("fails clearly when a saved sign-in belongs to an account with no projects and setup cannot prompt", async () => {
    // The server refuses to guess a project for you, and interactive prompting
    // is the only way this ambiguity resolves — so a non-interactive run
    // against an empty account has to fail with an actionable message rather
    // than hang or guess. (Reached through the saved-credential path, not the
    // browser one: browser sign-in only ever runs when the wizard can already
    // prompt, so it can never hit this branch itself.)
    pythonRepo();
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi: fakeSetupApi({ listProjects: async () => [] }),
      traces: [traceRow()],
      storedCredential: { session_token: "saved-session-token" },
    });
    const { ctx } = makeCtx({ canPrompt: false });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.message).toContain("no projects yet");
  });

  it("tells an account with no projects to run a command that creates one", async () => {
    // `--project` only selects a project that already exists, so a remedy
    // naming it led to a second error, "No project named '<name>' was found".
    // The command is read out of the remedy and run as the user would run it,
    // in a terminal that can ask, so the remedy cannot drift from what it names.
    pythonRepo();
    const created: Array<[string, string | undefined]> = [];
    const account: MakeDepsOptions = {
      auth: authEmpty(),
      setupApi: fakeSetupApi({
        listProjects: async () => [],
        listWorkspaces: async () => [{ id: "w_1", name: "acme", role: "admin" }],
        createProject: async (name, workspaceId) => {
          created.push([name, workspaceId]);
          return { project_id: "p_new", project_name: name, workspace_id: workspaceId ?? "w_1" };
        },
        createProjectApiKey: async (input) => ({
          id: "ak_new",
          name: input.name,
          hint: "tr-4444-5555",
          project_id: input.projectId,
          scope: "admin",
          expires_at: null,
          key: "tr-key-for-the-new-project",
        }),
      }),
      traces: [traceRow()],
      storedCredential: { session_token: "saved-session-token" },
    };

    const stopped = await runSetupMachine(makeCtx({ canPrompt: false }).ctx, makeDeps(account));

    expect(stopped.error?.code).toBe("AMBIGUOUS");
    expect(stopped.error?.message).toContain("This workspace has no projects yet.");
    const remedy = stopped.error?.remedy ?? "";
    const command = /`([^`]+)`/.exec(remedy)?.[1] ?? "";
    const project = /\s--project\s+(\S+)/.exec(command)?.[1];
    // Nothing else on the command that this test would have to translate.
    expect(command.replace(/\s--project\s+\S+/, "")).toBe("traceroot setup");

    const followed = await runSetupMachine(
      makeCtx({
        canPrompt: true,
        flags: { agent: "claude", ...(project === undefined ? {} : { project }) },
      }).ctx,
      makeDeps({
        ...account,
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
        // The new project's name; empty accepts the repository's.
        answers: [""],
      }),
    );

    expect(followed.error).toBeNull();
    expect(created).toEqual([[basename(dir), "w_1"]]);
    expect(remedy).toBe(
      "Run `traceroot setup` in an interactive terminal, which asks for a name and creates the project, or create one in the TraceRoot dashboard and rerun setup.",
    );
  });

  it("signs in from a saved credential without opening a browser", async () => {
    pythonRepo();
    let deviceFlowCalls = 0;
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => ({
        id: "ak_new",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-minted-without-a-browser",
      }),
    });
    const written: Array<{ api_key: string; host_url: string; project_id: string }> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      onWriteConfig: (config) => written.push(config),
      storedCredential: { session_token: "saved-session-token" },
      runDeviceFlow: async () => {
        deviceFlowCalls += 1;
        throw new Error("the browser handoff should not have been reached");
      },
    });
    // Which token the sign-in was built from, read back rather than inferred
    // from the run succeeding: the fake API answers whatever it is handed.
    const tokens: string[] = [];
    const provider = deps.createTokenProvider;
    deps.createTokenProvider = (opts) => {
      tokens.push(opts.sessionToken);
      return provider(opts);
    };
    const { ctx, err, out } = makeCtx({
      canPrompt: true,
      flags: { browser: true, agent: "claude" },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // The entire point: no device code, no link, no waiting.
    expect(deviceFlowCalls).toBe(0);
    expect(tokens).toEqual(["saved-session-token"]);
    expect(err.data).toContain("Signed in as a returning user. No browser needed.");
    expect(ctx.session?.via).toBe("user-credential");
    expect(ctx.credential?.origin).toBe("minted");
    expect(ctx.project?.projectId).toBe("p_1");
    expect(written).toEqual([
      {
        api_key: "tr-minted-without-a-browser",
        host_url: "https://api.example.test",
        project_id: "p_1",
      },
    ]);
    // Neither credential is printable.
    expect(err.data).not.toContain("saved-session-token");
    expect(err.data).not.toContain("tr-minted-without-a-browser");
    expect(out.data).not.toContain("tr-minted-without-a-browser");
  });

  it("falls back to the browser when the saved credential has been revoked", async () => {
    pythonRepo();
    const cleared: string[] = [];
    let listProjectsCalls = 0;
    const setupApi = fakeSetupApi({
      listProjects: async () => {
        listProjectsCalls += 1;
        if (listProjectsCalls === 1) {
          throw new SetupApiError("Invalid or expired session", 401);
        }
        return [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }];
      },
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-browser-minted-key-1234",
      }),
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      storedCredential: { session_token: "revoked-session-token" },
      onDeleteCredential: (host) => {
        cleared.push(host);
        return true;
      },
    });
    const { ctx, err } = makeCtx({
      canPrompt: true,
      flags: { browser: true, agent: "claude" },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // Both the saved-credential and the fresh-browser paths land here now —
    // there is no separate "browser" outcome to distinguish.
    expect(ctx.session?.via).toBe("user-credential");
    // A credential known not to work is forgotten, so later runs do not waste
    // a round trip rediscovering that.
    expect(cleared).toEqual(["https://api.example.test"]);
    expect(err.data).toContain("expired");
  });

  it("retries with a dated name when this repository already has a key", async () => {
    pythonRepo();
    const attempted: string[] = [];
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => {
        attempted.push(input.name);
        if (attempted.length === 1) {
          throw new SetupApiError("An API key named 'x' already exists in this project", 409);
        }
        return {
          id: "ak_new",
          name: input.name,
          hint: "tr-4444-5555",
          project_id: input.projectId,
          scope: "admin",
          expires_at: null,
          key: "tr-second-attempt-key",
        };
      },
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      storedCredential: { session_token: "tru-saved-token" },
    });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    // Rerunning setup in a repository must not fail just because the previous
    // run named a key after it; the old secret is unrecoverable anyway.
    expect(result.ok).toBe(true);
    // Three attempts for two keys: the first name was taken, so it was retried
    // with the run date appended, and the application's key follows.
    expect(attempted).toHaveLength(3);
    expect(attempted[1]).not.toBe(attempted[0]);
    expect(attempted[1]).toContain(attempted[0]);
    // A 409 created nothing, so there is no key to go looking for.
    expect(plain(err.data)).not.toContain("did not confirm");
  });

  for (const [why, error] of [
    ["a 5xx", new SetupApiError("Service Unavailable", 503)],
    ["a reply that never arrived", new SetupApiError("fetch failed", 0)],
  ] as const) {
    it(`names the key a mint may have created on ${why}`, async () => {
      // The server may have committed the key before the reply was lost, and
      // the ledger never saw it, so the rollback cannot revoke it. Naming it is
      // the only way the user learns there is a key to look for.
      pythonRepo();
      const attempted: string[] = [];
      const setupApi = fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        createProjectApiKey: async (input) => {
          attempted.push(input.name);
          throw error;
        },
      });
      const deps = makeDeps({
        auth: authEmpty(),
        setupApi,
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
        storedCredential: { session_token: "tru-saved-token" },
      });
      const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

      const result = await runSetupMachine(ctx, deps);

      expect(result.ok).toBe(false);
      // Not retried under another name, which could only orphan a second key.
      expect(attempted).toHaveLength(1);
      expect(plain(err.data)).toContain(
        `the server did not confirm the API key ${attempted[0]}, but it may have been created. If it shows up in the project's API keys at https://api.example.test, delete it, or ask a workspace admin to.`,
      );
      expect(ctx.checkpoint.mintedKeys ?? []).toEqual([]);
    });
  }

  it("does not use a saved credential belonging to a different host", async () => {
    // `readCredential` is keyed by host; this pins that the machine asks for
    // the host it is actually talking to.
    pythonRepo();
    const asked: string[] = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi: fakeSetupApi(),
      traces: [traceRow()],
    });
    const spied: SetupDeps = {
      ...deps,
      readCredential: (host) => {
        asked.push(host);
        return null;
      },
    };
    const { ctx } = makeCtx({ canPrompt: false });
    await runSetupMachine(ctx, spied);

    expect(asked).toEqual(["https://api.example.test"]);
  });

  it("names the local stack when one is answering and the default host lacks setup", async () => {
    // The commonest cause of this error is a developer testing against their own
    // stack while the CLI correctly defaults to Cloud. Say so, with the command.
    pythonRepo();
    const deps = makeDeps({
      auth: {
        credential: { kind: "none", value: undefined, source: "none" },
        hostUrl: { value: undefined, source: "none" },
        authHost: { value: undefined, source: "none" },
        projectId: { value: undefined, source: "none" },
      },
      runDeviceFlow: async () => {
        throw new CliError("could not start device login (status 404): not found", ExitCode.auth);
      },
      localHostResponds: true,
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("BACKEND_UNSUPPORTED");
    // Names the host it actually asked, and the one that answered.
    expect(result.error?.message).toContain("app.traceroot.ai");
    expect(result.error?.message).toContain("http://localhost:8000");
    expect(result.error?.message).toContain("--host http://localhost:8000");
  });

  it("does not invent a local host when nothing is listening", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: {
        credential: { kind: "none", value: undefined, source: "none" },
        hostUrl: { value: undefined, source: "none" },
        authHost: { value: undefined, source: "none" },
        projectId: { value: undefined, source: "none" },
      },
      runDeviceFlow: async () => {
        throw new CliError("could not start device login (status 404): not found", ExitCode.auth);
      },
      localHostResponds: false,
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true } });
    const result = await runSetupMachine(ctx, deps);
    expect(result.error?.message).not.toContain("localhost");
    // TraceRoot Cloud serves sign-in and the API from one origin.
    expect(result.error?.message).not.toContain("--auth-host");
  });

  it("names the manual fallback when browser sign-in is not deployed", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authEmpty(),
      runDeviceFlow: async () => {
        throw new CliError("could not start device login (status 404): not found", ExitCode.auth);
      },
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("BACKEND_UNSUPPORTED");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.BACKEND_UNSUPPORTED);
    expect(result.error?.message).toContain("--no-browser");
  });

  /** The real device flow, against a host with no device endpoint. Records where it asked. */
  function noDeviceEndpoint(asked: string[]): SetupDeps["runDeviceFlow"] {
    const { fetchImpl } = createFakeFetch((call) => {
      asked.push(call.url);
      return jsonResponse({ error: "not_found" }, 404);
    });
    return (flowDeps) => runDeviceFlow({ ...flowDeps, fetchImpl });
  }

  /** A self-hosted API on its own origin, with or without `--auth-host`. */
  function selfHosted(authHost?: string): ResolvedAuth {
    return {
      ...authEmpty(),
      hostUrl: { value: "http://localhost:8000", source: "flag" },
      authHost:
        authHost === undefined
          ? { value: "http://localhost:8000", source: "default" }
          : { value: authHost, source: "flag" },
    };
  }

  it("offers --auth-host when browser sign-in went to the API host and found nothing", async () => {
    // A self-hosted deployment with the web app on another origin answers
    // exactly this way when only `--host` is given.
    pythonRepo();
    const asked: string[] = [];
    const deps = makeDeps({ auth: selfHosted(), runDeviceFlow: noDeviceEndpoint(asked) });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true } });

    const result = await runSetupMachine(ctx, deps);

    expect(asked).toEqual(["http://localhost:8000/api/auth/device/code"]);
    expect(result.error?.code).toBe("BACKEND_UNSUPPORTED");
    expect(result.error?.message).toBe(
      [
        "Browser sign-in is not available at http://localhost:8000 yet.",
        "",
        "If the web app is on a different origin from the API, sign in there with --auth-host:",
        `  ${setupCommand()} --host http://localhost:8000 --auth-host <web app origin>`,
        "",
        "If you meant a different deployment, point the CLI at it:",
        `  ${setupCommand()} --host <url>        (or set TRACEROOT_HOST_URL)`,
        "",
        "Otherwise sign in with a key instead:",
        `  ${setupCommand()} --no-browser`,
        "or set TRACEROOT_API_KEY before running setup.",
      ].join("\n"),
    );
  });

  it("names the auth host, not the API host, when that is where sign-in found nothing", async () => {
    pythonRepo();
    const asked: string[] = [];
    const deps = makeDeps({
      auth: selfHosted("http://localhost:3000"),
      runDeviceFlow: noDeviceEndpoint(asked),
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true } });

    const result = await runSetupMachine(ctx, deps);

    expect(asked).toEqual(["http://localhost:3000/api/auth/device/code"]);
    expect(result.error?.code).toBe("BACKEND_UNSUPPORTED");
    expect(result.error?.message).toContain(
      "Browser sign-in is not available at http://localhost:3000 yet.",
    );
    // An auth host was given; telling the user to add one would be wrong.
    expect(result.error?.message).not.toContain("--auth-host");
    expect(result.error?.remedy).toBe(
      [
        "If you meant a different deployment, point the CLI at it:",
        `  ${setupCommand()} --host <url>        (or set TRACEROOT_HOST_URL)`,
        "",
        "Otherwise sign in with a key instead:",
        `  ${setupCommand()} --no-browser`,
        "or set TRACEROOT_API_KEY before running setup.",
      ].join("\n"),
    );
  });

  // `--auth-host` and TRACEROOT_AUTH_URL: the two ways a user names the web app.
  for (const source of ["flag", "env"] as const) {
    it(`doesn't offer --auth-host when the auth host was given (${source}) as the API host itself`, async () => {
      pythonRepo();
      const asked: string[] = [];
      const deps = makeDeps({
        auth: { ...selfHosted(), authHost: { value: "http://localhost:8000", source } },
        runDeviceFlow: noDeviceEndpoint(asked),
      });
      const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true } });

      const result = await runSetupMachine(ctx, deps);

      expect(asked).toEqual(["http://localhost:8000/api/auth/device/code"]);
      expect(result.error?.code).toBe("BACKEND_UNSUPPORTED");
      expect(result.error?.message).toContain(
        "Browser sign-in is not available at http://localhost:8000 yet.",
      );
      // The user already named the web app's origin; that one is the answer.
      expect(result.error?.message).not.toContain("--auth-host");
    });
  }

  /**
   * The real device flow, against an auth host that issues a code and answers
   * every poll with `poll`. Real rather than a thrown stand-in, so what is
   * asserted is the error `login` and `setup` actually share.
   */
  function deviceFlowAnswering(poll: Record<string, string>): SetupDeps["runDeviceFlow"] {
    let clock = 0;
    const { fetchImpl } = createFakeFetch((call) =>
      call.url.endsWith("/api/auth/device/code")
        ? jsonResponse({
            device_code: "dev-1",
            user_code: "ABCDEFGH",
            verification_uri_complete: "https://api.example.test/device?user_code=ABCDEFGH",
            expires_in: 12,
            interval: 5,
          })
        : jsonResponse(poll, 400),
    );
    return (flowDeps) =>
      runDeviceFlow({
        ...flowDeps,
        fetchImpl,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        openBrowser: async () => true,
      });
  }

  for (const [what, poll, message] of [
    ["is denied", { error: "access_denied" }, "The sign-in was denied in the browser."],
    [
      "expires",
      { error: "expired_token" },
      "The sign-in code expired before it was approved in the browser.",
    ],
    // Nothing comes back from a tab that was closed: the code just runs out.
    [
      "runs out while still pending",
      { error: "authorization_pending" },
      "The sign-in code expired before it was approved in the browser.",
    ],
  ] as const) {
    it(`gives one remedy, rerunning setup, when the browser sign-in ${what}`, async () => {
      pythonRepo();
      const deps = makeDeps({ auth: authEmpty(), runDeviceFlow: deviceFlowAnswering(poll) });
      const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true } });

      const result = await runSetupMachine(ctx, deps);

      expect(result.error?.code).toBe("NOT_AUTHENTICATED");
      // A sign-in that did not happen, not an internal error.
      expect(result.error?.exitCode).toBe(ExitCode.auth);
      expect(result.error?.message).toBe(`${message}\n\nRun \`${setupCommand()}\` again.`);
      expect(result.error?.remedy).toBe(`Run \`${setupCommand()}\` again.`);
      // `login` signs the terminal in and stops there, and TraceRoot sign-up
      // sends no email to verify.
      expect(plain(err.data)).not.toContain("traceroot login");
      expect(plain(err.data)).not.toMatch(/email/i);
      // The remedy above is the only one.
      expect(plain(err.data)).not.toContain("didn't complete in the browser");
    });
  }
});

describe("the handoff code from browser-first onboarding", () => {
  /** Shaped like the real thing: `trh_` + 43 base64url characters. */
  const CODE = `trh_${"A".repeat(43)}`;

  /**
   * Rendered output with the rail and its wrapping flattened, so a sentence can
   * be asserted as a sentence rather than at whatever width it was drawn.
   */
  function said(data: string): string {
    return plain(data)
      .split("\n")
      .map((line) => line.replace(/^[\u2502\u25c7\u25c6\u25b2\u25cf]/u, "").trim())
      .join(" ")
      .replace(/\s+/g, " ");
  }

  /** The account work a signed-in run does, so a handoff can reach the end. */
  function projectApi() {
    return fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: "admin",
        expires_at: null,
        key: "tr-handoff-minted-key-1234",
      }),
    });
  }

  interface HandoffRun {
    redeem?: MakeDepsOptions["redeemHandoff"];
    stored?: CredentialEntry | null;
    auth?: ResolvedAuth;
    deviceToken?: string;
    flags?: Partial<SetupFlags>;
    /** Makes the configured API key fail verification, as a dead key does. */
    rejectKey?: boolean;
  }

  /**
   * A whole run reached through `--handoff`, with everything the stage touches
   * recorded: the credentials written, the session tokens handed to the token
   * mint, the redemptions attempted, whether the device flow was used, and
   * every process the run launched — the agent among them, which is what the
   * code has to have stayed out of.
   */
  function handoffRun(options: HandoffRun = {}) {
    pythonRepo();
    const launched = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const written: CredentialEntry[] = [];
    const writtenTo: string[] = [];
    const minted: string[] = [];
    const mintedAt: string[] = [];
    const redeemed: Array<{ authHost: string; code: string }> = [];
    const keysUsed: string[] = [];
    let deviceFlows = 0;
    const client = fakeApiClient({
      whoamiResult: async () => {
        // Only the *configured* key is dead. The project key this run mints is
        // verified through `whoami` too, and rejecting that would fail the run
        // for a reason this test is not about.
        if (options.rejectKey === true && keysUsed.at(-1) === "tr-explicit-key") {
          throw new SetupApiError("Invalid API key", 401);
        }
        return whoami();
      },
    });
    const deps = makeDeps({
      auth: options.auth ?? authEmpty(),
      setupApi: projectApi(),
      client,
      traces: [traceRow()],
      runProcess: launched.run,
      storedCredential: options.stored ?? null,
      onWriteCredential: (host, entry) => {
        writtenTo.push(host);
        written.push(entry);
      },
      runDeviceFlow: async () => {
        deviceFlows += 1;
        return { sessionToken: options.deviceToken ?? "device-session-token-value" };
      },
      redeemHandoff:
        options.redeem ??
        (async (opts) => {
          redeemed.push({ authHost: opts.authHost, code: opts.code });
          return {
            kind: "redeemed",
            credential: { sessionToken: "handoff-session-token", email: "bob@new.example" },
          };
        }),
    });
    // `makeDeps` ignores the mint's options; which session token reaches it is
    // exactly what "the handoff won" means, so record it.
    deps.createTokenProvider = (opts) => {
      minted.push(opts.sessionToken);
      mintedAt.push(opts.authHost);
      return { getAccessToken: async () => "access-jwt-value", invalidate: () => undefined };
    };
    // Which API key the run actually authenticates with. `whoami` alone cannot
    // answer that: the project-key mint verifies its new key the same way.
    deps.createClient = (opts: ApiClientOptions) => {
      if (opts.auth.kind === "api-key") {
        keysUsed.push(opts.auth.key);
      }
      return client;
    };
    const harness = makeCtx({
      canPrompt: true,
      flags: { browser: true, agent: "claude", handoff: CODE, ...options.flags },
    });
    return {
      ...harness,
      deps,
      written,
      writtenTo,
      minted,
      mintedAt,
      redeemed,
      keysUsed,
      launched: launched.runs,
      deviceFlows: () => deviceFlows,
    };
  }

  /** Resolved auth holding an API key the user never asked this run to use. */
  function ambientKey(source: "config" | "auto-env-file" | "credentials-file"): ResolvedAuth {
    return {
      credential: { kind: "api-key", value: "tr-stale-ambient-key", source },
      hostUrl: { value: "https://api.example.test", source: "config" },
      authHost: { value: "https://api.example.test", source: "default" },
      projectId: { value: undefined, source: "none" },
    };
  }

  /** Resolved auth holding an API key the user named on purpose. */
  function explicitKey(source: "flag" | "env" | "env-file"): ResolvedAuth {
    return {
      credential: { kind: "api-key", value: "tr-explicit-key", source },
      hostUrl: { value: "https://api.example.test", source: "config" },
      authHost: { value: "https://api.example.test", source: "default" },
      projectId: { value: undefined, source: "none" },
    };
  }

  it("signs in from the code without opening a browser page", async () => {
    const run = handoffRun();
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.deviceFlows()).toBe(0);
    expect(run.redeemed).toEqual([{ authHost: "https://api.example.test", code: CODE }]);
    expect(said(run.err.data)).toContain("Signed in as bob@new.example.");
    expect(said(run.err.data)).toContain("no second page needed");
    // Single-use, so spent at sign-in and not kept for the rest of the run.
    expect(run.ctx.flags.handoff).toBeUndefined();
  });

  it("writes a credential indistinguishable from the one a device flow writes", async () => {
    // The whole design rests on this: downstream there is no handoff session,
    // only an ordinary `credentials-file` one.
    const viaHandoff = handoffRun();
    expect((await runSetupMachine(viaHandoff.ctx, viaHandoff.deps)).ok).toBe(true);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const viaDevice = handoffRun({
      flags: { handoff: undefined },
      deviceToken: "handoff-session-token",
    });
    // The browser path learns the email from the access token's claim; the
    // handoff path is handed it. Same field, same value, two sources.
    viaDevice.deps.createTokenProvider = () => ({
      getAccessToken: async () => jwtWithClaims({ email: "bob@new.example" }),
      invalidate: () => undefined,
    });
    expect((await runSetupMachine(viaDevice.ctx, viaDevice.deps)).ok).toBe(true);

    expect(viaHandoff.written).toHaveLength(1);
    expect(viaDevice.written).toHaveLength(1);
    const [handoffEntry] = viaHandoff.written;
    const [deviceEntry] = viaDevice.written;
    // `created_at` is a clock reading, not an identity: the two paths make a
    // different number of calls before the write.
    expect(typeof handoffEntry?.created_at).toBe("string");
    expect({ ...handoffEntry, created_at: "" }).toEqual({ ...deviceEntry, created_at: "" });
    expect(handoffEntry?.session_token).toBe("handoff-session-token");
  });

  it("falls back to the device flow when the code is refused, and says why", async () => {
    const run = handoffRun({ redeem: async () => ({ kind: "rejected" }) });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.deviceFlows()).toBe(1);
    const text = said(run.err.data);
    expect(text).toContain("the sign-in code from the browser is no longer valid");
    expect(text).toContain("signing in the normal way");
    // And the run ends up on the device flow's credential, not a half-written one.
    expect(run.written.map((e) => e.session_token)).toEqual(["device-session-token-value"]);
  });

  it("falls back to the device flow on a server without the handoff route", async () => {
    // Through the real redemption, so the 404 is the server's answer and not a
    // stubbed outcome.
    const fake = createFakeFetch(() => jsonResponse({}, 404));
    const run = handoffRun({
      redeem: (opts) => redeemHandoff({ ...opts, fetchImpl: fake.fetchImpl }),
    });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(fake.calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(run.deviceFlows()).toBe(1);
    expect(said(run.err.data)).toContain("signing in the normal way");
  });

  it("bounds the redemption the way whoami is bounded", async () => {
    // Unbounded, a stalled app held the run until Node's own fetch defaults
    // gave up, minutes later.
    const timeouts: Array<number | undefined> = [];
    const run = handoffRun({
      redeem: async (opts) => {
        timeouts.push(opts.timeoutMs);
        return { kind: "redeemed", credential: { sessionToken: "handoff-session-token" } };
      },
    });
    await runSetupMachine(run.ctx, run.deps);

    expect(timeouts).toEqual([15_000]);
  });

  it("does not fall back when redemption fails for a network reason", async () => {
    // A reachability problem reported as a bad code sends the user hunting for
    // a new one they do not need — and would quietly burn a live code.
    for (const status of [429, 503]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const run = handoffRun({
        redeem: async () => {
          throw new CliError(`handoff sign-in failed with status ${status}`, ExitCode.network);
        },
      });
      const result = await runSetupMachine(run.ctx, run.deps);

      expect(result.ok, `status ${status} stops the run`).toBe(false);
      expect(run.deviceFlows(), `status ${status} does not open a browser`).toBe(0);
      expect(run.written, `status ${status} writes no credential`).toEqual([]);
      expect(result.error?.message).toContain(String(status));
    }
  });

  it("never prints the code, on the happy path or on any failure", async () => {
    const ok = handoffRun();
    await runSetupMachine(ok.ctx, ok.deps);
    expect(ok.out.data).not.toContain(CODE);
    expect(ok.err.data).not.toContain(CODE);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const refused = handoffRun({ redeem: async () => ({ kind: "rejected" }) });
    await runSetupMachine(refused.ctx, refused.deps);
    expect(refused.out.data).not.toContain(CODE);
    expect(refused.err.data).not.toContain(CODE);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const broken = handoffRun({
      // The one place a code could realistically escape: a runtime error that
      // quotes the request body. `redeemHandoff` redacts it; this proves the
      // wizard adds no second copy of its own.
      redeem: async () => {
        throw new CliError("request to https://ui failed: <redacted>", ExitCode.network);
      },
    });
    const result = await runSetupMachine(broken.ctx, broken.deps);
    expect(broken.out.data).not.toContain(CODE);
    expect(broken.err.data).not.toContain(CODE);
    expect(result.error?.message).not.toContain(CODE);
  });

  it("beats a stored credential and names both accounts when they differ", async () => {
    const run = handoffRun({
      stored: {
        session_token: "saved-session-token",
        email: "alice@old.example",
        created_at: "2026-07-01T00:00:00.000Z",
      },
    });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    // The handoff is the credential the run actually used…
    expect(run.minted).toEqual(["handoff-session-token"]);
    expect(run.written.map((e) => e.session_token)).toEqual(["handoff-session-token"]);
    // …and `writeCredential` replaced the stored entry, so the run says so.
    expect(said(run.err.data)).toContain(
      "Signed in as alice@old.example; the code from the browser is for bob@new.example — switching.",
    );
  });

  it("says nothing about switching when the handoff is for the account already stored", async () => {
    const run = handoffRun({
      stored: {
        session_token: "saved-session-token",
        email: "bob@new.example",
        created_at: "2026-07-01T00:00:00.000Z",
      },
    });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    const text = said(run.err.data);
    expect(text).toContain("Signed in as bob@new.example.");
    expect(text).not.toContain("switching");
    expect(text).not.toContain("already saved on this machine");
  });

  it("still says a stored sign-in was replaced when it cannot prove the accounts match", async () => {
    // Sameness is proved, never assumed: an entry saved before emails were
    // recorded must not buy silence about being logged out.
    const run = handoffRun({
      stored: { session_token: "saved-session-token", created_at: "2026-07-01T00:00:00.000Z" },
    });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(said(run.err.data)).toContain(
      "Signed in as bob@new.example; the sign-in code from the browser replaced the TraceRoot sign-in already saved on this machine.",
    );
  });

  it("redeems against the auth host, not the API host, when the two differ", async () => {
    const split: ResolvedAuth = {
      credential: { kind: "none", value: undefined, source: "none" },
      hostUrl: { value: "http://localhost:8000", source: "flag" },
      authHost: { value: "http://localhost:3000", source: "flag" },
      projectId: { value: undefined, source: "none" },
    };
    const run = handoffRun({ auth: split });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.redeemed).toEqual([{ authHost: "http://localhost:3000", code: CODE }]);
    // The credential remembers the split, exactly as the browser path's does.
    expect(run.written[0]?.auth_host).toBe("http://localhost:3000");
  });

  it("beats a stale API key left in this directory's .env, and says it did", async () => {
    // The failure this feature exists to remove. `setup` writes
    // `TRACEROOT_API_KEY` into the working directory's `.env` when it succeeds,
    // and the hand-back step tells the user to run it where the application
    // lives — so the likeliest place to paste a handoff command already holds
    // a key, very possibly for a different account.
    const run = handoffRun({ auth: ambientKey("auto-env-file") });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    // The key was never even verified, let alone used…
    expect(run.keysUsed).not.toContain("tr-stale-ambient-key");
    // …the code was redeemed, and the run authenticated as its account.
    expect(run.redeemed).toEqual([{ authHost: "https://api.example.test", code: CODE }]);
    expect(run.minted).toEqual(["handoff-session-token"]);
    expect(run.written.map((e) => e.email)).toEqual(["bob@new.example"]);
    const text = said(run.err.data);
    expect(text).toContain(
      "A TraceRoot API key is configured in this directory's .env; the sign-in code from the browser takes precedence.",
    );
    expect(text).toContain("Signed in as bob@new.example.");
  });

  it("beats an API key left in the config file, and names that file instead", async () => {
    const run = handoffRun({ auth: ambientKey("config") });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.keysUsed).not.toContain("tr-stale-ambient-key");
    expect(run.minted).toEqual(["handoff-session-token"]);
    expect(said(run.err.data)).toContain(
      "A TraceRoot API key is configured in your TraceRoot config file; the sign-in code from the browser takes precedence.",
    );
  });

  it("names the credentials file when the ambient key came from there", async () => {
    // `resolveAuth` reclassifies a `tr_`-shaped value in the session store as
    // an API key and keeps the source, so this is reachable — and the config
    // file it used to name is not where the key is.
    const run = handoffRun({ auth: ambientKey("credentials-file") });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.keysUsed).not.toContain("tr-stale-ambient-key");
    expect(said(run.err.data)).toContain(
      "A TraceRoot API key is configured in your TraceRoot credentials file; the sign-in code from the browser takes precedence.",
    );
  });

  it("loses to an API key the user named on this command line", async () => {
    // Ambient state must not defeat an explicit flag; one explicit instruction
    // beating another is a different thing, and the user gets to mean it.
    for (const source of ["flag", "env", "env-file"] as const) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const run = handoffRun({ auth: explicitKey(source) });
      const result = await runSetupMachine(run.ctx, run.deps);

      expect(result.ok, `${source} key signs the run in`).toBe(true);
      expect(run.keysUsed, `${source} key is the credential used`).toContain("tr-explicit-key");
      expect(run.redeemed, `${source} key leaves the code unspent`).toEqual([]);
      expect(said(run.err.data), `${source} key says nothing about precedence`).not.toContain(
        "takes precedence",
      );
    }
  });

  it("falls back to the handoff when an explicit key is rejected", async () => {
    // `whoami` is the configured-key path's own check, and this is it failing.
    const run = handoffRun({ auth: explicitKey("flag"), rejectKey: true });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.redeemed).toHaveLength(1);
    expect(run.minted).toEqual(["handoff-session-token"]);
  });

  it("uses the ambient key after all when the code turns out to be spent", async () => {
    // "As if the flag had not been passed": the code had its turn, announced
    // itself dead, and the ordinary ladder resumes from the top.
    const run = handoffRun({
      auth: ambientKey("auto-env-file"),
      redeem: async () => ({ kind: "rejected" }),
    });
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.deviceFlows()).toBe(0);
    expect(run.keysUsed).toContain("tr-stale-ambient-key");
    const text = said(run.err.data);
    expect(text).toContain("takes precedence");
    expect(text).toContain("the sign-in code from the browser is no longer valid");
    expect(text).toContain("Signed in with the TraceRoot credential already configured.");
  });

  it("redeems the code before any coding agent could read it", async () => {
    // A handoff code is live until it is redeemed, and `instrument` hands a
    // coding agent a shell in the user's repository — one that can read shell
    // history and run `ps`. That the code is already spent by then is a
    // property of stage ORDER, which a later reshuffle could quietly break.
    //
    // Asserted against a run, not between two constants: the order says when
    // the redemption happens and nothing about whether the code itself reached
    // the agent's process, which is the leak the order exists to prevent. So
    // the run is made and the launch is read — its environment, its arguments
    // and its stdin.
    const run = handoffRun();
    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    const order = SETUP_PIPELINE.map((definition) => definition.stage);
    expect(order).toEqual([...SETUP_STAGES]);
    expect(order.indexOf("authenticate")).toBeLessThan(order.indexOf("instrument"));
    // Spent, once, before any of that.
    expect(run.redeemed).toEqual([{ authHost: "https://api.example.test", code: CODE }]);

    // An agent really did launch, so what follows is about a process that
    // exists rather than an empty list quietly satisfying every assertion.
    const launches = run.launched.filter((launch) => launch.program === "claude");
    expect(launches).toHaveLength(1);
    for (const launch of launches) {
      expect(JSON.stringify(launch.env)).not.toContain(CODE);
      expect(launch.args.join(" ")).not.toContain(CODE);
      expect(launch.stdin ?? "").not.toContain(CODE);
    }
  });

  it("says once which repository hosts it set aside, before anything is sent", async () => {
    const line =
      "ignored TRACEROOT_HOST_URL in ./.env for --handoff; the hand-back command names its deployment with --host";
    const occurrences = (text: string) => text.split(line).length - 1;

    // A refused code climbs every rung — the code, then the device flow — and
    // the line still appears once, ahead of the first of them.
    const refused = handoffRun({ redeem: async () => ({ kind: "rejected" }) });
    refused.deps.hostsSetAside = line;
    expect((await runSetupMachine(refused.ctx, refused.deps)).ok).toBe(true);
    const text = said(refused.err.data);
    expect(occurrences(text)).toBe(1);
    expect(text.indexOf(line)).toBeLessThan(text.indexOf("is no longer valid"));
    expect(refused.deviceFlows()).toBe(1);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const quiet = handoffRun();
    expect((await runSetupMachine(quiet.ctx, quiet.deps)).ok).toBe(true);
    expect(said(quiet.err.data)).not.toContain("for --handoff");
  });

  it("stores the session under the host the code was redeemed at", async () => {
    // Across the seam: the hosts `setupContext` settles are the ones the
    // redemption, the stored entry and every later mint use.
    const REPO = "https://repo-chosen.example.test";
    const SELF = "https://traceroot.self.example.test";
    const hermetic = {
      env: {},
      readConfig: () => null,
      loadEnvFile: () => ({}),
      readCredential: () => null,
      configIsLocal: true,
    };
    const cases: Array<{
      flags: { host?: string };
      autoEnv: Record<string, string>;
      host: string;
    }> = [
      { flags: {}, autoEnv: { TRACEROOT_HOST_URL: REPO }, host: DEFAULT_HOST },
      { flags: { host: SELF }, autoEnv: { TRACEROOT_AUTH_URL: REPO }, host: SELF },
    ];
    for (const { flags, autoEnv, host } of cases) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const { context } = setupContext(
        { ...flags, handoff: CODE },
        { ...hermetic, loadAutoEnvFile: () => autoEnv },
      );
      const run = handoffRun({ auth: context.auth });
      expect((await runSetupMachine(run.ctx, run.deps)).ok, host).toBe(true);

      expect(run.redeemed, host).toEqual([{ authHost: host, code: CODE }]);
      expect(run.writtenTo, host).toEqual([host]);
      // No `auth_host`: the session belongs wholly to that one deployment.
      expect(run.written[0]?.auth_host, host).toBeUndefined();
      expect(new Set(run.mintedAt), host).toEqual(new Set([host]));
    }
  });
});

describe("the pasted key", () => {
  /**
   * Runs the paste path and records every key the run put somewhere: the one
   * handed to the API client, and the one saved to config. Both must be the
   * bare key, whatever wrapper the user pasted.
   */
  function pastePath(pasted: string): {
    deps: SetupDeps;
    sentToClient: string[];
    savedToConfig: string[];
  } {
    const sentToClient: string[] = [];
    const savedToConfig: string[] = [];
    const base = makeDeps({
      auth: authEmpty(),
      hiddenAnswers: [pasted],
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      onWriteConfig: (config) => savedToConfig.push(config.api_key),
    });
    const deps: SetupDeps = {
      ...base,
      createClient: (options) => {
        if (options.auth.kind === "api-key") {
          sentToClient.push(options.auth.key);
        }
        return base.createClient(options);
      },
    };
    return { deps, sentToClient, savedToConfig };
  }

  // The string the interface hands the user to copy is the assignment form, and
  // the prompt whose whole purpose is taking that paste was the one place in the
  // CLI that did not tolerate it: the wrapper reached the server, which answered
  // `Invalid API key` for a key that authenticates perfectly when sent bare.
  const KEY = "tr-27332255-pasted-key";
  const wrappers: [label: string, pasted: string][] = [
    ["bare", KEY],
    ["the assignment form", `TRACEROOT_API_KEY=${KEY}`],
    ["double-quoted", `TRACEROOT_API_KEY="${KEY}"`],
    ["single-quoted", `TRACEROOT_API_KEY='${KEY}'`],
    ["export-prefixed", `export TRACEROOT_API_KEY="${KEY}"`],
    ["surrounded by whitespace", `  ${KEY}  `],
  ];

  for (const [label, pasted] of wrappers) {
    it(`sends the bare key when it is pasted ${label}`, async () => {
      pythonRepo();
      const { deps, sentToClient, savedToConfig } = pastePath(pasted);
      const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });

      const result = await runSetupMachine(ctx, deps);

      expect(result.error).toBeNull();
      // Every client the run built, not just the first: the wrapper must not
      // survive into the config either, or the next command reads it back.
      expect(sentToClient).not.toHaveLength(0);
      expect(new Set(sentToClient)).toEqual(new Set([KEY]));
      expect(savedToConfig).toEqual([KEY]);
    });
  }

  it("saves the pasted key's project with it, over the one the config named", async () => {
    pythonRepo();
    const written: unknown[] = [];
    const deps = makeDeps({
      auth: authEmpty(),
      hiddenAnswers: [KEY],
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      config: { project_id: "p_other" },
      onWriteConfig: (config) => written.push(config),
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(written).toEqual([
      { project_id: "p_1", api_key: KEY, host_url: "https://api.example.test" },
    ]);
  });

  it("treats a paste that is nothing but the variable name as empty", async () => {
    // Normalising before the empty check is what keeps this a local error
    // rather than a `401` from the server.
    pythonRepo();
    const { deps, sentToClient } = pastePath("TRACEROOT_API_KEY=");
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("NOT_AUTHENTICATED");
    expect(result.error?.message).toContain("No API key was entered.");
    expect(sentToClient).toEqual([]);
  });
});

describe("the project picker's rows", () => {
  it("tells two projects of the same name apart by their workspaces", () => {
    // A project name is unique only inside its workspace, and every sign-in
    // path lists projects across all of them, so this is the ordinary case
    // rather than an edge one. Labelled with the name alone these two rows were
    // one choice as far as the reader could see.
    const options = projectOptions([
      { project_id: "p_1", project_name: "test", workspace_id: "w_1", workspace_name: "Acme" },
      { project_id: "p_2", project_name: "test", workspace_id: "w_2", workspace_name: "Globex" },
    ]);

    // Nothing about what is being chosen changes: the label is still the
    // project name and the value still the project id.
    expect(options.map((o) => o.label)).toEqual(["test", "test"]);
    expect(options.map((o) => o.value)).toEqual(["p_1", "p_2"]);
    // What the reader has to go on differs, and names the owning workspace.
    expect(options[0]?.hint).toContain("Acme");
    expect(options[1]?.hint).toContain("Globex");
    expect(options[0]?.hint).not.toBe(options[1]?.hint);
    // An empty hint would satisfy the line above and distinguish nothing.
    expect(options[0]?.hint).toBeTruthy();
    expect(options[1]?.hint).toBeTruthy();
  });

  it("tells them apart when the two workspaces are named the same as well", () => {
    // Nothing refuses a second workspace with an existing name, and the
    // dashboard's default name for a new one comes from the owner's email
    // domain — so two people onboarding from one company each get a workspace
    // called the same thing, and anyone invited to both reads that name twice.
    // The workspace name alone therefore does not separate these rows.
    const options = projectOptions([
      { project_id: "p_1", project_name: "test", workspace_id: "w_1", workspace_name: "Acme" },
      { project_id: "p_2", project_name: "test", workspace_id: "w_2", workspace_name: "Acme" },
    ]);

    expect(options[0]?.hint).not.toBe(options[1]?.hint);
    expect(options[0]?.hint).toContain("w_1");
    expect(options[1]?.hint).toContain("w_2");
  });

  it("names the workspace by its id when the payload carries no name for it", () => {
    // A type obligation rather than a deployment anyone runs: one old enough to
    // omit the name is old enough to 404 the route. What matters is that the
    // hint still identifies a workspace instead of going blank.
    const [option] = projectOptions([
      { project_id: "p_1", project_name: "test", workspace_id: "w_1", workspace_name: null },
    ]);

    expect(option?.hint).toBe("w_1");
  });

  it("is what the project question is actually built from", async () => {
    // The rows above are only worth anything if the prompt uses them, so this
    // reaches the real question through a sign-in and reads what it was handed.
    pythonRepo();
    const setupApi = fakeSetupApi({
      listProjects: async () => [
        { project_id: "p_1", project_name: "test", workspace_id: "w_1", workspace_name: "Acme" },
        { project_id: "p_2", project_name: "test", workspace_id: "w_2", workspace_name: "Globex" },
      ],
      createProjectApiKey: async (input) => ({
        id: "ak_1",
        name: input.name,
        hint: "tr-4444-5555",
        project_id: input.projectId,
        scope: input.scope ?? "admin",
        expires_at: null,
        key: "tr-browser-minted-key-1234",
      }),
    });
    const base = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      // The second `test`, which is unreachable without something telling the
      // two apart.
      answers: ["p_2"],
    });
    const asked: Array<Parameters<typeof base.select>[0]> = [];
    const deps = {
      ...base,
      select: (input: Parameters<typeof base.select>[0]) => {
        asked.push(input);
        return base.select(input);
      },
    };
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    const question = asked.find((input) => input.message.includes("Which project"));
    expect(question?.options.map((o) => `${o.label} — ${o.hint}`)).toEqual([
      "test — Acme (w_1)",
      "test — Globex (w_2)",
    ]);
    expect(result.ok).toBe(true);
    expect(ctx.project?.projectId).toBe("p_2");
  });
});

describe("the TraceRoot demo workspace", () => {
  // Every account joins the public demo as a viewer, and the server lists it
  // alongside the account's own workspaces. Its project is named to sort first,
  // so a picker that offered it would open on it.
  const OWN: ProjectSummary = {
    project_id: "p_own",
    project_name: "web",
    workspace_id: "w_own",
    workspace_name: "Acme",
  };
  const WORKER: ProjectSummary = {
    project_id: "p_worker",
    project_name: "worker",
    workspace_id: "w_own",
    workspace_name: "Acme",
  };
  const DEMO: ProjectSummary = {
    project_id: "p_demo",
    project_name: "agent-demo",
    workspace_id: "w_demo",
    workspace_name: "TraceRoot Demo",
    workspace_is_demo: true,
  };
  const OWN_WORKSPACE: WorkspaceSummary = { id: "w_own", name: "Acme", role: "admin" };
  const DEMO_WORKSPACE: WorkspaceSummary = {
    id: "w_demo",
    name: "TraceRoot Demo",
    role: "viewer",
    is_demo: true,
  };

  /** One `traceroot setup` on a saved sign-in, recording what it asked and created. */
  function demoRun(options: {
    projects: readonly ProjectSummary[];
    workspaces?: readonly WorkspaceSummary[];
    canPrompt?: boolean;
    flags?: Partial<SetupFlags>;
    answers?: string[];
  }) {
    const asked: Parameters<SetupDeps["select"]>[0][] = [];
    const calls: string[] = [];
    const base = makeDeps({
      auth: authEmpty(),
      setupApi: fakeSetupApi({
        listProjects: async () => options.projects.map((p) => ({ ...p })),
        listWorkspaces: async () => (options.workspaces ?? []).map((w) => ({ ...w })),
        createProject: async (name, workspaceId) => {
          calls.push(`create ${workspaceId}`);
          return { project_id: "p_new", project_name: name, workspace_id: workspaceId ?? "" };
        },
        createProjectApiKey: async (input) => {
          calls.push(`mint ${input.projectId}`);
          return {
            id: `ak_${calls.length}`,
            name: input.name,
            hint: "tr-4444-5555",
            project_id: input.projectId,
            scope: input.scope ?? "admin",
            expires_at: null,
            key: `tr-${input.scope}-${input.projectId}`,
          };
        },
      }),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      answers: options.answers ?? [],
      storedCredential: { session_token: "saved-session-token" },
    });
    const deps: SetupDeps = {
      ...base,
      select: (input) => {
        asked.push(input);
        return base.select(input);
      },
    };
    const harness = makeCtx({
      canPrompt: options.canPrompt ?? true,
      flags: { agent: "claude", ...options.flags },
    });
    return { ...harness, deps, asked, calls };
  }

  const projectQuestion = (asked: Parameters<SetupDeps["select"]>[0][]) =>
    asked.find((input) => input.message.includes("Which project"));
  const minted = (calls: string[]) => calls.filter((call) => call.startsWith("mint "));

  it("takes the account's own project without asking when the other one is the demo's", async () => {
    pythonRepo();
    const run = demoRun({ projects: [OWN, DEMO] });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(projectQuestion(run.asked)).toBeUndefined();
    expect(run.ctx.project?.projectId).toBe("p_own");
    expect(minted(run.calls).length).toBeGreaterThan(0);
    expect(minted(run.calls).every((call) => call === "mint p_own")).toBe(true);
  });

  it("takes it with nobody to ask, as an agent or CI run did before the demo", async () => {
    pythonRepo();
    const run = demoRun({ projects: [DEMO, OWN], canPrompt: false });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.ctx.project?.projectId).toBe("p_own");
  });

  it("says so when the account is only in the demo, before any key is minted", async () => {
    // The demo's project used to be taken as the account's only one, and the
    // key mint behind it answered 403.
    pythonRepo();
    const run = demoRun({ projects: [DEMO], workspaces: [DEMO_WORKSPACE] });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.message).toContain(
      "This account is only in the TraceRoot demo workspace, which is view-only.",
    );
    expect(result.error?.remedy).toContain("Create a workspace and project");
    expect(projectQuestion(run.asked)).toBeUndefined();
    expect(run.calls).toEqual([]);
  });

  it("says so with nobody to ask as well, rather than to rerun interactively", async () => {
    pythonRepo();
    const run = demoRun({ projects: [DEMO], workspaces: [DEMO_WORKSPACE], canPrompt: false });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(false);
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.AMBIGUOUS);
    expect(result.error?.message).toContain(
      "This account is only in the TraceRoot demo workspace, which is view-only.",
    );
    expect(run.calls).toEqual([]);
  });

  it("still sends an account with an empty workspace of its own to create a project", async () => {
    pythonRepo();
    const run = demoRun({
      projects: [DEMO],
      workspaces: [DEMO_WORKSPACE, OWN_WORKSPACE],
      canPrompt: false,
    });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.message).toContain("no projects yet");
    expect(run.calls).toEqual([]);
  });

  it("creates the first project in the account's own workspace, not the demo", async () => {
    // A demo admin, as on our own team: the role alone would offer the demo as
    // somewhere to create a project.
    pythonRepo();
    const run = demoRun({
      projects: [DEMO],
      workspaces: [{ ...DEMO_WORKSPACE, role: "admin" }, OWN_WORKSPACE],
      // Only the project name: leaving the demo out leaves one workspace.
      answers: [""],
    });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.asked.find((input) => input.message.includes("Which workspace"))).toBeUndefined();
    expect(run.calls[0]).toBe("create w_own");
    expect(run.ctx.project?.projectId).toBe("p_new");
  });

  it("honours --project naming the demo's project by its id", async () => {
    pythonRepo();
    const run = demoRun({
      projects: [OWN, DEMO],
      canPrompt: false,
      flags: { project: "p_demo" },
    });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(run.ctx.project?.projectId).toBe("p_demo");
    expect(minted(run.calls).every((call) => call === "mint p_demo")).toBe(true);
  });

  it("does not resolve a --project name to the demo's project", async () => {
    pythonRepo();
    const run = demoRun({
      projects: [OWN, WORKER, DEMO],
      canPrompt: false,
      flags: { project: "agent-demo" },
    });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.remedy).toBe("Available projects: web, worker");
    expect(run.calls).toEqual([]);
  });

  it("offers only the account's own projects", async () => {
    pythonRepo();
    const run = demoRun({ projects: [DEMO, OWN, WORKER], answers: ["p_worker"] });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.ok).toBe(true);
    expect(projectQuestion(run.asked)?.options.map((o) => o.value)).toEqual(["p_own", "p_worker"]);
    expect(run.ctx.project?.projectId).toBe("p_worker");
  });

  it("counts and names only the account's own projects when it cannot ask", async () => {
    pythonRepo();
    const run = demoRun({ projects: [DEMO, OWN, WORKER], canPrompt: false });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.message).toContain("has 2 projects");
    expect(result.error?.remedy).toContain("--project p_own");
    expect(result.error?.remedy).not.toContain("agent-demo");
    expect(result.error?.remedy).not.toContain("p_demo");
    expect(run.calls).toEqual([]);
  });

  it("names the project by its id in a remedy that reruns setup", async () => {
    // A name is free text: `--project My App` reached setup as two operands, a
    // usage error, and a name can belong to projects in two workspaces.
    pythonRepo();
    const run = demoRun({
      projects: [{ ...OWN, project_name: "My App" }, WORKER],
      canPrompt: false,
    });

    const result = await runSetupMachine(run.ctx, run.deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.remedy).toBe(
      "Choose one by its id with --project, for example 'My App' in Acme (w_own):\n  traceroot setup --project p_own",
    );
  });
});

describe("a repository that already reports to a project", () => {
  // Two projects named `test` in two workspaces: the ordinary shape of an
  // account that belongs to more than one workspace, and the one the report
  // came from.
  const ALPHA = {
    project_id: "p_a",
    project_name: "alpha",
    workspace_id: "w_1",
    workspace_name: "Acme",
  };
  const TEST_ACME = {
    project_id: "p_t1",
    project_name: "test",
    workspace_id: "w_1",
    workspace_name: "Acme",
  };
  const TEST_GLOBEX = {
    project_id: "p_t2",
    project_name: "test",
    workspace_id: "w_2",
    workspace_name: "Globex",
  };
  /** A project in a workspace this account is not in, as a colleague's key's would be. */
  const ELSEWHERE = {
    project_id: "p_x",
    project_name: "other",
    workspace_id: "w_9",
    workspace_name: "Initech",
  };
  type Project = typeof ALPHA;
  const PROJECTS: readonly Project[] = [ALPHA, TEST_ACME, TEST_GLOBEX, ELSEWHERE];

  /**
   * The server's side of one or more runs: which project each key belongs to.
   *
   * Shared across runs, because the defect is about what one run leaves for the
   * next — the key the first run mints is what the second finds in the env file
   * and asks `whoami` about.
   */
  function server(...seeded: [key: string, project: Project][]) {
    const owner = new Map<string, Project>(seeded);
    /** Keys whose `whoami` fails in transit rather than being refused. */
    const unreachable = new Set<string>();
    /**
     * Keys the server refuses, with its `detail`, and keys whose request never
     * arrives — each thrown in the shape the real `whoami` client throws it.
     */
    const refused = new Map<string, string>();
    const offline = new Set<string>();
    /** What `whoami` reports as each key's scope; nothing, like an older server, unless set. */
    const scopes = new Map<string, "ingest" | "admin">();
    /** Key names already used in a project, as `<project id> <name>`. */
    const taken = new Set<string>();
    /** Opt-in, so the tests above see the server they were written against. */
    const settings = { reportScopes: false, enforceNames: false };
    /** Every name a mint asked for, granted or not. */
    const asked: string[] = [];
    let minted = 0;
    return {
      owner,
      unreachable,
      refused,
      offline,
      scopes,
      taken,
      settings,
      asked,
      mint(projectId: string, name: string, scope: "ingest" | "admin" | undefined) {
        asked.push(name);
        if (settings.enforceNames && taken.has(`${projectId} ${name}`)) {
          throw new SetupApiError(`An API key named '${name}' already exists in this project`, 409);
        }
        taken.add(`${projectId} ${name}`);
        minted += 1;
        const key = `tr-${scope}-${projectId}-${minted}`;
        const project = PROJECTS.find((p) => p.project_id === projectId);
        if (project !== undefined) {
          owner.set(key, project);
        }
        if (settings.reportScopes && scope !== undefined) {
          scopes.set(key, scope);
        }
        return {
          id: `ak_${minted}`,
          name,
          hint: `tr-hint-${minted}`,
          project_id: projectId,
          scope: scope ?? "ingest",
          expires_at: null,
          key,
        };
      },
      /** The project the key now in the repository's `.env` belongs to. */
      reportsTo(): string | undefined {
        const path = join(dir, ".env");
        if (!existsSync(path)) {
          return undefined;
        }
        const key = /^TRACEROOT_API_KEY=(.*)$/m.exec(readFileSync(path, "utf8"))?.[1];
        return key === undefined ? undefined : owner.get(key)?.project_id;
      },
    };
  }

  /** One `traceroot setup` on a saved sign-in, recording what it asked and called. */
  function setupRun(
    world: ReturnType<typeof server>,
    options: {
      listed: readonly Project[];
      answers?: string[];
      canPrompt?: boolean;
      flags?: Partial<SetupFlags>;
      /** A credential that outranks the saved sign-in: a key session. */
      auth?: ResolvedAuth;
      /** The CLI's config as an earlier run left it. */
      config?: { api_key: string; host_url: string };
      resumeFrom?: ReturnType<typeof newCheckpoint>;
      /** Called where the run fails, after the env file was written. */
      failAtInstrument?: () => void;
      /**
       * The CLI's config as a file, read and put back byte for byte, with every
       * text put back recorded. Without it, the config has no file behind it.
       */
      configFile?: { text: string | null; restored: (string | null)[] };
      /** The user route's answer to a revoke: done, or this error. None at all unless set. */
      revoke?: "ok" | Error;
    },
  ) {
    const asked: Parameters<SetupDeps["select"]>[0][] = [];
    const calls: string[] = [];
    const configured: string[] = [];
    const file = options.configFile;
    const base = makeDeps({
      auth: options.auth ?? authEmpty(),
      setupApi: fakeSetupApi({
        listProjects: async () => {
          calls.push("listProjects");
          return options.listed.map((p) => ({ ...p }));
        },
        createProjectApiKey: async (input) => {
          calls.push(`mint ${input.scope} ${input.projectId}`);
          return world.mint(input.projectId, input.name, input.scope);
        },
        ...(options.revoke === undefined
          ? {}
          : {
              revokeProjectApiKey: async (projectId: string, id: string) => {
                calls.push(`revoke ${projectId} ${id}`);
                if (options.revoke instanceof Error) {
                  throw options.revoke;
                }
              },
            }),
      }),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      answers: options.answers ?? [],
      storedCredential: { session_token: "saved-session-token" },
      onWriteConfig: (config) => configured.push(config.api_key),
      config: options.config,
    });
    const deps: SetupDeps = {
      ...base,
      ...(file === undefined
        ? {}
        : {
            writeConfig: (config: { api_key: string; host_url: string }) => {
              configured.push(config.api_key);
              // As `config/manager.ts` writes it.
              file.text = `${JSON.stringify(config, null, 2)}\n`;
              return join(dir, ".traceroot", "config.json");
            },
            readConfig: () => (file.text === null ? null : JSON.parse(file.text)),
            readConfigText: () => file.text,
            restoreConfigText: (text: string | null) => {
              file.restored.push(text);
              file.text = text;
            },
          }),
      // The key-authenticated mint answers for the project of the key calling it,
      // as the server's does.
      createSetupApi: (opts) => ({
        ...base.createSetupApi(opts),
        listApiKeys: async () => [],
        createApiKey: async (input) => {
          const projectId = world.owner.get(opts.apiKey ?? "")?.project_id ?? "";
          calls.push(`mint by key ${input.scope} ${projectId}`);
          return world.mint(projectId, input.name, input.scope);
        },
      }),
      ...(options.failAtInstrument === undefined
        ? {}
        : {
            resolveSdk: async () => {
              options.failAtInstrument?.();
              throw new Error("the registry refused the request");
            },
          }),
      // `whoami` answers for the key it is asked about, as the real one does:
      // with the project that key was minted into.
      createClient: (opts) => {
        const key = opts.auth.kind === "api-key" ? opts.auth.key : "";
        calls.push(`whoami ${key}`);
        return fakeApiClient({
          whoamiResult: async () => {
            // The real client's two shapes: the server's `detail` with the auth
            // exit code for a refusal, and the network code for a request that
            // never arrived (`api/client.ts` `failFor` and `rawGet`).
            const detail = world.refused.get(key);
            if (detail !== undefined) {
              throw new CliError(detail, ExitCode.auth);
            }
            if (world.offline.has(key)) {
              throw new CliError(`request to ${opts.host} failed: fetch failed`, ExitCode.network);
            }
            if (world.unreachable.has(key)) {
              throw new SetupApiError("fetch failed", 0);
            }
            const project = world.owner.get(key);
            if (project === undefined) {
              throw new SetupApiError("Invalid API key", 401);
            }
            const scope = world.scopes.get(key);
            return whoami({ ...project, ...(scope === undefined ? {} : { key_scope: scope }) });
          },
        });
      },
      select: (input) => {
        asked.push(input);
        return base.select(input);
      },
    };
    const harness = makeCtx({
      canPrompt: options.canPrompt ?? true,
      flags: { agent: "claude", ...options.flags },
      resumeFrom: options.resumeFrom,
    });
    return { ...harness, deps, asked, calls, configured };
  }

  const projectQuestion = (asked: Parameters<SetupDeps["select"]>[0][]) =>
    asked.find((input) => input.message.includes("Which project"));

  it("leaves a first run exactly as it was", async () => {
    // Nothing changes until the repository already holds a key: no `whoami` on
    // an env file that is not there, no starting row, no second question.
    pythonRepo();
    const world = server();
    const first = setupRun(world, { listed: [ALPHA, TEST_ACME, TEST_GLOBEX], answers: ["3"] });

    const result = await runSetupMachine(first.ctx, first.deps);

    expect(result.ok).toBe(true);
    const atSignIn = first.asked.filter((input) => input.stage === "authenticate");
    expect(atSignIn).toEqual([
      {
        stage: "authenticate",
        message: "Which project should receive these traces?",
        options: [
          { value: "p_a", label: "alpha", hint: "Acme (w_1)" },
          { value: "p_t1", label: "test", hint: "Acme (w_1)" },
          { value: "p_t2", label: "test", hint: "Globex (w_2)" },
        ],
      },
    ]);
    expect(atSignIn[0]).not.toHaveProperty("initialValue");
    // The same calls in the same order. The one `whoami` verifies the CLI's
    // own freshly minted key; no key was read out of an env file.
    expect(first.calls).toEqual([
      "listProjects",
      "mint admin p_t2",
      "mint ingest p_t2",
      "whoami tr-admin-p_t2-1",
    ]);
    expect(first.configured).toEqual(["tr-admin-p_t2-1"]);
    expect(world.reportsTo()).toBe("p_t2");
    const said = plain(first.err.data);
    expect(said).toContain("Project test.");
    expect(said).not.toContain("already reports to");
    expect(said).not.toContain("Switch");
  });

  it("keeps three runs in one repository on one project", async () => {
    // The report: three identical runs, three projects. The server orders the
    // projects inside a workspace by nothing, so each run gets them in another
    // order — and after the first pick, each run accepts the question as asked.
    pythonRepo();
    const world = server();
    const runs: [listed: Project[], answers: string[]][] = [
      [[TEST_GLOBEX, ALPHA, TEST_ACME], ["p_t2"]],
      [[TEST_ACME, TEST_GLOBEX, ALPHA], [""]],
      [[ALPHA, TEST_ACME, TEST_GLOBEX], [""]],
    ];
    const landed: (string | undefined)[] = [];
    const startedOn: (string | undefined)[] = [];

    for (const [listed, answers] of runs) {
      const each = setupRun(world, { listed, answers });
      const result = await runSetupMachine(each.ctx, each.deps);
      expect(result.error).toBeNull();
      startedOn.push(projectQuestion(each.asked)?.initialValue);
      landed.push(world.reportsTo());
    }

    expect(landed).toEqual(["p_t2", "p_t2", "p_t2"]);
    // Each rerun opened on the project the repository already reports to.
    expect(startedOn).toEqual([undefined, "p_t2", "p_t2"]);
  });

  it("gives the same answer the same project whatever order the server lists them in", async () => {
    pythonRepo();
    const rows: string[][] = [];
    const picked: (string | undefined)[] = [];

    for (const listed of [
      [TEST_GLOBEX, ALPHA, TEST_ACME],
      [TEST_ACME, TEST_GLOBEX, ALPHA],
    ]) {
      rmSync(join(dir, ".env"), { force: true });
      const each = setupRun(server(), { listed, answers: ["3"] });
      const result = await runSetupMachine(each.ctx, each.deps);
      expect(result.error).toBeNull();
      rows.push(projectQuestion(each.asked)?.options.map((o) => o.value) ?? []);
      picked.push(each.ctx.project?.projectId);
    }

    // By name, then id: the two `test`s keep their places relative to each other.
    expect(rows).toEqual([
      ["p_a", "p_t1", "p_t2"],
      ["p_a", "p_t1", "p_t2"],
    ]);
    expect(picked).toEqual(["p_t2", "p_t2"]);
  });

  it("starts a rerun that cannot ask on the project the repository reports to, and says so", async () => {
    // Before, a run with several projects and nobody to ask refused outright —
    // with the answer already on disk.
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-previous-key\n");
    const world = server(["tr-previous-key", TEST_GLOBEX]);
    const each = setupRun(world, { listed: [ALPHA, TEST_ACME, TEST_GLOBEX], canPrompt: false });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(each.ctx.project?.projectId).toBe("p_t2");
    expect(world.reportsTo()).toBe("p_t2");
    expect(plain(each.err.data)).toContain(
      "Using project 'test' in Globex (w_2), which this repository already reports to.",
    );
  });

  it("asks before moving the repository to another project, naming both", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-previous-key\n");
    const world = server(["tr-previous-key", TEST_GLOBEX]);
    // The other `test`: the mis-pick that identical labels made undetectable.
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      answers: ["p_t1", "yes"],
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    const question = each.asked.find((input) => input.message.includes("Switch it to"));
    const message = plain(question?.message ?? "");
    expect(message).toContain("'test' in Globex (w_2)");
    expect(message).toContain("'test' in Acme (w_1)");
    // Staying is the default; moving is the answer that has to be given.
    expect(question?.initialValue).toBe("no");
    expect(world.reportsTo()).toBe("p_t1");
  });

  it("leaves the repository where it was when the move is declined", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-previous-key\n");
    const world = server(["tr-previous-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      answers: ["p_t1", ""],
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("CANCELLED");
    expect(each.calls.filter((call) => call.startsWith("mint"))).toEqual([]);
    expect(each.configured).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TRACEROOT_API_KEY=tr-previous-key\n");
  });

  it("stops a run that cannot ask before it gives the repository another project's key", async () => {
    // A key for a project this account cannot reach, and one project it can:
    // the run takes that one without asking, which is a move nobody chose. It
    // has to stop before anything is minted or written.
    pythonRepo();
    const before = "# the project's own\nTRACEROOT_API_KEY=tr-colleague-key\nDEBUG=1\n";
    writeFileSync(join(dir, ".env"), before);
    const world = server(["tr-colleague-key", ELSEWHERE]);
    const each = setupRun(world, { listed: [ALPHA], canPrompt: false });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.UNSAFE_OVERWRITE);
    expect(result.error?.message).toContain("'other' in Initech (w_9)");
    expect(result.error?.message).toContain("'alpha' in Acme (w_1)");
    expect(result.error?.remedy).toContain("traceroot setup --project p_a");
    expect(each.calls.filter((call) => call.startsWith("mint"))).toEqual([]);
    expect(each.configured).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  });

  it("still moves the repository when --project names another project, and says so", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-previous-key\n");
    const world = server(["tr-previous-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      canPrompt: false,
      flags: { project: "alpha" },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(world.reportsTo()).toBe("p_a");
    expect(plain(each.err.data)).toContain(
      "this repository sent its traces to 'test' in Globex (w_2); from now on it sends them to 'alpha' in Acme (w_1), as --project asked",
    );
  });

  it("reads a --project name that several projects share as the one the repository reports to", async () => {
    // Otherwise the same `--project test` that set the repository up could
    // move it to the other `test` on the next run.
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-previous-key\n");
    const world = server(["tr-previous-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      canPrompt: false,
      flags: { project: "test" },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(world.reportsTo()).toBe("p_t2");
    expect(plain(each.err.data)).not.toContain("as --project asked");
  });

  it("refuses a --project name that several projects share when the repository reports to none of them", async () => {
    // Any one of them would be a guess, and a wrong guess sends the traces to a
    // project nobody chose.
    pythonRepo();
    const each = setupRun(server(), {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      flags: { project: "test" },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.message.split("\n")[0]).toBe("More than one project is named 'test'.");
    expect(result.error?.remedy).toBe(
      [
        "Choose one by its id with --project:",
        "  traceroot setup --project p_t1   # 'test' in Acme (w_1)",
        "  traceroot setup --project p_t2   # 'test' in Globex (w_2)",
      ].join("\n"),
    );
    expect(projectQuestion(each.asked)).toBeUndefined();
    expect(mints(each.calls)).toEqual([]);
    expect(each.configured).toEqual([]);
  });

  it("takes a --project id among namesakes without asking", async () => {
    pythonRepo();
    const world = server();
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      canPrompt: false,
      flags: { project: "p_t2" },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(world.reportsTo()).toBe("p_t2");
  });

  it("replaces a key the server no longer accepts without asking", async () => {
    // A dead key sends traces nowhere, so there is nothing to keep.
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-revoked-key\n");
    const world = server();
    const each = setupRun(world, { listed: [ALPHA, TEST_ACME], answers: ["p_t1"] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(
      each.asked.filter((input) => input.stage === "authenticate").map((input) => input.message),
    ).toEqual(["Which project should receive these traces?"]);
    expect(world.reportsTo()).toBe("p_t1");
  });

  it("stops rather than replace a key it could not check", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-unverified-key\n");
    const world = server();
    world.unreachable.add("tr-unverified-key");
    const each = setupRun(world, { listed: [ALPHA, TEST_ACME], answers: ["p_t1"] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(each.calls.filter((call) => call.startsWith("mint"))).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TRACEROOT_API_KEY=tr-unverified-key\n");
  });

  // What the server actually says about a key that has died. None of it reads
  // as a refusal to a pattern over the text, so each one used to stop a
  // logged-in rerun with "unreachable" instead of replacing the dead key.
  for (const detail of [
    "API key has expired",
    "Project has been deleted",
    "Authentication failed",
  ]) {
    it(`replaces a key the server refuses with "${detail}" without asking`, async () => {
      pythonRepo();
      writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-dead-key\n");
      const world = server();
      world.refused.set("tr-dead-key", detail);
      const each = setupRun(world, { listed: [ALPHA, TEST_ACME], answers: ["p_t1"] });

      const result = await runSetupMachine(each.ctx, each.deps);

      expect(result.error).toBeNull();
      expect(
        each.asked.filter((input) => input.stage === "authenticate").map((input) => input.message),
      ).toEqual(["Which project should receive these traces?"]);
      expect(world.reportsTo()).toBe("p_t1");
    });
  }

  it("still stops when the request to check the key never arrived", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-unverified-key\n");
    const world = server();
    world.offline.add("tr-unverified-key");
    const each = setupRun(world, { listed: [ALPHA, TEST_ACME], answers: ["p_t1"] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(result.error?.message).toContain("was unreachable");
    expect(each.calls.filter((call) => call.startsWith("mint"))).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TRACEROOT_API_KEY=tr-unverified-key\n");
  });

  it("signs in again over a configured key that has expired, rather than calling the host unreachable", async () => {
    pythonRepo();
    const world = server();
    world.refused.set("tr-expired-config-key", "API key has expired");
    const each = setupRun(world, { listed: [ALPHA] });
    const deps: SetupDeps = { ...each.deps, resolvedAuth: authWithKey("tr-expired-config-key") };

    const result = await runSetupMachine(each.ctx, deps);

    expect(result.error).toBeNull();
    expect(plain(each.err.data)).toContain(
      "the existing TraceRoot credential was rejected; signing in again",
    );
    // The saved sign-in took over from the dead key.
    expect(each.ctx.session?.via).toBe("user-credential");
  });

  it("goes back to the browser when the saved sign-in itself has expired", async () => {
    // The token provider refuses a dead session before any request goes out,
    // in its own words and with the auth exit code (`auth/token.ts`), so the
    // first call that needs a token is where it surfaces.
    pythonRepo();
    const world = server();
    const each = setupRun(world, { listed: [ALPHA], flags: { browser: true } });
    const cleared: string[] = [];
    const deps: SetupDeps = {
      ...each.deps,
      createTokenProvider: (opts) =>
        opts.sessionToken === "saved-session-token"
          ? {
              getAccessToken: async () => {
                throw new CliError(
                  "session expired or revoked — run `traceroot login` to sign in again",
                  ExitCode.auth,
                );
              },
              invalidate: () => undefined,
            }
          : each.deps.createTokenProvider(opts),
      // Asks for a token before every request, as the real setup client does.
      createSetupApi: (opts) => {
        const inner = each.deps.createSetupApi(opts);
        return {
          ...inner,
          listProjects: async (workspaceId) => {
            await opts.tokenProvider?.getAccessToken();
            return inner.listProjects(workspaceId);
          },
        };
      },
      deleteCredential: (host) => {
        cleared.push(host);
        return true;
      },
    };

    const result = await runSetupMachine(each.ctx, deps);

    expect(result.error).toBeNull();
    expect(cleared).toEqual(["https://api.example.test"]);
    expect(plain(each.err.data)).toContain(
      "the saved TraceRoot sign-in has expired; signing in again",
    );
    expect(each.ctx.session?.via).toBe("user-credential");
  });

  // ── what a rerun already has ──────────────────────────────────────────────

  const HOST = "https://api.example.test";
  const ENV_WITH_KEY = `TRACEROOT_API_KEY=tr-app-key\nTRACEROOT_HOST_URL=${HOST}\n`;
  const mints = (calls: string[]) => calls.filter((call) => call.startsWith("mint"));

  it("mints neither key on a rerun that already has both", async () => {
    // Each run minted a fresh pair, so every rerun left the last pair live and
    // recorded nowhere.
    pythonRepo();
    writeFileSync(join(dir, ".env"), ENV_WITH_KEY);
    const world = server(["tr-app-key", TEST_GLOBEX], ["tr-cli-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      config: { api_key: "tr-cli-key", host_url: HOST },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual([]);
    expect(each.configured).toEqual(["tr-cli-key"]);
    expect(each.ctx.session?.userKey.reveal()).toBe("tr-cli-key");
    expect(each.ctx.credential?.origin).toBe("reused");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_WITH_KEY);
    expect(plain(each.err.data)).toContain("Reusing the existing project API key.");
  });

  it("mints only the CLI's key when the env file still has the application's", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), ENV_WITH_KEY);
    const world = server(["tr-app-key", TEST_GLOBEX]);
    const each = setupRun(world, { listed: [ALPHA, TEST_ACME, TEST_GLOBEX] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual(["mint admin p_t2"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_WITH_KEY);
  });

  it("mints only the application's key when the config still has the CLI's", async () => {
    pythonRepo();
    const world = server(["tr-cli-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [TEST_GLOBEX],
      config: { api_key: "tr-cli-key", host_url: HOST },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual(["mint ingest p_t2"]);
    expect(each.configured).toEqual(["tr-cli-key"]);
    expect(world.reportsTo()).toBe("p_t2");
  });

  it("does not keep an application key that can manage keys", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-admin-in-env\n");
    const world = server(["tr-admin-in-env", TEST_GLOBEX]);
    world.settings.reportScopes = true;
    world.scopes.set("tr-admin-in-env", "admin");
    const each = setupRun(world, { listed: [TEST_GLOBEX] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual(["mint admin p_t2", "mint ingest p_t2"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("tr-admin-in-env");
    expect(world.reportsTo()).toBe("p_t2");
  });

  it("never sends the CLI's key to a host it was not written for", async () => {
    pythonRepo();
    const world = server(["tr-cli-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [TEST_GLOBEX],
      config: { api_key: "tr-cli-key", host_url: "https://elsewhere.example.test" },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(each.calls).not.toContain("whoami tr-cli-key");
    expect(mints(each.calls)).toEqual(["mint admin p_t2", "mint ingest p_t2"]);
  });

  it("mints a CLI key for the chosen project when the config's belongs to another", async () => {
    // Kept anyway, the config would go on holding the other project's key while
    // the repository reported to this one.
    pythonRepo();
    const world = server(["tr-acme-cli-key", TEST_ACME]);
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      answers: ["p_t2"],
      config: { api_key: "tr-acme-cli-key", host_url: HOST },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    // Asked about, so it is the project that ruled it out rather than the host.
    expect(each.calls).toContain("whoami tr-acme-cli-key");
    expect(mints(each.calls)).toEqual(["mint admin p_t2", "mint ingest p_t2"]);
    expect(each.configured).toEqual(["tr-admin-p_t2-1"]);
    expect(each.ctx.session?.userKey.reveal()).toBe("tr-admin-p_t2-1");
  });

  it("resumes on the keys the paused run left, and stops calling them orphans", async () => {
    // `--resume`, and "Leave it as it is" on a finished run, are reruns too:
    // authentication is never restored from the checkpoint.
    pythonRepo();
    writeFileSync(join(dir, ".env"), ENV_WITH_KEY);
    const paused = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    paused.completedStages.push(
      "precheck",
      "authenticate",
      "select_context",
      "acquire_project_key",
      "configure_repository",
      "detect_stack",
      "select_agent",
      "install_agent_context",
      "instrument",
    );
    paused.lastError = { stage: "verify_trace", code: "TRACE_TIMEOUT", message: "no trace" };
    paused.mintedKeys = [
      { id: "ak_cli", name: "traceroot-cli-repo", hint: "tr-hint-cli" },
      { id: "ak_app", name: "traceroot-repo", hint: "tr-hint-app" },
    ];
    writeCheckpoint(dir, paused);
    const world = server(["tr-app-key", TEST_GLOBEX], ["tr-cli-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [TEST_GLOBEX],
      flags: { resume: true },
      config: { api_key: "tr-cli-key", host_url: HOST },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual([]);
    // They are the keys in service now.
    expect(each.ctx.checkpoint.mintedKeys).toEqual([]);
  });

  it("finds a free name on the third run in a day", async () => {
    // The base name, then the date: one more name a day, so the third run had
    // nowhere left to go and failed.
    pythonRepo();
    const world = server();
    world.settings.enforceNames = true;
    for (const name of [`traceroot-cli-${basename(dir)}`, `traceroot-${basename(dir)}`]) {
      world.taken.add(`p_a ${name}`);
      world.taken.add(`p_a ${name}-2026-07-26`);
    }
    const each = setupRun(world, { listed: [ALPHA] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    const cli = `traceroot-cli-${basename(dir)}`;
    const app = `traceroot-${basename(dir)}`;
    expect(world.asked).toEqual([
      cli,
      `${cli}-2026-07-26`,
      `${cli}-2026-07-26-2`,
      app,
      `${app}-2026-07-26`,
      `${app}-2026-07-26-2`,
    ]);
  });

  it("stops looking for a free name after ten dated ones", async () => {
    pythonRepo();
    const world = server();
    world.settings.enforceNames = true;
    const base = `traceroot-cli-${basename(dir)}`;
    world.taken.add(`p_a ${base}`);
    world.taken.add(`p_a ${base}-2026-07-26`);
    for (let n = 2; n <= 10; n += 1) {
      world.taken.add(`p_a ${base}-2026-07-26-${n}`);
    }
    const each = setupRun(world, { listed: [ALPHA] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.message).toContain("already exists in this project");
    // The base name, the date, then nine counted ones.
    expect(world.asked).toHaveLength(11);
  });

  // ── a key session: the CLI's config, `--api-key` or an exported key ─────────

  const configKey = (key: string): ResolvedAuth => authWithKey(key);
  const flagKey = (key: string): ResolvedAuth => ({
    ...authWithKey(key),
    credential: { kind: "api-key", value: key, source: "flag" },
  });

  it("keeps the application's key when the CLI's own key signs in, as after `traceroot logout`", async () => {
    // `logout` leaves the config's admin key behind, and the next run signed in
    // with it and wrote it over the application's ingest key.
    pythonRepo();
    writeFileSync(join(dir, ".env"), ENV_WITH_KEY);
    const world = server(["tr-cli-key", TEST_GLOBEX], ["tr-app-key", TEST_GLOBEX]);
    world.scopes.set("tr-cli-key", "admin");
    const each = setupRun(world, { listed: [], auth: configKey("tr-cli-key"), canPrompt: false });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(each.ctx.credential?.origin).toBe("reused");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_WITH_KEY);
    expect(mints(each.calls)).toEqual([]);
  });

  it("asks before a key session moves the repository, and stays on No", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), ENV_WITH_KEY);
    const world = server(["tr-acme-key", TEST_ACME], ["tr-app-key", TEST_GLOBEX]);
    const each = setupRun(world, { listed: [], auth: configKey("tr-acme-key"), answers: [""] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("CANCELLED");
    const question = each.asked.find((input) => input.message.includes("Switch it to"));
    expect(plain(question?.message ?? "")).toContain("'test' in Globex (w_2)");
    expect(plain(question?.message ?? "")).toContain("'test' in Acme (w_1)");
    expect(question?.initialValue).toBe("no");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_WITH_KEY);
  });

  it("stops a run nobody watches before a key it did not name moves the repository", async () => {
    // A key in the CLI's config, or exported from a shell profile, was not
    // chosen by this run.
    pythonRepo();
    writeFileSync(join(dir, ".env"), ENV_WITH_KEY);
    const world = server(["tr-acme-key", TEST_ACME], ["tr-app-key", TEST_GLOBEX]);
    const each = setupRun(world, { listed: [], auth: configKey("tr-acme-key"), canPrompt: false });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(result.error?.message).toContain("'test' in Globex (w_2)");
    expect(result.error?.remedy).toContain("traceroot setup --api-key <key>");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_WITH_KEY);
  });

  it("moves it when --api-key named the key in this run, and says so", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), ENV_WITH_KEY);
    const world = server(["tr-acme-key", TEST_ACME], ["tr-app-key", TEST_GLOBEX]);
    const each = setupRun(world, { listed: [], auth: flagKey("tr-acme-key"), canPrompt: false });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(world.reportsTo()).toBe("p_t1");
    expect(plain(each.err.data)).toContain(
      "this repository sent its traces to 'test' in Globex (w_2); from now on it sends them to 'test' in Acme (w_1), as --api-key asked",
    );
  });

  it("gives the application an ingest key of its own rather than an admin key", async () => {
    pythonRepo();
    const world = server(["tr-cli-key", TEST_GLOBEX]);
    world.settings.reportScopes = true;
    world.scopes.set("tr-cli-key", "admin");
    const each = setupRun(world, { listed: [], auth: configKey("tr-cli-key"), canPrompt: false });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual(["mint by key ingest p_t2"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("tr-cli-key");
    expect(world.reportsTo()).toBe("p_t2");
    expect(each.ctx.session?.userKey.reveal()).toBe("tr-cli-key");
  });

  it("gives the application an ingest key even for an admin key passed with --api-key", async () => {
    // The application carries its key into every deployment, and none of them
    // needs to manage keys, whoever chose the key the run signed in with.
    pythonRepo();
    const world = server(["tr-handed-admin", TEST_GLOBEX]);
    world.settings.reportScopes = true;
    world.scopes.set("tr-handed-admin", "admin");
    const each = setupRun(world, {
      listed: [],
      auth: flagKey("tr-handed-admin"),
      canPrompt: false,
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual(["mint by key ingest p_t2"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("tr-handed-admin");
    expect(world.reportsTo()).toBe("p_t2");
    expect(each.ctx.session?.userKey.reveal()).toBe("tr-handed-admin");
    // What the key can do, as the backend scopes it. An ingest key reads the
    // project's data back, so it was never send-only.
    expect(plain(each.err.data)).toContain(
      "That key can manage the project's keys, so the application gets a key of its own that can send traces and read this project, but not manage its keys.",
    );
    expect(plain(each.err.data)).not.toContain("send-only");
  });

  it("does the same for an admin key pasted at the prompt", async () => {
    pythonRepo();
    const world = server(["tr-pasted-admin", TEST_GLOBEX]);
    world.scopes.set("tr-pasted-admin", "admin");
    const each = setupRun(world, { listed: [] });
    const deps: SetupDeps = {
      ...each.deps,
      readCredential: () => null,
      promptHidden: async () => "tr-pasted-admin",
    };

    const result = await runSetupMachine(each.ctx, deps);

    expect(result.error).toBeNull();
    expect(each.ctx.session?.via).toBe("pasted-key");
    expect(mints(each.calls)).toEqual(["mint by key ingest p_t2"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("tr-pasted-admin");
  });

  it("still writes an admin key as before where the deployment does not report scopes", async () => {
    pythonRepo();
    const world = server(["tr-handed-admin", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [],
      auth: flagKey("tr-handed-admin"),
      canPrompt: false,
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(mints(each.calls)).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("TRACEROOT_API_KEY=tr-handed-admin");
  });

  for (const scope of [undefined, "ingest"] as const) {
    it(`still writes a key of ${scope ?? "unreported"} scope as the application's, as before`, async () => {
      // The single-credential shape a key from `traceroot login` or `--api-key`
      // has always had.
      pythonRepo();
      const world = server(["tr-own-key", TEST_GLOBEX]);
      if (scope !== undefined) {
        world.scopes.set("tr-own-key", scope);
      }
      const each = setupRun(world, { listed: [], auth: flagKey("tr-own-key"), canPrompt: false });

      const result = await runSetupMachine(each.ctx, each.deps);

      expect(result.error).toBeNull();
      expect(mints(each.calls)).toEqual([]);
      expect(each.ctx.credential?.origin).toBe("existing-config");
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("TRACEROOT_API_KEY=tr-own-key");
    });
  }

  it("stops rather than write a key session's key over one it could not check", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-unverified-key\n");
    const world = server(["tr-acme-key", TEST_ACME]);
    world.offline.add("tr-unverified-key");
    const each = setupRun(world, { listed: [], auth: configKey("tr-acme-key"), canPrompt: false });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TRACEROOT_API_KEY=tr-unverified-key\n");
  });

  // ── what a rollback leaves ─────────────────────────────────────────────────

  it("puts back the key a cancelled rerun replaced, exactly as it was written", async () => {
    // Undoing the write used to mean deleting the line, which left an
    // application that worked before setup with no key at all.
    pythonRepo();
    const before = `# app\nexport TRACEROOT_API_KEY=tr-app-key\nTRACEROOT_HOST_URL=${HOST}\nDEBUG=1\n`;
    writeFileSync(join(dir, ".env"), before);
    const world = server(["tr-app-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      answers: ["p_t1", "yes", "abort"],
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("CANCELLED");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
    expect(plain(each.err.data)).toContain("Restored the previous TRACEROOT_API_KEY in .env.");
  });

  it("puts it back key by key when something else changed the file after the write", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-app-key\nDEBUG=1\n");
    const world = server(["tr-app-key", TEST_GLOBEX]);
    const each = setupRun(world, {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      answers: ["p_t1", "yes"],
      failAtInstrument: () => {
        writeFileSync(join(dir, ".env"), `${readFileSync(join(dir, ".env"), "utf8")}AGENT=1\n`);
      },
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("UNEXPECTED");
    const after = readFileSync(join(dir, ".env"), "utf8");
    expect(after).toContain("TRACEROOT_API_KEY=tr-app-key");
    expect(after).not.toContain("TRACEROOT_HOST_URL");
    expect(after).toContain("DEBUG=1");
    expect(after).toContain("AGENT=1");
    const said = plain(each.err.data);
    expect(said).toContain("Restored the previous TRACEROOT_API_KEY in .env.");
    expect(said).toContain("Removed TRACEROOT_HOST_URL from .env.");
  });

  // ── what a cancel says it kept ────────────────────────────────────────────

  const SKILL = ".claude/skills/traceroot-instrument-repo";

  it("says what Abort does, rather than that it changes nothing", async () => {
    pythonRepo();
    const each = setupRun(server(), { listed: [ALPHA], answers: ["abort"] });

    await runSetupMachine(each.ctx, each.deps);

    const confirm = each.asked.find((input) => input.message.includes("Proceed?"));
    expect(confirm?.options).toEqual([
      { value: "confirm", label: "Confirm", hint: "run Claude Code" },
      { value: "abort", label: "Abort", hint: "cancel setup without running Claude Code" },
    ]);
  });

  // ── what a rollback does with the CLI's config ─────────────────────────────

  const DEAD_CONFIG = `{"api_key":"tr-dead-cli","host_url":"${HOST}","project_id":"p_a"}`;
  const configFile = (text: string | null = null) => ({
    text,
    restored: [] as (string | null)[],
  });

  it("leaves no config behind when a first run is cancelled after signing in", async () => {
    // The config went on naming the CLI key the rollback had just revoked, so
    // after `traceroot logout` every command signed in with a key that was gone.
    pythonRepo();
    const file = configFile();
    const each = setupRun(server(), {
      listed: [ALPHA],
      answers: ["abort"],
      configFile: file,
      revoke: "ok",
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error?.code).toBe("CANCELLED");
    expect(each.configured).toHaveLength(1);
    expect(file.text).toBeNull();
    expect(file.restored).toEqual([null]);
    const said = plain(each.err.data);
    expect(said).toContain("Revoked the 2 API keys");
    expect(said).toContain("Removed the CLI's config, which this run created.");
    // Not claimed as kept: the rollback after it takes the config back.
    expect(result.error?.message.split("\n")[0]).toBe(
      `Setup cancelled — Claude Code was not run, so no code was changed. Setup kept the TraceRoot skill in ${SKILL}.`,
    );
    expect(existsSync(join(dir, SKILL))).toBe(true);
  });

  it("puts back, byte for byte, the config a rerun wrote over a dead key", async () => {
    pythonRepo();
    const world = server(["tr-dead-cli", ALPHA]);
    world.refused.set("tr-dead-cli", "API key has expired");
    const file = configFile(DEAD_CONFIG);
    const each = setupRun(world, {
      listed: [ALPHA],
      answers: ["abort"],
      configFile: file,
      revoke: "ok",
    });

    await runSetupMachine(each.ctx, each.deps);

    expect(each.configured).toEqual(["tr-admin-p_a-1"]);
    expect(file.text).toBe(DEAD_CONFIG);
    expect(plain(each.err.data)).toContain("Restored the CLI's previous config.");
  });

  it("puts it back field by field when something changed the file after the write", async () => {
    pythonRepo();
    const world = server(["tr-dead-cli", ALPHA]);
    world.refused.set("tr-dead-cli", "API key has expired");
    const file = configFile(DEAD_CONFIG);
    const each = setupRun(world, {
      listed: [ALPHA],
      configFile: file,
      revoke: "ok",
      // Something else writing the config while the run is in flight.
      failAtInstrument: () => {
        file.text = JSON.stringify({ ...JSON.parse(file.text ?? "{}"), project_id: "p_new" });
      },
    });

    await runSetupMachine(each.ctx, each.deps);

    expect(JSON.parse(file.text ?? "")).toEqual({
      api_key: "tr-dead-cli",
      host_url: HOST,
      project_id: "p_new",
    });
    expect(plain(each.err.data)).toContain("Restored the CLI's previous config.");
  });

  it("keeps a field changed since, and puts back the rest", async () => {
    // The host was moved by something else after this run's write, and that
    // move is not this run's to undo; the key goes back to the one before it.
    pythonRepo();
    const world = server(["tr-dead-cli", ALPHA]);
    world.refused.set("tr-dead-cli", "API key has expired");
    const file = configFile(DEAD_CONFIG);
    const each = setupRun(world, {
      listed: [ALPHA],
      configFile: file,
      revoke: "ok",
      failAtInstrument: () => {
        file.text = JSON.stringify({
          ...JSON.parse(file.text ?? "{}"),
          host_url: "https://moved.example.test",
        });
      },
    });

    await runSetupMachine(each.ctx, each.deps);

    expect(JSON.parse(file.text ?? "")).toEqual({
      api_key: "tr-dead-cli",
      host_url: "https://moved.example.test",
      project_id: "p_a",
    });
  });

  it("takes only its own fields out of a config it created that something added to", async () => {
    pythonRepo();
    const file = configFile();
    const each = setupRun(server(), {
      listed: [ALPHA],
      configFile: file,
      revoke: "ok",
      failAtInstrument: () => {
        file.text = JSON.stringify({ ...JSON.parse(file.text ?? "{}"), project_id: "p_other" });
      },
    });

    await runSetupMachine(each.ctx, each.deps);

    expect(JSON.parse(file.text ?? "")).toEqual({ project_id: "p_other" });
    expect(plain(each.err.data)).toContain("Removed the revoked key from the CLI's config.");
  });

  it("leaves the config alone when the run reused the CLI key in it", async () => {
    pythonRepo();
    const text = `${JSON.stringify({ api_key: "tr-cli-key", host_url: HOST, project_id: "p_a" }, null, 2)}\n`;
    const file = configFile(text);
    const each = setupRun(server(["tr-cli-key", ALPHA]), {
      listed: [ALPHA],
      answers: ["abort"],
      configFile: file,
      revoke: "ok",
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(mints(each.calls)).toEqual(["mint ingest p_a"]);
    expect(file.restored).toEqual([]);
    expect(file.text).toBe(text);
    expect(plain(each.err.data)).not.toContain("CLI's config");
    // The one config the rollback is certain to leave, so the one named as kept.
    expect(result.error?.message.split("\n")[0]).toBe(
      `Setup cancelled — Claude Code was not run, so no code was changed. Setup kept the TraceRoot skill in ${SKILL} and the CLI's config.`,
    );
  });

  it("keeps the config when the key in it could not be revoked, and says so", async () => {
    pythonRepo();
    const file = configFile();
    const each = setupRun(server(), {
      listed: [ALPHA],
      answers: ["abort"],
      configFile: file,
      revoke: new BackendUnavailableError("/api/v1/public/projects/p_a/api-keys/ak_1", 404),
    });

    await runSetupMachine(each.ctx, each.deps);

    expect(file.restored).toEqual([]);
    expect(JSON.parse(file.text ?? "").api_key).toBe("tr-admin-p_a-1");
    const said = plain(each.err.data);
    expect(said).toContain("they are still live");
    expect(said).toContain("Kept the CLI's config, since the key in it still works.");
  });

  it("names the sign-in command as setup was started when it cannot put the config back", async () => {
    pythonRepo();
    const file = configFile();
    const each = setupRun(server(), {
      listed: [ALPHA],
      answers: ["abort"],
      configFile: file,
      revoke: "ok",
    });
    const deps: SetupDeps = {
      ...each.deps,
      restoreConfigText: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    // As npx starts it, where no `traceroot` is on PATH.
    const saved = { script: process.argv[1], npmCommand: process.env.npm_command };
    process.argv[1] = "/Users/u/.npm/_npx/6c3e1b2a9f0d4e17/node_modules/.bin/traceroot";
    process.env.npm_command = "exec";
    try {
      await runSetupMachine(each.ctx, deps);
    } finally {
      process.argv[1] = saved.script as string;
      if (saved.npmCommand === undefined) {
        // biome-ignore lint/performance/noDelete: an unset env var, not the string "undefined"
        delete process.env.npm_command;
      } else {
        process.env.npm_command = saved.npmCommand;
      }
    }

    expect(plain(each.err.data)).toContain(
      `could not put the CLI's config back, and it names a key this run revoked; run \`npx -y traceroot-cli@${getVersion()} login\` to replace it`,
    );
  });

  it("leaves a config that names another key by the time of the rollback", async () => {
    pythonRepo();
    const file = configFile();
    const other = `${JSON.stringify({ api_key: "tr-from-login", host_url: HOST }, null, 2)}\n`;
    const each = setupRun(server(), {
      listed: [ALPHA],
      configFile: file,
      revoke: "ok",
      failAtInstrument: () => {
        file.text = other;
      },
    });

    await runSetupMachine(each.ctx, each.deps);

    expect(file.restored).toEqual([]);
    expect(file.text).toBe(other);
    expect(plain(each.err.data)).not.toContain("CLI's config");
  });

  it("reads and puts back the CLI's own config file in production", async () => {
    const { vi } = await import("vitest");
    const path = join(dir, "cli-config.json");
    vi.stubEnv("TRACEROOT_CONFIG_PATH", path);
    try {
      const deps = defaultSetupDeps(authEmpty());
      expect(deps.readConfigText()).toBeNull();
      deps.restoreConfigText(DEAD_CONFIG);
      expect(readFileSync(path, "utf8")).toBe(DEAD_CONFIG);
      expect(deps.readConfigText()).toBe(DEAD_CONFIG);
      deps.restoreConfigText(null);
      expect(existsSync(path)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ── the project the CLI's config names ─────────────────────────────────────

  it("keeps the project_id a config already names when the run chooses that project", async () => {
    pythonRepo();
    const file = configFile(`{\n  "project_id": "p_t2"\n}\n`);
    const each = setupRun(server(), {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      answers: ["p_t2"],
      configFile: file,
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(JSON.parse(file.text ?? "")).toEqual({
      project_id: "p_t2",
      api_key: "tr-admin-p_t2-1",
      host_url: HOST,
    });
  });

  it("replaces the config's project_id only with the project the run chose", async () => {
    pythonRepo();
    const file = configFile(`{\n  "project_id": "p_a"\n}\n`);
    const each = setupRun(server(), {
      listed: [ALPHA, TEST_ACME, TEST_GLOBEX],
      answers: ["p_t2"],
      configFile: file,
    });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(result.error).toBeNull();
    expect(JSON.parse(file.text ?? "").project_id).toBe("p_t2");
  });

  it("leaves a config later commands find the project in when a saved sign-in outranks its key", async () => {
    // A user credential belongs to no project, so every project-scoped read
    // after setup needs the config to name one.
    const { vi } = await import("vitest");
    const path = join(dir, "cli-config.json");
    vi.stubEnv("TRACEROOT_CONFIG_PATH", path);
    try {
      pythonRepo();
      const production = defaultSetupDeps(authEmpty());
      const each = setupRun(server(), { listed: [ALPHA, TEST_ACME], answers: ["p_t1"] });
      const deps: SetupDeps = {
        ...each.deps,
        writeConfig: production.writeConfig,
        readConfig: production.readConfig,
        readConfigText: production.readConfigText,
        restoreConfigText: production.restoreConfigText,
      };

      const result = await runSetupMachine(each.ctx, deps);

      expect(result.error).toBeNull();
      const next = resolveAuth({
        readConfig: () => loadConfigOrThrow(),
        readCredential: () => ({ session_token: "saved-session-token" }),
      });
      expect(next.credential.kind).toBe("session");
      expect(next.projectId).toEqual({ value: "p_t1", source: "config" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("names only the skill when the run wrote no config", async () => {
    pythonRepo();
    const world = server(["tr-own-key", TEST_GLOBEX]);
    const each = setupRun(world, { listed: [], auth: flagKey("tr-own-key"), answers: ["abort"] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(each.configured).toEqual([]);
    expect(result.error?.message.split("\n")[0]).toBe(
      `Setup cancelled — Claude Code was not run, so no code was changed. Setup kept the TraceRoot skill in ${SKILL}.`,
    );
  });

  it("claims no skill it could not install", async () => {
    pythonRepo();
    // A file where the skills directory goes, so the install fails and is skipped.
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "skills"), "not a directory\n");
    const world = server(["tr-own-key", TEST_GLOBEX]);
    const each = setupRun(world, { listed: [], auth: flagKey("tr-own-key"), answers: ["abort"] });

    const result = await runSetupMachine(each.ctx, each.deps);

    expect(plain(each.err.data)).toContain("could not install the TraceRoot skill");
    expect(result.error?.message.split("\n")[0]).toBe(
      "Setup cancelled — Claude Code was not run, so no code was changed.",
    );
  });

  // ── a typed answer the user interrupts ────────────────────────────────────

  it("hands the key prompt its stage, so an interrupt there ends the run with 130", async () => {
    // The production prompt raises `INTERRUPTED` for the stage it is handed
    // (see `readAnswer`); this is the one that asks for a pasted key.
    const { SetupError } = await import("../../src/setup/errors.js");
    pythonRepo();
    const each = setupRun(server(), { listed: [] });
    const stages: string[] = [];
    const deps: SetupDeps = {
      ...each.deps,
      readCredential: () => null,
      promptHidden: async (_question, stage) => {
        stages.push(stage);
        throw new SetupError({ stage, code: "INTERRUPTED", message: "Setup interrupted." });
      },
    };

    const result = await runSetupMachine(each.ctx, deps);

    expect(stages).toEqual(["authenticate"]);
    expect(result.error?.code).toBe("INTERRUPTED");
    expect(result.error?.stage).toBe("authenticate");
    expect(result.error?.exitCode).toBe(130);
  });

  it("hands the new-project prompt its stage too", async () => {
    const { SetupError } = await import("../../src/setup/errors.js");
    pythonRepo();
    const each = setupRun(server(), { listed: [] });
    const stages: (string | undefined)[] = [];
    const deps: SetupDeps = {
      ...each.deps,
      createSetupApi: (opts) => ({
        ...each.deps.createSetupApi(opts),
        listWorkspaces: async () => [{ id: "w_2", name: "Globex", role: "admin" }],
      }),
      prompt: async (_question, stage) => {
        stages.push(stage);
        throw new SetupError({
          stage: stage ?? "complete",
          code: "INTERRUPTED",
          message: "Setup interrupted.",
        });
      },
    };

    const result = await runSetupMachine(each.ctx, deps);

    expect(stages).toEqual(["authenticate"]);
    expect(result.error?.code).toBe("INTERRUPTED");
    expect(result.error?.exitCode).toBe(130);
  });
});

describe("project credential", () => {
  it("reuses a valid key already in the project's .env rather than minting another", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-existing-env-key-99\n");
    let minted = 0;
    const deps = makeDeps({
      auth: authWithKey(),
      // Force the mint/reuse branch by making the user key resolve elsewhere.
      client: fakeApiClient({ whoamiResult: whoami() }),
      traces: [traceRow()],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [],
        createApiKey: async () => {
          minted += 1;
          throw new Error("should not mint");
        },
      }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    const result = await runSetupMachine(ctx, deps);

    expect(minted).toBe(0);
    expect(result.ok).toBe(true);
    expect(ctx.credential?.origin).toBe("reused");
  });

  it("refuses to overwrite a key that points at a different project", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-other-project-key-77\n");
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        // The env key authenticates, but to a different project.
        whoamiResult: async () => whoami({ project_id: "p_other", project_name: "other" }),
      }),
      traces: [traceRow()],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
          { project_id: "p_other", project_name: "other", workspace_id: "w_1" },
        ],
      }),
    });
    const { ctx } = makeCtx({ flags: { project: "demo" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("UNSAFE_OVERWRITE");
    expect(result.error?.message).toContain("other");
    // By its id, which no name with a space, or a namesake, can get wrong.
    expect(result.error?.remedy).toContain("\n  traceroot setup --project p_other\n");
    // The file must be untouched.
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("tr-other-project-key-77");
  });

  it("mints a uniquely-named key and never prints it", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
      }),
      traces: [traceRow()],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [
          {
            id: "ak_0",
            name: `traceroot-setup-${join(dir).split("/").pop()}`,
            hint: "tr-…0000",
            project_id: "p_1",
            scope: "ingest",
            expires_at: null,
          },
        ],
        createApiKey: async ({ name }) => ({
          id: "ak_1",
          name,
          hint: "tr-…9999",
          project_id: "p_1",
          scope: "ingest",
          expires_at: null,
          key: "tr-minted-secret-value-42",
        }),
      }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx, out, err } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(ctx.credential?.origin).toBe("minted");
    // Deduped away from the existing name.
    expect(ctx.credential?.keyName).toMatch(/-2$/);
    expect(out.data).not.toContain("tr-minted-secret-value-42");
    expect(err.data).not.toContain("tr-minted-secret-value-42");
    // But it does reach the project's `.env`, which is where the app reads it.
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("tr-minted-secret-value-42");
  });

  it("names the manual fallback when key creation is not deployed", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ whoamiResult: async () => whoami({ project_id: "p_other" }) }),
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => {
          throw new BackendUnavailableError("/api/v1/public/api-keys", 404);
        },
      }),
    });
    const { ctx } = makeCtx({ flags: { project: "demo" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("BACKEND_UNSUPPORTED");
    expect(result.error?.message).toContain("--api-key");
  });

  it("dedupes key names", () => {
    expect(uniqueKeyName("k", [])).toBe("k");
    expect(uniqueKeyName("k", ["k"])).toBe("k-2");
    expect(uniqueKeyName("k", ["k", "k-2"])).toBe("k-3");
  });
});

describe("the credential the instrumented application will read", () => {
  const KEY = "tr-user-key-value";

  /** Resolved auth holding the same key, differing only in where it came from. */
  function authFrom(source: ResolvedAuth["credential"]["source"]): ResolvedAuth {
    return {
      credential: { kind: "api-key", value: KEY, source },
      hostUrl: { value: "https://api.example.test", source: "config" },
      authHost: { value: "https://api.example.test", source: "default" },
      projectId: { value: undefined, source: "none" },
    };
  }

  function configuredKeyRun(auth: ResolvedAuth, env?: NodeJS.ProcessEnv): SetupDeps {
    return makeDeps({
      auth,
      env,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
  }

  /** The stage's settled status, ignoring the `start` event that precedes it. */
  function statusOf(events: SetupEvent[], stage: string): string | undefined {
    const settled = events.find(
      (e) => e.event === "stage" && e.stage === stage && e.status !== "start",
    );
    return settled !== undefined && settled.event === "stage" ? settled.status : undefined;
  }

  // The application resolves `TRACEROOT_API_KEY` from its own environment, so
  // the only question that decides this stage is whether it will find this key
  // there without setup writing a file. Each of these establishes the source for
  // real, because a skip asserted over an empty source asserts nothing.
  it("writes nothing for a key already exported in the environment", async () => {
    pythonRepo();
    initGit();
    const env = { PATH: "/usr/bin", TRACEROOT_API_KEY: KEY };
    const deps = configuredKeyRun(authFrom("env"), env);
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    // The premise, stated rather than assumed: this is the environment setup
    // inherited and the user's shell will hand to their application.
    expect(deps.env.TRACEROOT_API_KEY).toBe(KEY);
    expect(statusOf(events, "configure_repository")).toBe("skipped");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("names no credential file to the agent when it never wrote one", async () => {
    // The converse of the load the task now carries. This stage is satisfied
    // before it runs when the application can already resolve the key, so no
    // env file is created — and telling the entry point to load the key from a
    // file would trade a credential the app already has for a false lead.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authFrom("env"),
      env: { PATH: "/usr/bin", TRACEROOT_API_KEY: KEY },
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    await runSetupMachine(ctx, deps);

    expect(statusOf(events, "configure_repository")).toBe("skipped");
    expect(existsSync(join(dir, ".env"))).toBe(false);
    // The assertion below is a negative one, so it passes for free if the run
    // never got as far as launching an agent. Pin the launch down first.
    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    expect(launch?.stdin ?? "").not.toContain("wrote `TRACEROOT_API_KEY` into");
  });

  it("names the credential file on a rerun that had nothing to write", async () => {
    // The file already holds the right values, so `upsertEnvFile` writes
    // nothing and the stage reports `skipped`. It is still the file the
    // application loads, so the closing notice and the report have to name it:
    // reading `credentialEnvFile` as "what this run wrote" leaves a rerun
    // silent about the file the user actually has.
    pythonRepo();
    initGit();
    const existing = `TRACEROOT_API_KEY=${KEY}\nTRACEROOT_HOST_URL=https://api.example.test\n`;
    writeFileSync(join(dir, ".env"), existing);
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("config")));

    expect(result.error).toBeNull();
    // The stage ran and found nothing to do, rather than being skipped before it.
    expect(statusOf(events, "configure_repository")).toBe("skipped");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(existing);
    expect(ctx.credentialEnvFile).toBe(join(dir, ".env"));
  });

  it("writes nothing for a key already in the `.env` beside the application", async () => {
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), `TRACEROOT_API_KEY=${KEY}\n`);
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("auto-env-file")));

    expect(result.error).toBeNull();
    // The file an application's own dotenv loader reads really does hold it —
    // and it is now the very file this stage would have written to, so being
    // byte-for-byte unchanged is the proof that nothing was written.
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`TRACEROOT_API_KEY=${KEY}\n`);
    expect(statusOf(events, "configure_repository")).toBe("skipped");
  });

  it("writes nothing for a key exported in its env-assignment form", async () => {
    // `resolveAuth` normalises the wrapper off, so the credential is bare while
    // the variable is not. Comparing them raw would write a second copy of a key
    // the application already has.
    pythonRepo();
    initGit();
    const env = { PATH: "/usr/bin", TRACEROOT_API_KEY: `TRACEROOT_API_KEY="${KEY}"` };
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("env"), env));

    expect(result.error).toBeNull();
    expect(statusOf(events, "configure_repository")).toBe("skipped");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  // The converse: the source says the application can resolve the credential
  // and it cannot. Only a lie in the fixture can produce this within one
  // invocation, but the stage that leaves a user with no credential is the wrong
  // place to trust a label computed somewhere else.
  it("writes anyway when the environment does not actually hold the key", async () => {
    pythonRepo();
    initGit();
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("env")));

    expect(result.error).toBeNull();
    expect(statusOf(events, "configure_repository")).toBe("ok");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(KEY);
  });

  it("writes anyway when there is no `.env` to have resolved from", async () => {
    pythonRepo();
    initGit();
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("auto-env-file")));

    expect(result.error).toBeNull();
    expect(statusOf(events, "configure_repository")).toBe("ok");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(KEY);
  });

  it("replaces a stale key in the `.env` rather than writing beside it", async () => {
    // A stale `.env` is not this credential, and the application loading it
    // would authenticate as something else or not at all. The replacement is in
    // place now, in the file the application already reads — the superseded
    // value does not survive beside the new one.
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-some-other-key\n");
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });
    const deps = configuredKeyRun(authFrom("auto-env-file"));
    // Stale in the server's own words. A key it still accepted for this project
    // would be kept rather than replaced.
    const answer = deps.createClient;
    deps.createClient = (opts) =>
      opts.auth.kind === "api-key" && opts.auth.key === "tr-some-other-key"
        ? fakeApiClient({
            whoamiResult: async () => {
              throw new CliError("Invalid API key", ExitCode.auth);
            },
          })
        : answer(opts);

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(statusOf(events, "configure_repository")).toBe("ok");
    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(written).toContain(KEY);
    expect(written).not.toContain("tr-some-other-key");
  });

  // Each of these reached the stage looking like a key already in the
  // environment, and each left the application with nothing to authenticate
  // with. `config` is `traceroot login` followed by `traceroot setup`: the key
  // is in the CLI's own store under the home directory, which no SDK reads.
  const writes: [source: ResolvedAuth["credential"]["source"], what: string][] = [
    ["config", "the CLI's own config file"],
    ["flag", "--api-key, for this invocation only"],
    ["env-file", "a file named for the CLI with --env-file"],
  ];
  for (const [source, what] of writes) {
    it(`writes the credential for a key from ${what}`, async () => {
      pythonRepo();
      initGit();
      const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

      const result = await runSetupMachine(ctx, configuredKeyRun(authFrom(source)));

      expect(result.error).toBeNull();
      expect(statusOf(events, "configure_repository")).toBe("ok");
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain(KEY);
    });
  }

  it("writes the pasted key, and leaves the user's .gitignore alone", async () => {
    // The run that found this: authenticated by paste, `configure_repository`
    // recorded `skipped` and completed, and setup closed by telling the user to
    // run an application whose `traceroot.initialize()` had no credential to
    // find.
    pythonRepo();
    initGit();
    const pasted = "tr-27332255-pasted-key";
    const deps = makeDeps({
      auth: authEmpty(),
      hiddenAnswers: [pasted],
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx, events } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(statusOf(events, "configure_repository")).toBe("ok");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(pasted);
    // The stage used to append a rule here. It asks git and tells the user now;
    // the user's ignore file is theirs.
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});

describe("where the application's key ended up", () => {
  // The question the closing production block asks, and the one it used to
  // answer with a constant. Three outcomes reach it with a trace in hand, and
  // "the credential file, or `./.env` if there isn't one" collapsed two of them
  // into an instruction to open a file the run deliberately did not write.
  const KEY = "tr-located-key-value";

  function authFrom(source: ResolvedAuth["credential"]["source"]): ResolvedAuth {
    return {
      credential: { kind: "api-key", value: KEY, source },
      hostUrl: { value: "https://api.example.test", source: "config" },
      authHost: { value: "https://api.example.test", source: "default" },
      projectId: { value: undefined, source: "none" },
    };
  }

  function depsFor(auth: ResolvedAuth, env?: NodeJS.ProcessEnv): SetupDeps {
    return makeDeps({
      auth,
      env,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
  }

  it("names the file, relative to the repository root, when one holds the key", async () => {
    pythonRepo();
    initGit();
    const deps = depsFor(authFrom("config"));
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    // The run has to have reached `configure_repository` for the answer to mean
    // anything. Two of the cases below are what the fallback returns from an
    // untouched context, so a pipeline that failed at stage one would answer
    // them correctly by accident.
    expect(result.error).toBeNull();
    expect(applicationKeyLocation(ctx, deps)).toEqual({ kind: "file", path: ".env" });
  });

  it("names the file for an ambient key that is already in one", async () => {
    // `auto-env-file` is the one ambient source that is a file — the `.env`
    // beside where the command ran, which is what an application's own loader
    // reads. Nothing was written, and there is still a path to send the user
    // to, so it is a file case rather than a vague gesture at the environment.
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), `TRACEROOT_API_KEY=${KEY}\n`);
    const deps = depsFor(authFrom("auto-env-file"));
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(ctx.credentialEnvFile).toBeUndefined();
    expect(applicationKeyLocation(ctx, deps)).toEqual({ kind: "file", path: ".env" });
  });

  it("says the environment when the key was never in a file at all", async () => {
    pythonRepo();
    initGit();
    const deps = depsFor(authFrom("env"), { PATH: "/usr/bin", TRACEROOT_API_KEY: KEY });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(applicationKeyLocation(ctx, deps)).toEqual({ kind: "environment" });
  });

  it("records the file git made it refuse, so it is not read as the case above", async () => {
    // The two no-file runs need different instructions: here the key was
    // written down nowhere, and telling this user to copy it out of their
    // environment would be as wrong as naming a file. The refusal is kept on
    // the context for exactly that reason.
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), "# committed by mistake\n");
    const deps = depsFor(authFrom("config"));
    deps.runProcess = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      // Answered per subcommand, not per program: `.env` on stdout means
      // "tracked" to `ls-files` and "ignored" to `check-ignore`, so a single
      // canned answer tells this stage two contradictory things and only
      // happens to exercise the tracked branch because that one returns first.
      git: (args) => (args.includes("ls-files") ? { output: ".env\n" } : {}),
    }).run;
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    // The refusal degrades rather than fails: the child environment handoff
    // still works, so the run goes on to the trace.
    expect(result.error).toBeNull();
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("# committed by mistake\n");
    expect(ctx.refusedCredentialEnvFile).toBe(join(dir, ".env"));
    expect(applicationKeyLocation(ctx, deps)).toEqual({ kind: "refused", path: ".env" });
  });

  it("names the service's own .env for an ambient key, not the repository root's", async () => {
    // The ambient branch joins `ctx.cwd`, not `ctx.root`, because the file
    // `resolveAuth` auto-discovers is the one beside where the command ran —
    // and in a monorepo that is the service, not the repository. Every other
    // case here runs from the root, where the two are the same directory, so
    // this is the only input that can tell the right join from the wrong one.
    // Called directly rather than after a pipeline: the fact under test is the
    // path arithmetic, and the two context fields it reads first are unset.
    const service = join(dir, "apps", "api");
    mkdirSync(service, { recursive: true });
    writeFileSync(join(service, ".env"), `TRACEROOT_API_KEY=${KEY}\n`);
    const deps = depsFor(authFrom("auto-env-file"));
    const { ctx } = makeCtx({ cwd: service, flags: { agent: "claude", service: "apps/api" } });

    expect(ctx.credentialEnvFile).toBeUndefined();
    expect(ctx.refusedCredentialEnvFile).toBeUndefined();
    expect(applicationKeyLocation(ctx, deps)).toEqual({
      kind: "file",
      path: join("apps", "api", ".env"),
    });
  });
});

describe("stack and agent selection", () => {
  it("ASKS which service when it can, instead of demanding a flag", async () => {
    // --service exists for runs that cannot be asked. An interactive user should
    // simply be offered the list, like every other choice in the flow.
    mkdirSync(join(dir, "apps", "api"), { recursive: true });
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "api", "pyproject.toml"),
      '[project]\ndependencies=["pytest"]\n',
    );
    writeFileSync(
      join(dir, "apps", "web", "package.json"),
      JSON.stringify({ dependencies: { next: "^14" } }),
    );
    initGit();

    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", ""] }).run,
      // TypeScript is the only language in apps/web; then the task-file route.
      answers: ["typescript", "task-file"],
    });
    const { ctx } = makeCtx({ canPrompt: true });
    const result = await runSetupMachine(ctx, deps);

    // The choice is the observable behaviour; the prompt's wording belongs to
    // the selector, not to this stage.
    expect(ctx.stack?.selected?.path).toBe("apps/web");
    expect(result.error).toBeNull();
  });

  it("rejects a choice that is not on the list", async () => {
    mkdirSync(join(dir, "apps", "api"), { recursive: true });
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "api", "pyproject.toml"), "[project]\n");
    writeFileSync(
      join(dir, "apps", "web", "package.json"),
      JSON.stringify({ dependencies: { next: "^14" } }),
    );
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient(),
      answers: ["9"],
    });
    const { ctx } = makeCtx({ canPrompt: true });
    const result = await runSetupMachine(ctx, deps);
    expect(result.error?.code).toBe("AMBIGUOUS");
  });

  it("asks which language on a polyglot repository, not which path", async () => {
    // The paths are the agent's business; the language is the CLI's, because it
    // decides the SDK, the install command and the init snippet.
    mkdirSync(join(dir, "apps/api"), { recursive: true });
    writeFileSync(join(dir, "apps/api/pyproject.toml"), "[project]\ndependencies = []\n");
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    writeFileSync(
      join(dir, "apps/web/package.json"),
      JSON.stringify({ dependencies: { next: "^15" } }),
    );

    const deps = makeDeps({ auth: authWithKey(), traces: [traceRow()] });
    const { ctx } = makeCtx({ canPrompt: false });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.remedy).toContain("--language");
    expect(result.error?.message).not.toContain("apps/api");
  });

  it("reports an unsupported language rather than an empty repository", async () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
    const deps = makeDeps({ auth: authWithKey(), client: fakeApiClient() });
    const { ctx } = makeCtx();
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("UNSUPPORTED");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.UNSUPPORTED);
    expect(result.error?.message).toContain("Go");
  });

  it("falls back to the task file when no agent is installed and nobody can be asked", async () => {
    // Previously a hard failure. With an explicit method choice, "no agent
    // available" is not a dead end — the task file needs no agent at all.
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      env: { PATH: "" },
    });
    const { ctx } = makeCtx({ canPrompt: false });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(ctx.instrumentation?.mode).toBe("prompt-only");
  });

  it("still fails usefully when an agent is explicitly requested but cannot start", async () => {
    pythonRepo();
    initGit();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient(),
      env: { PATH: "" },
      runProcess: fakeRunProcess({ results: { claude: { spawnFailed: true, exitCode: 127 } } }).run,
    });
    const { ctx } = makeCtx({ canPrompt: false, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("UNSUPPORTED");
    expect(result.error?.remedy).toContain("--no-instrument");
  });

  it("permits the interpreter spelling the task it sent actually names", async () => {
    // Both halves come out of one real run — the task the machine handed the
    // agent, and the permission rules it launched the agent with — so neither
    // is restated here and the two cannot come apart without this failing.
    pythonRepo();
    initGit();
    // A virtualenv beside the service is what makes the two spellings differ:
    // the task names it relatively, to keep the agent out of a quoting problem,
    // and the launch used to permit only the absolute path.
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    writeFileSync(join(dir, ".venv", "bin", "python"), "");
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    const named = /run it with: `([^` ]+)/.exec(launch?.stdin ?? "")?.[1];
    expect(named).toBeDefined();
    // Non-vacuous only because the task does not name the absolute path, which
    // is the spelling a caller has in hand and the one that was permitted.
    expect(named).not.toBe(join(dir, ".venv", "bin", "python"));
    expect(launch?.args).toContain(`Bash(${named}:*)`);
  });

  it("permits the program the task names for a TypeScript service as well", async () => {
    // The same guarantee on the stack the end-to-end run never exercised. A
    // `.ts` entry point's run line is `npx tsx <entry>`, and `npx` was not on
    // the list: in a headless run there is nobody to ask, so every attempt to
    // run the service would be refused and the agent would exit 0 having
    // instrumented the code and never once executed it.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
    writeFileSync(join(dir, "index.ts"), "export {};\n");
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M index.ts"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    const named = /run it with: `([^` ]+)/.exec(launch?.stdin ?? "")?.[1];
    expect(named).toBe("npx");
    expect(launch?.args).toContain("Bash(npx:*)");
  });

  for (const stack of ["python", "typescript"] as const) {
    it(`permits the program a ${stack} server's one command starts with`, async () => {
      // Step 6 hands a server one command that starts it, sends it a request
      // and stops it. A program the launch does not allow is refused in a
      // headless run, and the server then never sees its request.
      if (stack === "python") {
        pythonRepo();
        mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
        writeFileSync(join(dir, ".venv", "bin", "python"), "");
      } else {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ dependencies: { express: "^4" } }),
        );
        writeFileSync(join(dir, "tsconfig.json"), "{}\n");
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "server.ts"), "export {};\n");
      }
      initGit();
      const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
      const deps = makeDeps({ auth: authWithKey(), traces: [traceRow()], runProcess: process.run });
      const { ctx } = makeCtx({ flags: { agent: "claude" } });
      await runSetupMachine(ctx, deps);

      const launch = process.runs.find((run) => run.program === "claude");
      expect(launch).toBeDefined();
      const program = /```bash\n(\S+) -[ce] '[^\n]*'\n```/.exec(launch?.stdin ?? "")?.[1];
      expect(program).toBe(stack === "python" ? "./.venv/bin/python" : "node");
      expect(launch?.args).toContain(`Bash(${program}:*)`);
    });
  }

  it("permits the check the task told the agent to run once", async () => {
    // The third command the task hands over in full. `pythonRepo` declares
    // pytest, which is what makes `detectStack` name the bare string `pytest`
    // here — and the allow rule has to come from the same value the task was
    // built with, which only a real run can show.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    // Behind the `TRACEROOT_ENABLED=false` the task puts in front of it, which
    // is why the prefixed rule is the one that has to be there.
    const named = /1\. Run `(TRACEROOT_ENABLED=false [^` ]+)/.exec(launch?.stdin ?? "")?.[1];
    expect(named).toBe("TRACEROOT_ENABLED=false pytest");
    expect(launch?.args).toContain(`Bash(${named}:*)`);
    expect(launch?.args).toContain("Bash(pytest:*)");
  });
});

describe("failure handling", () => {
  it("reports an agent failure with the files that changed and reverts nothing", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      results: { claude: { exitCode: 3 } },
      gitStatus: ["", " M main.py"],
    });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient(),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.AGENT_FAILED);
    expect(result.error?.message).toContain("main.py");
    expect(result.error?.remedy).toContain("Nothing was reverted");
  });

  it("fails when no trace arrives before the timeout", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.TRACE_TIMEOUT);
    expect(result.error?.remedy).toContain("--resume");
  });

  it("tells a server's user to send it a request, not to run it once", async () => {
    // `pythonRepo` is a FastAPI service. Running a server once sends nothing:
    // its outermost span is on a request handler, which runs only when a
    // request arrives.
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });
    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.framework).toBe("fastapi");
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(result.error?.remedy).toContain(
      "Start your server, send it one request and leave it running, then:\n  traceroot setup --resume",
    );
    expect(result.error?.remedy).not.toContain("Run your application once");
  });

  it("still tells a script's user to run it once", async () => {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\ndependencies = ["anthropic","pytest"]\n',
    );
    writeFileSync(join(dir, "main.py"), "print('hi')\n");
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });
    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.framework).toBeNull();
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(result.error?.remedy).toBe(
      [
        "The most common cause is that the instrumented code path never ran.",
        "Run your application once, then:",
        "  traceroot setup --resume",
        "To investigate:",
        "  traceroot setup doctor",
        "  traceroot traces list --limit 5",
      ].join("\n"),
    );
  });

  it("ignores traces that predate the run", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow({ trace_start_time: "2020-01-01T00:00:00.000Z" })],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });
    const result = await runSetupMachine(ctx, deps);
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
  });
});

describe("the two keys a run mints", () => {
  interface Minted {
    name: string;
    scope?: string;
  }

  /**
   * A browser sign-in whose key mints are recorded, with an optional refusal
   * for one scope so the authorization path can be exercised.
   */
  function signInRun(options: { refuse?: "admin" } = {}): {
    deps: SetupDeps;
    minted: Minted[];
    keyed: Minted[];
    configured: { api_key: string }[];
    runs: RecordedRun[];
  } {
    const minted: Minted[] = [];
    const keyed: Minted[] = [];
    const configured: { api_key: string }[] = [];
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const key = (name: string, scope?: string) =>
      `tr-${scope ?? "unscoped"}-${name.includes("cli") ? "cli" : "app"}-key`;
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => {
        minted.push({ name: input.name, scope: input.scope });
        if (options.refuse === input.scope) {
          throw new SetupApiError(
            "Minting an admin-scoped key requires the workspace admin role",
            403,
          );
        }
        return {
          id: `ak_${minted.length}`,
          name: input.name,
          hint: `tr-hint-${minted.length}`,
          project_id: input.projectId,
          scope: input.scope ?? "ingest",
          expires_at: null,
          key: key(input.name, input.scope),
        };
      },
      listApiKeys: async () => [],
      createApiKey: async (input) => {
        keyed.push({ name: input.name, scope: input.scope });
        return {
          id: "ak_keyed",
          name: input.name,
          hint: "tr-hint-keyed",
          project_id: input.projectId,
          scope: input.scope ?? "ingest",
          expires_at: null,
          key: "tr-keyed-key",
        };
      },
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: process.run,
      storedCredential: { session_token: "tru-saved-token" },
      onWriteConfig: (config) => configured.push(config),
    });
    return { deps, minted, keyed, configured, runs: process.runs };
  }

  it("gives the application a key that can only send telemetry", async () => {
    // The application's key travels with the application: into CI, into
    // containers, into whatever runs it. One key doing both jobs meant every
    // deployment carried a credential that could enumerate and revoke the
    // project's keys.
    pythonRepo();
    const { deps, minted, configured } = signInRun();
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(minted.map((m) => m.scope)).toEqual(["admin", "ingest"]);
    // The admin key is the CLI's own, and the only one persisted to its config.
    const cli = minted.find((m) => m.scope === "admin");
    const app = minted.find((m) => m.scope === "ingest");
    expect(cli?.name).toContain("cli");
    expect(app?.name).not.toContain("cli");
    expect(configured).toHaveLength(1);
    expect(configured[0]?.api_key).toBe("tr-admin-cli-key");
    // And the ingest key is the one the application gets.
    expect(ctx.credential?.key.reveal()).toBe("tr-ingest-app-key");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("tr-ingest-app-key");
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("tr-admin-cli-key");
  });

  it("reads the first trace back on the CLI's credential, not the application's", async () => {
    // An ingest key can send telemetry and read this project, but not manage
    // its keys. Reading is the CLI's job rather than the application's, so the
    // stage does not depend on what the backend lets an ingest key do.
    pythonRepo();
    const reads: (string | undefined)[] = [];
    const { deps, minted } = signInRun();
    const wrapped: SetupDeps = {
      ...deps,
      createSetupApi: (opts) => {
        reads.push(opts.apiKey);
        return deps.createSetupApi(opts);
      },
    };
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, wrapped);

    expect(result.ok).toBe(true);
    expect(minted).toHaveLength(2);
    // Named from the context rather than spelled out, so this cannot pass by
    // the application's key simply being called something else.
    const appKey = ctx.credential?.key.reveal();
    expect(appKey).toBeDefined();
    expect(reads).not.toContain(appKey);
    expect(reads).toContain("tr-admin-cli-key");
  });

  it("falls back to an ingest CLI key when this account may not mint one", async () => {
    // Minting a key that manages a project's other keys is reserved for a
    // workspace admin, because that is the capability the dashboard reserves
    // for one. A member must still be able to set their repository up.
    pythonRepo();
    const { deps, minted } = signInRun({ refuse: "admin" });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(minted.map((m) => m.scope)).toEqual(["admin", "ingest", "ingest"]);
    expect(plain(err.data)).toContain("cannot mint a key that manages other keys");
  });

  it("asks for ingest on the other mint path too", async () => {
    // The two paths used to assume opposite things: one minted admin because
    // "an ingest key cannot read traces", while the other already read traces
    // with an ingest key. Both now say what they want.
    //
    // Reached by making `whoami` resolve a different project than the one
    // selected, which is what sends `acquire_project_key` past its reuse fast
    // path and into the mint.
    pythonRepo();
    const { deps, keyed } = signInRun();
    const withKey: SetupDeps = {
      ...deps,
      resolvedAuth: authWithKey("tr-user-supplied-key"),
      createClient: () =>
        fakeApiClient({ whoamiResult: async () => whoami({ project_id: "p_other" }) }),
    };
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    const result = await runSetupMachine(ctx, withKey);

    expect(result.ok).toBe(true);
    expect(keyed).toHaveLength(1);
    expect(keyed[0]?.scope).toBe("ingest");
    // And that minted key is the one the application gets.
    expect(ctx.credential?.key.reveal()).toBe("tr-keyed-key");
  });
});

describe("proving the agent installed the SDK", () => {
  /** A Python SDK, so the import name under test is the one production uses. */
  const PYTHON_SDK = { package: "traceroot", version: "0.3.0", source: "registry" } as const;

  /**
   * The runs that asked whether the SDK imports. Matched on the tail of argv,
   * not the head: a Poetry probe is `poetry run python -c <code>`.
   */
  const PROBE_CODE = 'import traceroot, importlib.metadata as m; m.version("traceroot")';

  function importChecks(runs: RecordedRun[]): RecordedRun[] {
    return runs.filter((run) => run.args.at(-2) === "-c" && run.args.at(-1) === PROBE_CODE);
  }

  /** Describes a probe the way the code under test chose to run it. */
  function probeOf(runs: RecordedRun[]): string[] {
    return importChecks(runs).map((run) => [run.program, ...run.args.slice(0, -1)].join(" "));
  }

  it("fails the stage when the SDK does not import, naming the package and the interpreter", async () => {
    // The run that produced this: the agent issued the same failing install 868
    // times, reported that it had finished, and setup advanced to wait for a
    // trace from an application that could not import its SDK.
    pythonRepo();
    initGit();
    const inner = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const runProcess: SetupDeps["runProcess"] = async (o) =>
      o.args[0] === "-c"
        ? {
            exitCode: 1,
            output: "ModuleNotFoundError",
            durationMs: 1,
            timedOut: false,
            spawnFailed: false,
          }
        : inner.run(o);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess,
      sdk: { ...PYTHON_SDK },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.AGENT_FAILED);
    expect(result.error?.message).toContain("import traceroot");
    expect(result.error?.message).toContain("python3");
    expect(result.error?.message).toContain("traceroot SDK was not installed");
    // The remedy is the command, pinned, not an instruction to go and read.
    expect(result.error?.remedy).toContain("traceroot==0.3.0");
    expect(result.error?.remedy).toContain("--resume");
    // And it stops here rather than blaming the stage that comes next.
    expect(result.checkpoint.completedStages).not.toContain("instrument");
  });

  it("does not blame PEP 668 for a project whose package manager owns its environment", async () => {
    // `uv` installs into its own virtualenv, so `externally-managed-environment`
    // is not what stopped it, and the footnote would send the reader after a
    // cause that cannot apply.
    pythonRepo();
    writeFileSync(join(dir, "uv.lock"), "");
    initGit();
    const inner = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const runProcess: SetupDeps["runProcess"] = async (o) =>
      o.args[0] === "-c"
        ? {
            exitCode: 1,
            output: "ModuleNotFoundError",
            durationMs: 1,
            timedOut: false,
            spawnFailed: false,
          }
        : inner.run(o);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess,
      sdk: { ...PYTHON_SDK },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(result.error?.remedy).toContain("uv add traceroot==0.3.0");
    expect(result.error?.remedy).not.toContain("externally-managed-environment");
  });

  it("completes the stage when the SDK imports", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      sdk: { ...PYTHON_SDK },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
    // Checked once, and in the service the agent was standing in.
    const checks = importChecks(process.runs);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.cwd).toBe(dir);
  });

  it("asks the virtualenv the agent created, not the one that was missing before it ran", async () => {
    // The pre-launch answer is "no virtualenv" on exactly the repositories this
    // check exists for, and creating one is what the task tells the agent to do.
    // Reusing that answer would fail a run that had in fact succeeded.
    pythonRepo();
    initGit();
    const venvPython = join(dir, ".venv", "bin", "python");
    const inner = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const runProcess: SetupDeps["runProcess"] = async (o) => {
      if (o.program === "claude") {
        mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
        writeFileSync(venvPython, "");
      }
      return inner.run(o);
    };
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess,
      sdk: { ...PYTHON_SDK },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(importChecks(inner.runs).map((run) => run.program)).toEqual([venvPython]);
  });

  it("asks Poetry for its own environment instead of probing the system python", async () => {
    // `poetry add` installs into Poetry's environment, which for a project with
    // no in-project virtualenv lives under Poetry's cache — somewhere no amount
    // of looking beside the service will find. Probing `python3` there rejects a
    // perfectly successful install, which is worse than not checking at all.
    pythonRepo();
    writeFileSync(join(dir, "poetry.lock"), "");
    initGit();
    const inner = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const runProcess: SetupDeps["runProcess"] = async (o) =>
      // The system interpreter does not have the package. Only a probe that
      // goes through Poetry can see the install that succeeded.
      o.program === "python3"
        ? {
            exitCode: 1,
            output: "ModuleNotFoundError",
            durationMs: 1,
            timedOut: false,
            spawnFailed: false,
          }
        : inner.run(o);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess,
      sdk: { ...PYTHON_SDK },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(probeOf(inner.runs)).toEqual(["poetry run python -c"]);
  });

  it("still fails a Poetry service whose environment lacks the SDK, and says how it asked", async () => {
    pythonRepo();
    writeFileSync(join(dir, "poetry.lock"), "");
    initGit();
    const inner = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const runProcess: SetupDeps["runProcess"] = async (o) =>
      o.program === "poetry" && o.args.includes("-c")
        ? {
            exitCode: 1,
            output: "ModuleNotFoundError",
            durationMs: 1,
            timedOut: false,
            spawnFailed: false,
          }
        : inner.run(o);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess,
      sdk: { ...PYTHON_SDK },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(result.error?.message).toContain("poetry run python");
    // And the remedy is Poetry's install, not pip's — so no PEP 668 footnote.
    expect(result.error?.remedy).toContain("poetry add traceroot==0.3.0");
    expect(result.error?.remedy).not.toContain("externally-managed-environment");
  });

  it("uses the virtualenv uv puts in the project rather than `uv run`", async () => {
    // `uv add` creates `.venv` in the project directory, which is exactly where
    // the interpreter search looks. `uv run` would also work, and is wrong here:
    // it syncs the environment before running, so it would install the package
    // it is supposed to be checking for and could never report a failure.
    pythonRepo();
    writeFileSync(join(dir, "uv.lock"), "");
    initGit();
    const venvPython = join(dir, ".venv", "bin", "python");
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    writeFileSync(venvPython, "");
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      sdk: { ...PYTHON_SDK },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(probeOf(process.runs)).toEqual([`${venvPython} -c`]);
  });

  it("leaves a TypeScript service unchecked rather than guessing at node resolution", async () => {
    // An honest gap, pinned so the code and its comment cannot drift apart.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
    writeFileSync(join(dir, "index.ts"), "export {};\n");
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M index.ts"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(importChecks(process.runs)).toEqual([]);
  });
});

describe("proving the agent did something", () => {
  /** An agent's completion block, as Claude Code's stream carries it: in its closing event. */
  function completion(body: Record<string, unknown>, prose = "done"): string {
    return claudeResult(
      [prose, "```json traceroot-setup-result", JSON.stringify(body), "```"].join("\n"),
    );
  }

  it("fails the stage when the agent reports it changed nothing", async () => {
    // Exit 0 means the agent finished, not that it acted. A sandboxed agent
    // blocked from installing or editing reports the block and still exits 0 —
    // and without this the run spends the whole trace timeout before blaming
    // the instrumented path for never running.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      // Clean before and after: nothing was touched.
      gitStatus: ["", ""],
      // And the fake agent makes none of its usual edits, so the report is the
      // only thing this fires on — the wording below is the one for an agent
      // that said so itself.
      instrument: false,
      results: {
        claude: {
          output: completion({
            files_changed: [],
            trace_id: null,
            notes: "npm install was blocked: EPERM writing /Users/x/.npm/_cacache",
          }),
        },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.stage).toBe("instrument");
    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(plain(result.error?.message ?? "")).toContain("without changing any files");
    // The agent's own account of the block, quoted rather than summarised away.
    expect(plain(result.error?.message ?? "")).toContain("EPERM");
    expect(result.error?.remedy).toContain("--resume");
    // The stage is not recorded, so `--resume` runs it again rather than
    // restoring a result that never happened.
    expect(result.checkpoint.completedStages).not.toContain("instrument");
    // And the run stops here rather than carrying on to wait for a trace the
    // untouched code cannot send.
    expect(result.stagesRun.map((s) => s.stage)).not.toContain("verify_trace");
  });

  it("accepts a report of edits the worktree did not see", async () => {
    // `observedChangedFiles` is empty outside a git repository and whenever
    // `git status` could not be read, so the observation alone would fail runs
    // that worked. The agent's claim has to agree before the stage fails — and
    // here the agent did instrument the entry point, which is what the stage's
    // own reading of it finds.
    pythonRepo();
    const process = fakeRunProcess({
      results: { claude: { output: completion({ files_changed: ["main.py"], trace_id: null }) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("does not fail a service that already carried TraceRoot", async () => {
    // There the right amount of editing may genuinely be none: the task tells
    // the agent to extend what is present rather than duplicate it.
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\ndependencies = ["traceroot","pytest"]\n',
    );
    writeFileSync(join(dir, "main.py"), "import traceroot\n\ntraceroot.initialize()\n");
    initGit();
    const process = fakeRunProcess({
      gitStatus: ["", ""],
      // Nothing edits anything: the service arrived instrumented and leaves
      // instrumented, which both the exclusion and the reading of the entry
      // point have to let through.
      instrument: false,
      results: { claude: { output: completion({ files_changed: [], trace_id: null }) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.existingInstrumentation.present).toBe(true);
    expect(result.error).toBeNull();
  });

  it("fails the stage when the agent leaves the service uninstrumented", async () => {
    // The run this comes from: the agent exited 0 having installed the SDK into
    // `.venv` and edited no source file at all, and emitted no completion block
    // to parse — so the guard above, which cannot fire without the agent's own
    // report, was skipped entirely. The run recorded the stage as done, passed
    // setup's own check on untouched code, and spent the whole trace timeout
    // before blaming the instrumented path for never running.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      // Exit 0 and prose only: nothing `parseCompletion` can read.
      results: { claude: { output: "I have finished instrumenting the service.\n" } },
      // The only thing git saw: the agent's own directory, which is not a
      // source file and does not instrument anything.
      gitStatus: ["", "?? .claude/"],
      instrument: false,
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.stage).toBe("instrument");
    expect(result.error?.code).toBe("AGENT_FAILED");
    const message = plain(result.error?.message ?? "");
    expect(message).toContain("still not instrumented");
    // The file it looked in, named so the user can check it themselves.
    expect(message).toContain("main.py");
    // Not the other wording: this agent reported nothing, rather than reporting
    // that it changed nothing.
    expect(message).not.toContain("without changing any files");
    expect(result.error?.remedy).toContain("--resume");
    expect(result.checkpoint.completedStages).not.toContain("instrument");
    // And the point of failing here: no two-minute wait for a trace that this
    // service cannot emit.
    expect(result.stagesRun.map((s) => s.stage)).not.toContain("verify_trace");
  });

  it("instruments the entry point the detector picked, not a guess at one", async () => {
    // `src/main.ts` is on the detector's Node list and was missing from the
    // fake agent's own copy of it, so the agent edited nothing and a run that
    // should have passed failed as uninstrumented. The helper asks the detector
    // now, and this is the fixture that tells it apart.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "export {};\n");
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M src/main.ts"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(readFileSync(join(dir, "src", "main.ts"), "utf8")).toContain("traceroot.initialize()");
  });

  it("catches an uninstrumented service outside a git repository", async () => {
    // No `.git`, so `observedChangedFiles` is empty however much the agent did
    // or did not do, and an inference from file counts is blind here. Reading
    // the entry point is not.
    pythonRepo();
    const process = fakeRunProcess({ instrument: false });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.stage).toBe("instrument");
    expect(plain(result.error?.message ?? "")).toContain("still not instrumented");
    expect(result.stagesRun.map((s) => s.stage)).not.toContain("verify_trace");
  });

  it("accepts an initialization wired into a module rather than the entry point", async () => {
    // The entry point is where the task tells the agent to put the call, but a
    // call in a module the entry point imports is instrumentation too — so the
    // check reads what the agent reported changing as well, and a run that
    // worked is not failed for putting the call one import away.
    //
    // Written up front because the fake agent only ever edits the entry point.
    // Nothing read this file before the stage did: `detect_stack` looks at the
    // entry point alone, which is why the run starts out "not instrumented".
    pythonRepo();
    writeFileSync(join(dir, "tracing.py"), "import traceroot\n\ntraceroot.initialize()\n");
    // The entry point imports it, which is what makes this module the
    // service's instrumentation rather than an unrelated initialized file.
    writeFileSync(join(dir, "main.py"), "import tracing\n\nprint('hi')\n");
    const process = fakeRunProcess({
      instrument: false,
      results: {
        claude: {
          output: completion({ files_changed: ["tracing.py", "main.py"], trace_id: null }),
        },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.existingInstrumentation.present).toBe(false);
    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("accepts that module when the agent reported nothing and there is no git", async () => {
    // The state the test above does not reach: no completion fence to parse and
    // no `.git`, so neither of the lists the reading is given has anything in
    // it. That is the ordinary state of a Codex run in a directory that is not
    // a repository — and it left the reading looking at `main.py` alone and
    // failing a run that had instrumented the service one import away.
    pythonRepo();
    writeFileSync(join(dir, "tracing.py"), "import traceroot\n\ntraceroot.initialize()\n");
    writeFileSync(join(dir, "main.py"), "import tracing\n\nprint('hi')\n");
    const process = fakeRunProcess({
      // Prose, not a completion block: nothing `parseCompletion` can read.
      results: { claude: { output: "Added TraceRoot to the service.\n" } },
      instrument: false,
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.existingInstrumentation.present).toBe(false);
    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("accepts that module when Codex's reply has no block, though it echoed the task's template", async () => {
    // `codex exec` prints the task before its reply, and the task's report
    // template is a valid block. Parsed whole, the output read as a report
    // naming the template's placeholder files, so the reading skipped the
    // service's own folder and failed this run.
    pythonRepo();
    writeFileSync(join(dir, "tracing.py"), "import traceroot\n\ntraceroot.initialize()\n");
    writeFileSync(join(dir, "main.py"), "import tracing\n\nprint('hi')\n");
    const base = fakeRunProcess({ instrument: false });
    const run: SetupDeps["runProcess"] = async (o) => {
      const result = await base.run(o);
      return o.program === "codex"
        ? { ...result, output: codexCapture(o.stdin ?? "", "Added TraceRoot to the service.") }
        : result;
    };
    const deps = makeDeps({ auth: authWithKey(), traces: [traceRow()], runProcess: run });
    const { ctx } = makeCtx({ flags: { agent: "codex" } });

    const result = await runSetupMachine(ctx, deps);

    expect(base.runs.find((r) => r.program === "codex")?.stdin).toContain(
      '"notes": "anything the user should know"',
    );
    expect(result.error?.message).toBeUndefined();
    expect(ctx.instrumentation?.reported).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("does not fail a service started with arguments the reading cannot match", async () => {
    // `initialize(integrations=[...])` after `from traceroot import initialize`
    // is how the Python SDK is started with an integration, and the bare-call
    // pattern only matches empty parentheses. With no report and no git, that
    // read as no TraceRoot at all and failed a service that was instrumented.
    pythonRepo();
    writeFileSync(
      join(dir, "main.py"),
      "from traceroot import Integration, initialize\n\ninitialize(integrations=[Integration.ANTHROPIC])\n",
    );
    const process = fakeRunProcess({
      results: { claude: { output: "Added TraceRoot to the service.\n" } },
      instrument: false,
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.existingInstrumentation.present).toBe(false);
    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("does not fail a module deeper than the directory walk reaches", async () => {
    // With no report and no git, the service's own directory is read two
    // levels down. A module three levels down is never opened, which is not
    // the same as finding no TraceRoot in it.
    pythonRepo();
    mkdirSync(join(dir, "app", "core", "telemetry"), { recursive: true });
    writeFileSync(
      join(dir, "app", "core", "telemetry", "tracing.py"),
      "import traceroot\n\ntraceroot.initialize()\n",
    );
    writeFileSync(join(dir, "main.py"), "from app.core.telemetry import tracing\n\nprint('hi')\n");
    const process = fakeRunProcess({
      results: { claude: { output: "Added TraceRoot to the service.\n" } },
      instrument: false,
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("says nothing when it could not identify an entry point to read", async () => {
    // Only ever a positive finding of absence. A service with no recognised
    // entry file gives the reading nowhere to look, and "I could not check"
    // must not be reported as "the agent did nothing" — so the stage passes and
    // the run carries on to the verification that can still answer.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    const process = fakeRunProcess({ instrument: false });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.entryPoint).toBeNull();
    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("names the service's own entry point, not a bare filename", async () => {
    // `apps/api/main.py`, not `main.py`: the message exists for the user to go
    // and look, and in a monorepo the bare name is ambiguous between every
    // service that has one.
    mkdirSync(join(dir, "apps", "api"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "api", "pyproject.toml"),
      '[project]\ndependencies = ["fastapi","pytest"]\n',
    );
    writeFileSync(join(dir, "apps", "api", "main.py"), "print('hi')\n");
    const process = fakeRunProcess({ instrument: false });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", service: "apps/api" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AGENT_FAILED");
    const message = plain(result.error?.message ?? "");
    expect(message).toContain("apps/api/main.py");
  });
});

describe("the report in Claude Code's stream", () => {
  /** A reply ending in a completion block, the way the task asks for one. */
  function reply(body: Record<string, unknown>): string {
    return [
      "Here is what I did.",
      "",
      "```json traceroot-setup-result",
      JSON.stringify(body, null, 2),
      "```",
      "",
      "Then, in prose: nothing else to add.",
    ].join("\n");
  }

  /** What `claude -p --output-format stream-json --verbose` prints, one event per line. */
  function stream(text: string): string {
    return [
      JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: dir,
        tools: ["Bash", "Edit", "Read"],
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "main.py" } }] },
      }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
      claudeResult(text),
    ].join("\n");
  }

  it("fails fast on an agent that stopped without editing, with no git and no entry point", async () => {
    // A launched agent cannot ask which service to use, so it stops and says so
    // in its report. With no git there is no diff, and with no entry point
    // there is nothing to read, so the report is the only thing that shows the
    // run did nothing. Unread, the run said "Claude Code finished." and waited
    // out the whole trace timeout.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    const notes =
      "Two services could be the target: apps/api (FastAPI) and apps/worker (Celery). I edited nothing.";
    const process = fakeRunProcess({
      instrument: false,
      results: { claude: { output: stream(reply({ files_changed: [], trace_id: null, notes })) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.entryPoint).toBeNull();
    expect(result.error?.code).toBe("AGENT_FAILED");
    const message = plain(result.error?.message ?? "");
    expect(message).toContain("without changing any files");
    expect(message).toContain(`It reported: ${notes}`);
    expect(result.stagesRun.map((s) => s.stage)).not.toContain("verify_trace");
  });

  it("fails fast in a git repository where only setup's own files are new", async () => {
    // Setup installs the skill and writes the key before the agent starts, and
    // git sees both. Counted as the agent's edits, they hid an agent that
    // changed nothing, and the run waited out the trace timeout instead.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    initGit();
    const notes = "Two services could be the target. I edited nothing.";
    const process = fakeRunProcess({
      instrument: false,
      gitStatus: ["", `?? .claude/${NUL}?? .env${NUL}`],
      results: { claude: { output: stream(reply({ files_changed: [], trace_id: null, notes })) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    // Both are really there, and both are setup's.
    expect(existsSync(join(dir, ".claude", "skills", "traceroot-instrument-repo"))).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(ctx.instrumentation?.observedChangedFiles).toEqual([]);
    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(plain(result.error?.message ?? "")).toContain("without changing any files");
    expect(result.stagesRun.map((s) => s.stage)).not.toContain("verify_trace");
  });

  it("still counts what the agent changed beside setup's own files", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    initGit();
    const process = fakeRunProcess({
      instrument: false,
      gitStatus: ["", `?? .claude/${NUL}?? .env${NUL} M app.py${NUL}`],
      results: { claude: { output: stream(reply({ files_changed: [], trace_id: null })) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.instrumentation?.observedChangedFiles).toEqual(["app.py"]);
    expect(result.error).toBeNull();
  });

  it("counts the agent's edit to the env file setup wrote the key into", async () => {
    // The file is setup's only while it holds what setup wrote. Left out
    // whatever it held, a line the agent added after setup's was not counted,
    // and a run whose only edit was there read as one that changed nothing.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    initGit();
    const env = join(dir, ".env");
    const inner = fakeRunProcess({
      instrument: false,
      gitStatus: ["", `?? .claude/${NUL}?? .env${NUL}`],
      results: { claude: { output: stream(reply({ files_changed: [], trace_id: null })) } },
    });
    const runProcess: SetupDeps["runProcess"] = async (o) => {
      if (o.program === "claude") {
        writeFileSync(env, `${readFileSync(env, "utf8")}OTEL_SERVICE_NAME=api\n`);
      }
      return inner.run(o);
    };
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.instrumentation?.observedChangedFiles).toEqual([".env"]);
    expect(result.error).toBeNull();
  });

  it("does not fail a run outside git whose report names no files", async () => {
    // `files_changed` as a string is a report of edits in the wrong shape, not
    // a report of none, and with no diff to disagree it failed this run.
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    const process = fakeRunProcess({
      results: {
        claude: { output: stream(reply({ files_changed: "app/server.py", trace_id: null })) },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.instrumentation?.reported?.filesChanged).toBeNull();
    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("verify_trace");
  });

  it("reads the service's own folder when the report names no files", async () => {
    // As for an agent with no report at all: the initialization is one import
    // away, and only the service's folder has it.
    pythonRepo();
    writeFileSync(join(dir, "tracing.py"), "import traceroot\n\ntraceroot.initialize()\n");
    writeFileSync(join(dir, "main.py"), "import tracing\n\nprint('hi')\n");
    const process = fakeRunProcess({
      instrument: false,
      results: { claude: { output: stream(reply({ trace_id: null, notes: "wired it up" })) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
  });

  it("quotes the agent's notes as plain text, whatever control bytes they carry", async () => {
    // The notes are the model's own writing, decoded from JSON where an escape
    // is six plain characters, so a sequence in them reached the terminal whole.
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const CSI = String.fromCharCode(0x9b);
    const notes = [
      `${ESC}[2J${ESC}[31mBlocked:${ESC}[0m npm install`,
      `was\trefused.\r\nSee ${ESC}]8;;https://example.test${BEL}the log${ESC}]8;;${BEL}`,
      `${CSI}1Anow${String.fromCharCode(0)} and ${ESC}7done.`,
    ].join("\n");
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    const process = fakeRunProcess({
      instrument: false,
      results: { claude: { output: stream(reply({ files_changed: [], trace_id: null, notes })) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    const [message] = (result.error?.message ?? "").split("\n\n");
    expect(message).toContain(
      "It reported: Blocked: npm install was refused. See the log now and done.",
    );
    const controls = [...(message ?? "")].filter((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
  });

  it("still cuts the notes at 200 characters once they are plain", async () => {
    const ESC = String.fromCharCode(27);
    const notes = `${ESC}[31m${"a".repeat(150)}${ESC}[0m ${"b".repeat(150)}`;
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    const process = fakeRunProcess({
      instrument: false,
      results: { claude: { output: stream(reply({ files_changed: [], trace_id: null, notes })) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    const [message] = (result.error?.message ?? "").split("\n\n");
    const quoted = message?.slice(message.indexOf("It reported: ") + "It reported: ".length);
    expect(quoted).toBe(`${"a".repeat(150)} ${"b".repeat(48)}…`);
  });

  it("sends an agent that could not pick the service to --service, not --resume", async () => {
    // Two services and no answer from the user: setup leaves the choice to the
    // agent, which stops and lists the candidates when it cannot tell. A
    // `--resume` hands it the same choice again.
    for (const name of ["svc-a", "svc-b"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "requirements.txt"), "fastapi\n");
      writeFileSync(join(dir, name, "main.py"), "print(1)\n");
    }
    const notes = "Two candidates: svc-a (FastAPI) and svc-b (FastAPI). I edited nothing.";
    const process = fakeRunProcess({
      instrument: false,
      results: { claude: { output: stream(reply({ files_changed: [], trace_id: null, notes })) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.agentMustIdentify).toBe(true);
    expect(result.error?.code).toBe("AGENT_FAILED");
    const [message] = plain(result.error?.message ?? "").split("\n\n");
    expect(message).toBe(
      `Claude Code finished without changing any files, so no service is instrumented. It reported: ${notes}`,
    );
    const remedy = plain(result.error?.remedy ?? "");
    expect(remedy).toContain(
      "Rerun setup on the service you mean:\n  traceroot setup --service <path>",
    );
    expect(remedy).not.toContain("--resume");
    expect(result.stagesRun.map((s) => s.stage)).not.toContain("verify_trace");
  });

  it("reads the report on a run that worked, and carries on as before", async () => {
    pythonRepo();
    const process = fakeRunProcess({
      results: {
        claude: {
          output: stream(reply({ files_changed: ["main.py"], trace_id: null, notes: "ran once" })),
        },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(ctx.instrumentation?.reported).toEqual({
      filesChanged: ["main.py"],
      sdkVersion: null,
      traceId: null,
      notes: "ran once",
    });
    expect(result.checkpoint.completedStages).toContain("verify_trace");
  });

  it("reads no report from a stream that was cut off", async () => {
    // The closing event never arrived whole, which is the same as no block:
    // the report is null and the run is judged on what is on disk, as it was
    // for every Claude Code run before the report was read.
    pythonRepo();
    const whole = stream(reply({ files_changed: [], trace_id: null }));
    const process = fakeRunProcess({
      results: { claude: { output: whole.slice(0, whole.length - 40) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.instrumentation?.reported).toBeNull();
    expect(result.error).toBeNull();
  });

  it("still reads Codex's reply as the text it prints", async () => {
    // `codex exec` prints its reply as plain text, so its block was always
    // read, and reading Claude Code's stream must not change that.
    pythonRepo();
    const base = fakeRunProcess({ instrument: false });
    const run: SetupDeps["runProcess"] = async (o) => {
      const result = await base.run(o);
      return o.program === "codex"
        ? {
            ...result,
            output: codexCapture(o.stdin ?? "", reply({ files_changed: [], notes: "refused" })),
          }
        : result;
    };
    const deps = makeDeps({ auth: authWithKey(), traces: [traceRow()], runProcess: run });
    const { ctx } = makeCtx({ flags: { agent: "codex" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.instrumentation?.reported?.notes).toBe("refused");
    expect(plain(result.error?.message ?? "")).toContain("without changing any files");
  });
});

describe("the agent's own account of a failed run", () => {
  /** An agent's completion block, as Claude Code's stream carries it: in its closing event. */
  function completion(body: Record<string, unknown>, prose = "done"): string {
    return claudeResult(
      [prose, "```json traceroot-setup-result", JSON.stringify(body), "```"].join("\n"),
    );
  }

  /** The written transcript, or null when the run left none. */
  function transcript(): string | null {
    const path = join(dir, AGENT_OUTPUT_PATH);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  it("keeps the output of an agent that exited 0 having changed nothing", async () => {
    // The whole point of the stage's post-checks is that exit 0 proves nothing,
    // and until this existed the one account of what the agent had been doing
    // was cleared off the screen before either check ran. A denied tool call
    // appears in the stream and nowhere else.
    pythonRepo();
    initGit();
    const stream = [
      '{"type":"system","subtype":"init","tools":["Read","Edit","Write","Bash"]}',
      '{"type":"user","message":"Bash(pip install traceroot) was denied"}',
      completion({ files_changed: [], trace_id: null, notes: "a command was refused" }),
    ].join("\n");
    const process = fakeRunProcess({
      gitStatus: ["", ""],
      instrument: false,
      results: { claude: { output: stream } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(plain(result.error?.message ?? "")).toContain("without changing any files");
    // Whole, not tailed: the stop reason can be anywhere in the stream, and the
    // `init` event at the top is what says which tools the agent was given.
    const written = transcript();
    expect(written).toContain("was denied");
    expect(written).toContain('"subtype":"init"');
    // And the error says where it is, or it is evidence nobody opens.
    expect(plain(result.error?.remedy ?? "")).toContain(AGENT_OUTPUT_PATH);
    // In a directory the existing `.gitignore` covers, so a transcript quoting
    // whatever the agent read cannot land in somebody's commit.
    expect(readFileSync(join(dir, ".traceroot", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("keeps the output of an agent that left the service uninstrumented", async () => {
    // The other exit-0 failure, and the one the live runs hit: no completion
    // block at all, so the guard above it cannot fire and the entry-point
    // reading is what fails the run. Same evidence, same place.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      results: { claude: { output: "Installed traceroot. I could not edit main.py.\n" } },
      gitStatus: ["", "?? .claude/"],
      instrument: false,
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(plain(result.error?.message ?? "")).toContain("still not instrumented");
    expect(transcript()).toContain("could not edit main.py");
    expect(plain(result.error?.remedy ?? "")).toContain(AGENT_OUTPUT_PATH);
    // Only the TraceRoot key is scrubbed, so the line naming the file says so
    // to whoever is deciding whether to send it.
    expect(plain(result.error?.remedy ?? "")).toContain(
      "It can quote your repository's files, secrets included, so check it before you share it.",
    );
  });

  it("writes nothing on a run that worked", async () => {
    // The success path is unchanged: what a working run changed is in `git
    // diff` and in the setup report, and a transcript of it is litter.
    pythonRepo();
    const process = fakeRunProcess({
      results: { claude: { output: completion({ files_changed: ["main.py"], trace_id: null }) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(transcript()).toBeNull();
  });

  it("keeps the output of an agent that exited non-zero, under --json above all", async () => {
    // The failure whose cause exists only in the agent's output. The block left
    // on screen above is not a substitute: it holds the last few parsed
    // activity lines and it goes when the terminal does — and under `--json`,
    // which is how this is run in CI, there was never a feed at all. So this
    // asserts the `--json` run, where the screen defence does not exist and the
    // output would otherwise be discarded with the process.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      results: {
        claude: { exitCode: 3, output: "reading main.py\npanic: provider refused\n" },
      },
      gitStatus: ["", " M main.py"],
    });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient(),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ json: true, flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(plain(result.error?.message ?? "")).toContain("status 3");
    expect(transcript()).toContain("panic: provider refused");
    expect(plain(result.error?.remedy ?? "")).toContain(AGENT_OUTPUT_PATH);
    // And it still says first the thing a user reading an aborted run needs
    // first, which is that their worktree was left alone.
    expect(plain(result.error?.remedy ?? "")).toContain("Nothing was reverted");
  });

  it("keeps the output of an agent that finished without installing the SDK", async () => {
    // Exit 0, the entry point edited, and `import traceroot` still failing: the
    // install was step 2 of the task and something stopped it. Which something
    // is in the output, and the feed was cleared the moment the agent finished,
    // several checks before this one runs.
    pythonRepo();
    initGit();
    const inner = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: { claude: { output: "pip install traceroot: no write access to the cache\n" } },
    });
    const runProcess: SetupDeps["runProcess"] = async (o) =>
      o.args[0] === "-c"
        ? {
            exitCode: 1,
            output: "ModuleNotFoundError",
            durationMs: 1,
            timedOut: false,
            spawnFailed: false,
          }
        : inner.run(o);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess,
      sdk: { package: "traceroot", version: "0.3.0", source: "registry" },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("AGENT_FAILED");
    expect(plain(result.error?.message ?? "")).toContain("was not installed");
    expect(transcript()).toContain("no write access to the cache");
    expect(plain(result.error?.remedy ?? "")).toContain(AGENT_OUTPUT_PATH);
    // The install command is still the first instruction, not displaced by it.
    expect(plain(result.error?.remedy ?? "")).toContain("traceroot==0.3.0");
  });

  it("never writes the application credential to disk", async () => {
    // An agent that echoes its own environment, or runs the application with
    // the key in it, puts the credential in the stream this file is made of.
    // `runProcess` scrubs it from the captured output already; the write site
    // scrubs it again, because this is the copy that outlives the process.
    const key = "tr-secret-key-abcdef";
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      gitStatus: ["", ""],
      instrument: false,
      results: {
        claude: {
          output: [
            `{"type":"user","message":"TRACEROOT_API_KEY=${key}"}`,
            completion({ files_changed: [], trace_id: null }),
          ].join("\n"),
        },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(key),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(ctx.credential?.key.reveal()).toBe(key);
    const written = transcript();
    expect(written).not.toBeNull();
    expect(written).not.toContain(key);
    expect(written).toContain("<redacted>");
  });

  it("keeps the output of an agent whose run sent no trace", async () => {
    // Exit 0, the entry point edited, a report of the edit: every check in the
    // stage passes, and the first thing found wrong is the trace that never
    // came. Whatever the agent ran, or stopped short of running, is in its
    // output and nowhere else.
    pythonRepo();
    const process = fakeRunProcess({
      results: {
        claude: {
          output: [
            '{"type":"system","subtype":"init","tools":["Read","Edit","Write","Bash"]}',
            '{"type":"user","message":"Bash(python main.py) was denied"}',
            completion({ files_changed: ["main.py"], trace_id: null }),
          ].join("\n"),
        },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    // A report with no notes adds nothing to the message.
    expect(result.error?.message.split("\n\n")[0]).toMatch(/^No trace arrived within \d+s\.$/);
    expect(transcript()).toContain("was denied");
    const remedy = plain(result.error?.remedy ?? "");
    expect(remedy).toContain(
      `What Claude Code printed is in ${AGENT_OUTPUT_PATH} — the only record of what it tried, including anything it was refused.`,
    );
    expect(remedy).toContain(
      "It can quote your repository's files, secrets included, so check it before you share it.",
    );
    // Beside the cause it bears on, and ahead of the instructions to rerun.
    expect(remedy.indexOf(AGENT_OUTPUT_PATH)).toBeGreaterThan(remedy.indexOf("never ran"));
    expect(remedy.indexOf(AGENT_OUTPUT_PATH)).toBeLessThan(remedy.indexOf("--resume"));
  });

  it("quotes the agent's notes when no trace arrives after it", async () => {
    // The agent's report is the one account of the run that is not a guess,
    // and the timeout is where a run it stopped short of finishing ends up.
    const ESC = String.fromCharCode(27);
    pythonRepo();
    const process = fakeRunProcess({
      results: {
        claude: {
          output: completion({
            files_changed: ["main.py"],
            trace_id: null,
            notes: `Instrumented main.py.\nCould not run it: ${ESC}[31mpython3 was refused${ESC}[0m.`,
          }),
        },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    const [message, remedy] = (result.error?.message ?? "").split("\n\n");
    expect(message).toMatch(
      /^No trace arrived within \d+s\. Claude Code reported: Instrumented main\.py\. Could not run it: python3 was refused\.$/,
    );
    // The rest of the error is what it was.
    expect(remedy).toBe(result.error?.remedy);
    expect(plain(remedy ?? "")).toContain(AGENT_OUTPUT_PATH);
  });

  it("keeps nothing on a timeout when this run launched no agent", async () => {
    // A resume restores the stage and runs nothing, so there is no output of
    // this run's to keep, and the remedy must not name a file from another run.
    pythonRepo();
    const previous = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    previous.completedStages.push(
      "precheck",
      "authenticate",
      "select_context",
      "acquire_project_key",
      "configure_repository",
      "detect_stack",
      "select_agent",
      "install_agent_context",
      "instrument",
    );
    previous.instrumentHandover = "agent";
    writeCheckpoint(dir, previous);
    const process = fakeRunProcess({
      results: { claude: { output: completion({ files_changed: ["main.py"], trace_id: null }) } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({
      flags: { agent: "claude", resume: true, traceTimeoutSec: 1 },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });

    const result = await runSetupMachine(ctx, deps);

    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(transcript()).toBeNull();
    expect(plain(result.error?.remedy ?? "")).not.toContain(AGENT_OUTPUT_PATH);
  });
});

describe("resume and rerun", () => {
  it("resumes an interrupted run from the checkpoint", async () => {
    pythonRepo();
    // A previous run that got as far as instrumenting, then died waiting for a trace.
    const previous = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    for (const stage of [
      "precheck",
      "authenticate",
      "select_context",
      "acquire_project_key",
      "configure_repository",
      "detect_stack",
      "select_agent",
      "install_agent_context",
      "instrument",
    ] as const) {
      previous.completedStages.push(stage);
    }
    previous.lastError = { stage: "verify_trace", code: "TRACE_TIMEOUT", message: "no trace" };
    // What that previous run would have recorded: it instrumented, so an agent
    // edited this worktree. The field is how the resumed run knows not to send
    // one over it again, so a fixture standing in for such a run has to carry
    // it.
    previous.instrumentHandover = "agent";
    writeCheckpoint(dir, previous);

    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({
      flags: { agent: "claude", resume: true },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // The agent is not re-run on resume: instrumentation already happened.
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
  });

  /** The checkpoint a run leaves when an agent instrumented and the trace wait then timed out. */
  function writeTraceTimeoutCheckpoint(): void {
    const previous = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    previous.completedStages.push(
      "precheck",
      "authenticate",
      "select_context",
      "acquire_project_key",
      "configure_repository",
      "detect_stack",
      "select_agent",
      "install_agent_context",
      "instrument",
    );
    previous.lastError = { stage: "verify_trace", code: "TRACE_TIMEOUT", message: "no trace" };
    previous.instrumentHandover = "agent";
    writeCheckpoint(dir, previous);
  }

  it("clears the error an earlier run stopped on once a resume ends normally", async () => {
    // The timeout's own remedy is "run your application once, then --resume",
    // and a user who then stops the wait has a finished run. The error stayed
    // on the record, so `doctor` failed that run at the step it had completed.
    pythonRepo();
    writeTraceTimeoutCheckpoint();

    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      skipTraceWait: true,
    });
    const { ctx } = makeCtx({
      canPrompt: true,
      flags: { agent: "claude", resume: true, traceTimeoutSec: 120 },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(ctx.traceWaitSkipped).toBe(true);
    expect(result.checkpoint.lastError).toBeUndefined();
    expect(readCheckpoint(dir)?.lastError).toBeUndefined();
  });

  it("keeps the error when the resume stops on one of its own", async () => {
    pythonRepo();
    writeTraceTimeoutCheckpoint();

    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({
      flags: { agent: "claude", resume: true, traceTimeoutSec: 1 },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(readCheckpoint(dir)?.lastError).toMatchObject({
      stage: "verify_trace",
      code: "TRACE_TIMEOUT",
    });
  });

  it("does not revoke a minted key when the failure leaves a run to resume", async () => {
    pythonRepo();
    let revoked = 0;
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
      }),
      traces: [],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [],
        createApiKey: async ({ name }) => ({
          id: "ak_1",
          name,
          hint: "tr-…9999",
          project_id: "p_1",
          scope: "ingest",
          expires_at: null,
          key: "tr-minted-secret-value-42",
        }),
        revokeApiKey: async () => {
          revoked += 1;
        },
      }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({
      flags: { agent: "claude", project: "demo", resume: true, traceTimeoutSec: 1 },
    });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(revoked).toBe(0);
  });

  it("does not revoke it on that failure without --resume either", async () => {
    // The flag describes the *previous* run. This one stopped at "no trace
    // yet", told the user to run their application and resume — and then
    // revoked the key their application needs to send the trace with, and took
    // it back out of the env file, for no reason other than that the flag was
    // absent.
    pythonRepo();
    let revoked = 0;
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
      }),
      traces: [],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [],
        createApiKey: async ({ name }) => ({
          id: "ak_1",
          name,
          hint: "tr-…9999",
          project_id: "p_1",
          scope: "ingest",
          expires_at: null,
          key: "tr-minted-secret-value-42",
        }),
        revokeApiKey: async () => {
          revoked += 1;
        },
      }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({
      flags: { agent: "claude", project: "demo", traceTimeoutSec: 1 },
    });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(revoked).toBe(0);
    // And the credential the remedy depends on is still where it was written.
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("tr-minted-secret-value-42");
  });

  it("revokes a key it minted when the run is over rather than paused", async () => {
    pythonRepo();
    let revoked: string | null = null;
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
      }),
      traces: [],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [],
        createApiKey: async ({ name }) => ({
          id: "ak_1",
          name,
          hint: "tr-…9999",
          project_id: "p_1",
          scope: "ingest",
          expires_at: null,
          key: "tr-minted-secret-value-42",
        }),
        revokeApiKey: async (id) => {
          revoked = id;
        },
      }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    // Something no stage anticipated, which is the ending that gets no benefit
    // of the doubt: it has not promised the user a resume, so what it created
    // is litter.
    const failing: SetupDeps = {
      ...deps,
      resolveSdk: async () => {
        throw new Error("the registry refused the request");
      },
    };
    const { ctx } = makeCtx({
      flags: { agent: "claude", project: "demo", traceTimeoutSec: 1 },
    });
    const result = await runSetupMachine(ctx, failing);

    expect(result.error?.code).toBe("UNEXPECTED");
    expect(revoked).toBe("ak_1");
    // And the `.env` this run created goes with it. The repository had none
    // before, so what is left once the key comes out is a file whose own header
    // says it contains a live API key — read as configuration by the next tool
    // to look at it, and true of nothing.
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("is a cheap no-op when rerun after success", async () => {
    pythonRepo();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });

    const first = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(first.ctx, deps);
    const agentRunsAfterFirst = process.runs.filter((r) => r.program === "claude").length;

    const second = makeCtx({
      flags: { agent: "claude", resume: true },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });
    const result = await runSetupMachine(second.ctx, deps);

    expect(result.ok).toBe(true);
    // No second agent launch and no second instrumentation.
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(agentRunsAfterFirst);
  });
});

describe("what a failed run takes back", () => {
  /**
   * A browser sign-in that reaches instrumentation and then fails for a reason
   * no stage anticipated, which is the shape of the run this exists for: two
   * keys minted during sign-in, a credential written into the project's env
   * file, and nothing to show for either.
   */
  function signInThenFail(
    options: {
      revokeFails?: boolean;
      /** What the revoke route answers instead, in the client's own shape. */
      revokeError?: Error;
      /** Let the run finish instead, so the success path is reachable. */
      succeed?: boolean;
      /** Called where the failure happens, while the run is still in flight. */
      atFailure?: () => void;
    } = {},
  ): {
    deps: SetupDeps;
    minted: string[];
    revoked: string[];
    /** The project each revoke named, and every call to the route a sign-in cannot use. */
    revokedIn: string[];
    keyRouteCalls: string[];
  } {
    const minted: string[] = [];
    const revoked: string[] = [];
    const revokedIn: string[] = [];
    const keyRouteCalls: string[] = [];
    const setupApi = fakeSetupApi({
      listProjects: async () => [{ project_id: "p_1", project_name: "demo", workspace_id: "w_1" }],
      createProjectApiKey: async (input) => {
        minted.push(input.name);
        return {
          id: `ak_${minted.length}`,
          name: input.name,
          hint: `tr-hint-${minted.length}`,
          project_id: input.projectId,
          scope: input.scope ?? "ingest",
          expires_at: null,
          key: `tr-${input.scope}-secret-value-${minted.length}`,
        };
      },
      // The route a user's own credential revokes through. The key-authenticated
      // one refuses a sign-in, as the server's does.
      revokeProjectApiKey: async (projectId, id) => {
        if (options.revokeError !== undefined) {
          throw options.revokeError;
        }
        if (options.revokeFails === true) {
          throw new Error("the session was revoked while the run was in flight");
        }
        revoked.push(id);
        revokedIn.push(projectId);
      },
      revokeApiKey: async (id) => {
        keyRouteCalls.push(id);
        throw new SetupApiError("Invalid API key", 401);
      },
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      storedCredential: { session_token: "tru-saved-token" },
    });
    return {
      deps:
        options.succeed === true
          ? deps
          : {
              ...deps,
              resolveSdk: async () => {
                options.atFailure?.();
                throw new Error("the registry refused the request");
              },
            },
      minted,
      revoked,
      revokedIn,
      keyRouteCalls,
    };
  }

  it("revokes both keys the sign-in stage minted, and names them", async () => {
    // The rollback read a list only `acquire_project_key` appended to. Sign-in
    // mints two — the CLI's own credential and the application's — and recorded
    // neither, so a run that signed in and then failed left both live on the
    // project with nothing anywhere marking them as orphaned.
    pythonRepo();
    const { deps, minted, revoked } = signInThenFail();
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(minted).toHaveLength(2);
    expect(revoked).toEqual(["ak_1", "ak_2"]);
    // Named, because "a key" is not something a user can act on: the failure
    // they are reading is about something else, and matching the line to a row
    // in their project's key list is the whole of what makes it useful.
    const said = plain(err.data);
    expect(said).toContain("Revoked the 2 API keys");
    for (const name of minted) {
      expect(said).toContain(name);
    }
    expect(said).toContain("tr-hint-1");
    // Never the key itself, on any path.
    expect(said).not.toContain("secret-value");
  });

  it("says which keys are still live when it cannot revoke them", async () => {
    // A revoke needs the network and a session, which are two of the things
    // that fail in the first place. Claiming a rollback that did not happen
    // would leave the user believing a live key is gone.
    pythonRepo();
    const { deps, revoked } = signInThenFail({ revokeFails: true });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    await runSetupMachine(ctx, deps);

    expect(revoked).toEqual([]);
    const said = plain(err.data);
    expect(said).toContain("could not revoke");
    expect(said).toContain("still live");
    expect(said).toContain("Delete them from the project's API keys");
    expect(said).not.toContain("Revoked the");
    // And they stay in the durable record, because they are still out there.
    expect(ctx.checkpoint.mintedKeys?.map((key) => key.id)).toEqual(["ak_1", "ak_2"]);
  });

  it("revokes them through their project's route, on the credential that minted them", async () => {
    // They went to the key-authenticated route on the user's token, which
    // accepts only an admin API key, so every one of them was reported live.
    pythonRepo();
    const { deps, revoked, revokedIn, keyRouteCalls } = signInThenFail();
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    await runSetupMachine(ctx, deps);

    expect(revoked).toEqual(["ak_1", "ak_2"]);
    expect(revokedIn).toEqual(["p_1", "p_1"]);
    expect(keyRouteCalls).toEqual([]);
    expect(plain(err.data)).not.toContain("still live");
    expect(ctx.checkpoint.mintedKeys).toEqual([]);
  });

  for (const [why, error, advice] of [
    [
      "a deployment without that route",
      new BackendUnavailableError("/api/v1/public/projects/p_1/api-keys/ak_1", 404),
      "they are still live. Delete them from the project's API keys at https://api.example.test.",
    ],
    [
      "a role that may not revoke",
      new SetupApiError("Your role cannot revoke these keys", 403),
      // A member cannot delete them in the dashboard either, so "delete them"
      // would send them somewhere that refuses them again.
      "this account may not revoke keys, so they are still live. A workspace admin has to delete them from the project's API keys at https://api.example.test.",
    ],
  ] as const) {
    it(`still names them as live, and who can delete them where, on ${why}`, async () => {
      pythonRepo();
      const { deps, revoked } = signInThenFail({ revokeError: error });
      const { ctx, err } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

      await runSetupMachine(ctx, deps);

      expect(revoked).toEqual([]);
      expect(plain(err.data)).toContain("could not revoke the 2 API keys traceroot-cli-");
      expect(plain(err.data)).toContain(advice);
      expect(plain(err.data)).not.toContain("Revoked the");
      expect(ctx.checkpoint.mintedKeys?.map((key) => key.id)).toEqual(["ak_1", "ak_2"]);
    });
  }

  it("writes a minted key to disk before the run can lose it", async () => {
    // The case this has to survive is a key minted and then not recorded
    // because the process died, and no in-memory list survives that. So the
    // checkpoint is written at the mint rather than at the end of the stage,
    // and this reads it from disk from inside the run, four stages later.
    pythonRepo();
    // Widened by hand: it is assigned in a callback, which the narrowing of
    // `= null` cannot see, so every read below would otherwise be `never`.
    let midRun = null as ReturnType<typeof readCheckpoint>;
    const { deps } = signInThenFail({
      atFailure: () => {
        midRun = readCheckpoint(dir);
      },
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    await runSetupMachine(ctx, deps);

    expect(midRun?.mintedKeys?.map((key) => key.id)).toEqual(["ak_1", "ak_2"]);
    // The hint and the name, never the key.
    expect(midRun?.mintedKeys?.[0]).toMatchObject({ hint: "tr-hint-1" });
    expect(JSON.stringify(midRun?.mintedKeys)).not.toContain("secret-value");
    // Emptied again by the rollback as it revoked them, which is what leaves
    // the record meaning "still out there" rather than "ever created".
    expect(ctx.checkpoint.mintedKeys).toEqual([]);
  });

  it("empties the record when the run succeeds, since the keys are then in use", async () => {
    // Otherwise the record would say a finished installation's own credentials
    // are orphans, which is the one reading that could get a working key
    // revoked.
    pythonRepo();
    const { deps, minted, revoked } = signInThenFail({ succeed: true });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(minted).toHaveLength(2);
    expect(revoked).toEqual([]);
    expect(ctx.checkpoint.mintedKeys).toEqual([]);
    expect(readCheckpoint(dir)?.mintedKeys).toBeUndefined();
  });

  it("takes its own line out of the project's env file and nothing else", async () => {
    // The file is the project's own, and may be full of things that have
    // nothing to do with TraceRoot. A rollback that rewrote it would be a
    // second, worse bug than the stale line it was clearing.
    pythonRepo();
    const existing = "# the project's own\nDATABASE_URL=postgres://localhost/app\nDEBUG=1\n";
    writeFileSync(join(dir, ".env"), existing, "utf8");
    const { deps } = signInThenFail();
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    await runSetupMachine(ctx, deps);

    // Still there, because the user put it there.
    expect(existsSync(join(dir, ".env"))).toBe(true);
    const after = readFileSync(join(dir, ".env"), "utf8");
    expect(after).not.toContain("TRACEROOT_API_KEY");
    expect(after).toContain("# the project's own");
    expect(after).toContain("DATABASE_URL=postgres://localhost/app");
    expect(after).toContain("DEBUG=1");
  });

  it("takes back a credential it wrote but did not mint", async () => {
    // The env rollback used to be conditional on this run having minted a key,
    // which coupled two unrelated things: the line is just as stale when the
    // key came from `--api-key` or from the sign-in stage, and the stage that
    // writes it does not care where it came from.
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey("tr-the-users-own-key-value"),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const failing: SetupDeps = {
      ...deps,
      resolveSdk: async () => {
        throw new Error("the registry refused the request");
      },
    };
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, failing);

    // Nothing was minted: the key is the user's own, reused as it was found.
    expect(ctx.credential?.keyId).toBeNull();
    expect(result.ok).toBe(false);
    // And the file this run created to hold it is gone again.
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("mints through one function, so a new minting site cannot forget to record", async () => {
    // A guard on the shape of the file rather than on behaviour: the defect was
    // a stage that minted without recording, and no test of a run that *does*
    // record can fail when a new stage is added that does not. The guarantee is
    // that there is one place to go through, so this pins that there is.
    const source = readFileSync(new URL("../../src/setup/machine.ts", import.meta.url), "utf8");
    expect(source.split("api.createProjectApiKey(").length - 1).toBe(1);
    expect(source.split("api.createApiKey(").length - 1).toBe(1);
    // Both inside the one function that records, and nowhere else.
    const chokepoint = source.slice(source.indexOf("async function mintRecordedKey("));
    expect(chokepoint).toContain("api.createProjectApiKey(");
    expect(chokepoint).toContain("api.createApiKey(");
  });
});

describe("how to instrument", () => {
  it("defaults to writing the task file when nobody can be asked", async () => {
    // The important one: an unattended run must never launch something that
    // rewrites the repository. CI must not discover that after the fact.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ canPrompt: false, flags: { agent: undefined } });
    await runSetupMachine(ctx, deps);

    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
    expect(ctx.instrumentation?.mode).toBe("prompt-only");
    expect(ctx.instrumentation?.promptPath).not.toBeNull();
  });

  it("launches the agent when one is named explicitly", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ canPrompt: false, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(1);
  });

  it("prints manual instructions and edits nothing under --manual", async () => {
    pythonRepo();
    const process = fakeRunProcess();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({
      canPrompt: false,
      flags: { agent: "claude", method: "manual" },
    });
    await runSetupMachine(ctx, deps);

    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
    expect(err.data).toContain("Add TraceRoot to");
    expect(err.data).toContain("traceroot==");
    expect(err.data).toContain("traceroot setup --resume");
  });

  it("has the manual steps load the env file it wrote the key into", async () => {
    // The steps used to leave the load out, so an application changed exactly
    // as shown started without its key, and the resume timed out. And they
    // installed with `python3`, which a PEP 668 Python refuses.
    pythonRepo();
    const venvPython = join(dir, ".venv", "bin", "python");
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    writeFileSync(venvPython, "");
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess().run,
    });
    const { ctx, err } = makeCtx({
      canPrompt: false,
      flags: { agent: "claude", method: "manual" },
    });
    await runSetupMachine(ctx, deps);

    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("TRACEROOT_API_KEY=");
    const said = plain(err.data);
    expect(said).toContain(
      `'${venvPython}' -m pip install @traceroot-ai/traceroot==1.2.3 python-dotenv\n`,
    );
    expect(said).toContain('load_dotenv(Path(__file__).resolve().parent / ".env")');
  });

  it("asks when it can, and honours the answer", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      answers: ["task-file"],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    await runSetupMachine(ctx, deps);

    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
    expect(ctx.instrumentation?.promptPath).not.toBeNull();
  });

  /** A PATH carrying real, statable agent binaries, so detection finds them. */
  function withAgentsInstalled(...names: string[]): NodeJS.ProcessEnv {
    mkdirSync(join(dir, "bin"), { recursive: true });
    for (const name of names) {
      const binary = join(dir, "bin", name);
      writeFileSync(binary, "#!/bin/sh\n");
      // Executable, because that is what "installed" means: resolution checks
      // the execute bit, so a plain file here is not an agent anyone could run.
      chmodSync(binary, 0o755);
    }
    return { PATH: join(dir, "bin") };
  }

  /** A PATH with a real, statable `claude` on it, so detection finds one. */
  function withClaudeInstalled(): NodeJS.ProcessEnv {
    return withAgentsInstalled("claude");
  }

  /** Records every question, so the *number* of them can be asserted. */
  function recordingSelect(deps: SetupDeps): {
    deps: SetupDeps;
    asked: Array<{ message: string; options: string[]; labels: string[] }>;
  } {
    const asked: Array<{ message: string; options: string[]; labels: string[] }> = [];
    const inner = deps.select;
    return {
      asked,
      deps: {
        ...deps,
        select: async (input) => {
          asked.push({
            message: input.message,
            options: input.options.map((o) => o.value),
            // The labels as well, because with two runnable agents the value is
            // no longer the whole of what the user reads: the option has to name
            // which agent it means.
            labels: input.options.map((o) => o.label),
          });
          return inner(input);
        },
      },
    };
  }

  it("settles the method and the agent in one question", async () => {
    // These were two prompts — "which coding agent?" and then "how should
    // TraceRoot be added?" — for what is one decision. An installed agent is
    // now a way of answering the second, not a question of its own.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: process.run,
        env: withClaudeInstalled(),
        answers: ["agent:claude"],
      }),
    );
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    const how = asked.find((q) => q.message.includes("How should TraceRoot be added"));
    expect(how?.options).toEqual(["agent:claude", "task-file", "manual"]);
    // Nothing asks which agent afterwards; the answer already said.
    expect(asked.filter((q) => q.message.includes("Which coding agent"))).toEqual([]);
    expect(ctx.agent?.id).toBe("claude");
    expect(ctx.method).toBe("agent");
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(1);
  });

  it("does not offer to run an agent that is not installed", async () => {
    // The old order offered "run a coding agent for me" and then failed on the
    // next line when none was on PATH — an option that was never available,
    // presented as though it were.
    pythonRepo();
    initGit();
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
        env: { PATH: join(dir, "empty-bin") },
        answers: ["task-file"],
      }),
    );
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    const how = asked.find((q) => q.message.includes("How should TraceRoot be added"));
    expect(how?.options).toEqual(["task-file", "manual"]);
  });

  it("names each installed agent in the one question, and launches the one chosen", async () => {
    // Two launchable agents, so the run option cannot say "a coding agent" and
    // leave the user to find out which. One option each, each naming itself,
    // and still no second question about which — that split is the thing this
    // question exists to avoid.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: process.run,
        env: withAgentsInstalled("claude", "codex"),
        answers: ["agent:codex"],
      }),
    );
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    const how = asked.find((q) => q.message.includes("How should TraceRoot be added"));
    // The registry's order, so it is the same on every machine rather than a
    // function of which binary happened to resolve first.
    expect(how?.options).toEqual(["agent:claude", "agent:codex", "task-file", "manual"]);
    expect(how?.labels).toEqual([
      "Run Claude Code for me",
      "Run Codex for me",
      "Write the task — I'll run my own agent",
      "Show me manual instructions",
    ]);
    expect(asked.filter((q) => q.message.includes("Which coding agent"))).toEqual([]);
    expect(ctx.agent?.id).toBe("codex");
    expect(ctx.method).toBe("agent");

    // Launched with Codex's own invocation, not Claude's: the headless
    // subcommand, the sandbox that can write, and the task on stdin.
    const launched = process.runs.find((r) => r.program === "codex");
    expect(launched).toBeDefined();
    expect(launched?.args[0]).toBe("exec");
    expect(launched?.args).toContain("workspace-write");
    expect(launched?.args.at(-1)).toBe("-");
    expect(launched?.stdin).toContain("Instrument this service with TraceRoot");
    expect(launched?.args.join(" ")).not.toContain("--permission-mode");
    // And Claude Code, which is equally installed here, was never started.
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
  });

  it("offers only the installed one when just Codex is there", async () => {
    // One launchable agent means one run option and no follow-up question —
    // the same shape the single-Claude machine gets, with the other name.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: process.run,
        env: withAgentsInstalled("codex"),
        answers: ["agent:codex"],
      }),
    );
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    const how = asked.find((q) => q.message.includes("How should TraceRoot be added"));
    expect(how?.options).toEqual(["agent:codex", "task-file", "manual"]);
    expect(asked.filter((q) => q.message.includes("Which coding agent"))).toEqual([]);
    expect(process.runs.filter((r) => r.program === "codex")).toHaveLength(1);
  });

  it("launches Codex on --agent codex without asking anything", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: process.run,
        env: withAgentsInstalled("claude", "codex"),
      }),
    );
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "codex" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(asked.filter((q) => q.message.includes("How should TraceRoot be added"))).toEqual([]);
    expect(process.runs.filter((r) => r.program === "codex")).toHaveLength(1);
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
    // The suite's fake agent instruments the entry point of whichever agent
    // program is launched, and the instrument stage fails the run when the
    // entry point still has no `initialize()` in it. So reaching `ok` already
    // proves the fake ran for `codex`; this says it in one line rather than
    // leaving it to be inferred from the absence of a failure.
    expect(readFileSync(join(dir, "main.py"), "utf8")).toContain("traceroot.initialize(");
  });

  it("says why it does not offer an installed agent it cannot launch", async () => {
    // `npm i -g` installs Claude Code on Windows as `claude.cmd`, which setup
    // refuses to launch. The run option is left out either way; without a line
    // saying why, it just went missing from a menu the user expected it in.
    pythonRepo();
    initGit();
    mkdirSync(join(dir, "bin"), { recursive: true });
    const shim = join(dir, "bin", "claude.cmd");
    writeFileSync(shim, "", { mode: 0o755 });
    // Detection reads the platform from the process, so Windows is faked for
    // as long as it takes to reach the question, and no longer.
    const realPlatform = Object.getOwnPropertyDescriptor(
      globalThis.process,
      "platform",
    ) as PropertyDescriptor;
    const restorePlatform = () =>
      Object.defineProperty(globalThis.process, "platform", realPlatform);
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
        env: { PATH: join(dir, "bin"), PATHEXT: ".EXE;.CMD" },
        answers: ["task-file"],
      }),
    );
    const select = deps.select;
    deps.select = async (input) => {
      restorePlatform();
      return select(input);
    };
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    Object.defineProperty(globalThis.process, "platform", { ...realPlatform, value: "win32" });
    try {
      await runSetupMachine(ctx, deps);
    } finally {
      restorePlatform();
    }

    const how = asked.find((q) => q.message.includes("How should TraceRoot be added"));
    expect(how?.options).toEqual(["task-file", "manual"]);
    expect(plain(err.data)).toContain(
      `warning: Claude Code is on PATH as a batch shim, ${shim}, which setup cannot launch on Windows. Put the native claude.exe ahead of it on PATH for setup to run it.`,
    );
  });

  it("still launches exactly what --agent names", async () => {
    // The flag is an instruction, and it bypasses the question entirely.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: process.run,
        env: withClaudeInstalled(),
      }),
    );
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    expect(asked.filter((q) => q.message.includes("How should TraceRoot be added"))).toEqual([]);
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(1);
  });
});

describe("the npm cache a Codex run has to write", () => {
  /**
   * Where the fake npm says its cache is: outside the repository, and not
   * `~/.npm`, so a fallback would show. Real, since setup names the real path.
   * It is also the home directory for the test, because only a cache inside
   * the home directory is ever opened to the sandbox.
   */
  let cacheBase: string;
  // Both spellings: `os.homedir()` reads `HOME` on macOS and Linux and
  // `USERPROFILE` on Windows.
  const homeVars = ["HOME", "USERPROFILE"] as const;
  let previousHome: Partial<Record<(typeof homeVars)[number], string>> = {};
  beforeEach(() => {
    cacheBase = realpathSync(mkdtempSync(join(tmpdir(), "tr-npm-cache-")));
    previousHome = {};
    for (const name of homeVars) {
      previousHome[name] = process.env[name];
      process.env[name] = cacheBase;
    }
  });
  afterEach(() => {
    for (const name of homeVars) {
      const previous = previousHome[name];
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
    rmSync(cacheBase, { recursive: true, force: true });
  });

  /** A JavaScript service, with the lockfile that names its package manager. */
  function nodeRepo(lockfile: string): void {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { express: "^4" } }),
    );
    writeFileSync(join(dir, lockfile), "{}\n");
    writeFileSync(join(dir, "index.js"), "console.log('hi');\n");
  }

  async function runWith(agent: "claude" | "codex", entryPoint: string, npmCache: string) {
    initGit();
    const process = fakeRunProcess({
      gitStatus: ["", ` M ${entryPoint}`],
      results: { npm: { output: `${npmCache}\n` } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ flags: { agent } });
    const result = await runSetupMachine(ctx, deps);
    const cacheQueries = process.runs.filter(
      (r) => r.program === "npm" && r.args.slice(0, 3).join(" ") === "config get cache",
    );
    const launched = process.runs.find((r) => r.program === agent);
    return { result, runs: process.runs, cacheQueries, launched, stderr: plain(err.data) };
  }

  it("names npm's own cache to Codex as a directory it may write", async () => {
    // A recorded run had `npm install` fail with EPERM on `~/.npm/_cacache`
    // under Codex's sandbox, and nothing was instrumented until it was named.
    nodeRepo("package-lock.json");
    const cache = join(cacheBase, "npm-cache");
    mkdirSync(join(cache, "_cacache"), { recursive: true });
    writeFileSync(join(cache, "_cacache", "index"), "kept");
    const { result, runs, cacheQueries, launched } = await runWith("codex", "index.js", cache);

    expect(result.error).toBeNull();
    expect(cacheQueries).toHaveLength(1);
    // Asked from the home directory, so the project's `.npmrc` has no say.
    expect(cacheQueries[0]?.cwd).toBe(cacheBase);
    // Asked before the agent starts, so the answer can be in its argv.
    const queried = runs.findIndex((r) => r.program === "npm");
    expect(queried).toBeGreaterThanOrEqual(0);
    expect(queried).toBeLessThan(runs.findIndex((r) => r.program === "codex"));
    expect(launched?.args.slice(-3)).toEqual(["--add-dir", cache, "-"]);
    // An existing cache is used as it is.
    expect(readFileSync(join(cache, "_cacache", "index"), "utf8")).toBe("kept");
  });

  it("creates a cache that does not exist yet, since the sandboxed npm cannot", async () => {
    // A fresh machine has no cache until npm's first run, which is the
    // sandboxed one. Codex takes a missing `--add-dir` silently, and on Linux
    // drops it, so the directory has to exist before the launch.
    nodeRepo("package-lock.json");
    const cache = join(cacheBase, "fresh-home", ".npm");
    const { result, launched, stderr } = await runWith("codex", "index.js", cache);

    expect(result.error).toBeNull();
    expect(existsSync(cache)).toBe(true);
    expect(launched?.args.slice(-3)).toEqual(["--add-dir", cache, "-"]);
    expect(stderr).not.toContain("npm's cache directory");
  });

  it("launches without the cache, and says so once, when it cannot be created", async () => {
    nodeRepo("package-lock.json");
    // A file where a parent directory of the cache would have to be.
    writeFileSync(join(cacheBase, "blocker"), "");
    const cache = join(cacheBase, "blocker", ".npm");
    const { result, launched, stderr } = await runWith("codex", "index.js", cache);

    expect(result.error).toBeNull();
    expect(launched?.args).not.toContain("--add-dir");
    expect(launched?.args.at(-1)).toBe("-");
    // One line, whole. Matched from `warning:` on, so the glyph in front of it
    // can be whatever the terminal supports.
    const said = stderr.split("\n").filter((line) => line.includes("npm's cache directory"));
    expect(said).toHaveLength(1);
    expect(said[0]?.slice(said[0].indexOf("warning:"))).toBe(
      `warning: could not create npm's cache directory ${cache}, so Codex starts without it and \`npm install\` may fail`,
    );
  });

  it("names ~/.npm instead of a cache npm puts outside the home directory", async () => {
    // A cache at `/` opened the whole disk to a run with the network on and no
    // approval prompts.
    nodeRepo("package-lock.json");
    const { result, launched } = await runWith("codex", "index.js", "/");

    expect(result.error).toBeNull();
    expect(launched?.args.slice(-3)).toEqual(["--add-dir", join(cacheBase, ".npm"), "-"]);
  });

  it("asks npm nothing and adds nothing for a Python service", async () => {
    // pip needed nothing in the recorded runs.
    pythonRepo();
    const cache = join(cacheBase, ".npm");
    const { cacheQueries, launched } = await runWith("codex", "main.py", cache);

    expect(launched).toBeDefined();
    expect(cacheQueries).toEqual([]);
    expect(launched?.args).not.toContain("--add-dir");
    expect(existsSync(cache)).toBe(false);
  });

  it("adds nothing for a package manager no Codex run has been recorded on", async () => {
    // pnpm keeps its store somewhere else entirely, and naming npm's cache for
    // it would be a guess that looks like a fix.
    nodeRepo("pnpm-lock.yaml");
    const cache = join(cacheBase, ".npm");
    const { cacheQueries, launched } = await runWith("codex", "index.js", cache);

    expect(launched).toBeDefined();
    expect(cacheQueries).toEqual([]);
    expect(launched?.args).not.toContain("--add-dir");
    expect(existsSync(cache)).toBe(false);
  });

  it("leaves a Claude Code run on npm exactly as it was", async () => {
    // Its recorded npm runs wrote the cache with nothing named. So it does not
    // ask npm, creates nothing, and its argv gains nothing.
    nodeRepo("package-lock.json");
    const cache = join(cacheBase, ".npm");
    const { result, cacheQueries, launched } = await runWith("claude", "index.js", cache);

    expect(result.error).toBeNull();
    expect(launched).toBeDefined();
    expect(cacheQueries).toEqual([]);
    expect(launched?.args).not.toContain("--add-dir");
    expect(launched?.args.join(" ")).not.toContain(cache);
    expect(existsSync(cache)).toBe(false);
  });
});

describe("the last word before an agent edits the code", () => {
  /** Records every question asked, so the prompt itself can be inspected. */
  function askingDeps(answers: string[]) {
    const asked: Array<{ message: string; options: string[]; initial?: string }> = [];
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      answers,
    });
    const inner = deps.select;
    deps.select = async (input) => {
      asked.push({
        message: input.message,
        options: input.options.map((o) => o.value),
        initial: input.initialValue,
      });
      return inner(input);
    };
    return { deps, process, asked };
  }

  it("stops once to say what is about to happen, defaulting to confirm", async () => {
    pythonRepo();
    initGit();
    const { deps, process, asked } = askingDeps([]);
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    const confirm = asked.find((q) => q.message.includes("Proceed?"));
    expect(confirm?.message).toContain("permission to edit files in this repository");
    expect(confirm?.options).toEqual(["confirm", "abort"]);
    // The user already chose to run an agent; this is a checkpoint on that
    // decision, not a second asking of it.
    expect(confirm?.initial).toBe("confirm");
    expect(result.ok).toBe(true);
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(1);
  });

  it("does not overstate what the agent is allowed to do", async () => {
    // The invocation runs with edits accepted and the agent's normal approval
    // flow otherwise — never a bypass-all switch. Claiming otherwise in the one
    // prompt whose job is to be believed would be the worst place to round up.
    pythonRepo();
    initGit();
    const { deps, asked } = askingDeps([]);
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const confirm = asked.find((q) => q.message.includes("Proceed?"));
    expect(confirm?.message).not.toContain("full permissions");
  });

  it("changes nothing when aborted, and says how to get the task anyway", async () => {
    pythonRepo();
    initGit();
    const { deps, process } = askingDeps(["abort"]);
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CANCELLED");
    expect(result.error?.exitCode).toBe(0);
    expect(result.error?.remedy).toContain("--no-instrument");
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
    expect(ctx.instrumentation).toBeUndefined();
  });

  it("asks nothing on the routes that edit nothing", async () => {
    pythonRepo();
    initGit();
    const { deps, asked } = askingDeps(["task-file"]);
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    await runSetupMachine(ctx, deps);

    expect(ctx.instrumentation?.mode).toBe("prompt-only");
    expect(asked.filter((q) => q.message.includes("Proceed?"))).toEqual([]);
  });

  it("never asks a run that has nobody to ask", async () => {
    // An unattended run resolves to writing a task file, so it never gets here
    // — and must not acquire a prompt that would hang CI.
    pythonRepo();
    initGit();
    const { deps, asked, process } = askingDeps([]);
    const { ctx } = makeCtx({ canPrompt: false, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(1);
  });
});

describe("watching the agent work", () => {
  /** One line of Claude Code's `--output-format stream-json` feed. */
  const toolUse = (name: string, input: Record<string, unknown>): string =>
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } })}\n`;

  it("runs the agent captured even for a user sitting at a terminal", async () => {
    // The wizard's own interface used to vanish for the longest step of the
    // run. It does not any more: the agent never gets the terminal.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const launch = process.runs.find((r) => r.program === "claude");
    expect(launch?.args).toContain("--output-format");
    expect(launch?.args).toContain("stream-json");
    // The task travels on stdin, which only the captured invocation does.
    expect(launch?.stdin).toContain("TraceRoot");
    expect(ctx.instrumentation?.mode).toBe("background");
  });

  it("tells the agent it cannot ask questions, because it no longer can", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const launch = process.runs.find((r) => r.program === "claude");
    expect(launch?.stdin).toContain("running non-interactively");
    expect(launch?.stdin).not.toContain("ask the user");
  });

  it("renders one line per tool call, on the rail, naming the agent above it", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: {
        claude: {
          output: [
            toolUse("Bash", { command: "ls -la /repo" }),
            toolUse("Read", { file_path: "main.py" }),
            toolUse("Write", { file_path: "main.py" }),
          ].join(""),
        },
      },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    const shown = plain(err.data).split("\n");
    // Writing into a sink with no cursor, so the feed is a log: every line was
    // flushed as it arrived and none of them can be taken back. That is the
    // right answer here — a CI log is read after the fact — and it is why the
    // collapse is the terminal's behaviour rather than the machine's.
    expect(shown).toContain("│  run: ls -la /repo");
    expect(shown).toContain("│  read: main.py");
    expect(shown).toContain("│  write: main.py");
    // The feed opens on the agent's first real action. There is no
    // "Starting agent..." above it: the spinner underneath already says the
    // agent is running, and that row was the one the clear could strand.
    expect(err.data).not.toContain("Starting agent");
    // One settled line closes the step, and it names the agent rather than the
    // abstraction. What changed is `git diff`'s business and the report's.
    expect(shown).toContain("◆  Claude Code finished.");
    expect(shown.indexOf("│  write: main.py")).toBeLessThan(
      shown.indexOf("◆  Claude Code finished."),
    );
    expect(err.data).not.toContain("changed 1 file(s)");
  });

  it("does not stream at all under --json", async () => {
    // stdout is an event stream there and nobody watches stderr animate, so the
    // parse is not even paid for.
    pythonRepo();
    initGit();
    let streamed = false;
    const inner = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: async (o) => {
        if (o.program === "claude" && o.onData !== undefined) {
          streamed = true;
        }
        return inner.run(o);
      },
    });
    const { ctx } = makeCtx({ json: true, canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    expect(streamed).toBe(false);
  });
});

describe("who the instrumentation task is written for", () => {
  // One task, two readers. Setup's own agent runs captured, under permissions
  // the launch sets, in an environment `buildAgentEnv` builds and in the
  // service directory. The task file is for an agent the user opens, where none
  // of that holds. Both read out of real runs, so the route each task took is
  // the one under test.

  /** A Python service in `api/`, below the repository root. */
  function apiService(): void {
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(join(dir, "api", "pyproject.toml"), '[project]\ndependencies = ["fastapi"]\n');
    writeFileSync(join(dir, "api", "main.py"), "print('hi')\n");
  }

  const services = [
    { name: "a root service", make: pythonRepo, service: undefined, changed: " M main.py" },
    { name: "a service in api/", make: apiService, service: "api", changed: " M api/main.py" },
  ] as const;

  /** What setup wrote for the user's own agent, and what it said about it. */
  async function taskFile(service: string | undefined): Promise<{ task: string; said: string }> {
    // `.claude/` makes the hand-over name Claude Code, as in the reproduction.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1, service } });
    const result = await runSetupMachine(
      ctx,
      makeDeps({ auth: authWithKey(), traces: [], runProcess: fakeRunProcess().run }),
    );
    expect(result.error).toBeNull();
    return {
      task: readFileSync(join(dir, ".traceroot", "prompts", "setup-instrument.md"), "utf8"),
      said: plain(err.data),
    };
  }

  /** The task setup launched Claude Code with, and the launch itself. */
  async function launched(
    service: string | undefined,
    changed: string,
  ): Promise<{ task: string; launch: RecordedRun }> {
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", changed] });
    const { ctx } = makeCtx({ flags: { agent: "claude", service } });
    const result = await runSetupMachine(
      ctx,
      makeDeps({ auth: authWithKey(), traces: [traceRow()], runProcess: process.run }),
    );
    expect(result.error).toBeNull();
    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    return { task: launch?.stdin ?? "", launch: launch as RecordedRun };
  }

  for (const { name, make, service, changed } of services) {
    it(`writes the task file for an agent the user runs, for ${name}`, async () => {
      make();
      const { task, said } = await taskFile(service);

      expect(task).toContain("ask the user");
      expect(task).not.toContain("cannot ask questions");
      expect(task).not.toContain("Your permissions are already set");
      // The env file this run wrote holds the key, and nothing took it out of
      // the user's own environment, so the task says only that the file does.
      expect(task).toContain("A file the application loads holds `TRACEROOT_API_KEY`");
      expect(task).not.toContain("already set in your environment");
      expect(task).not.toContain("**not** in your environment");
      expect(task).not.toContain("**your** environment");
      expect(task).not.toContain("skills install");

      if (service === undefined) {
        expect(task).not.toContain("Work from");
        expect(said).toContain("Run it in Claude Code, then rerun");
      } else {
        // The task's commands and paths are relative to `api/`, and the user
        // ran setup from the root. The task file is at the root, so the agent
        // they open in `api/` is pointed at it from there.
        expect(task).toContain("Work from `api`");
        expect(said).toContain(
          `Open Claude Code in api/ and run ${join("..", ".traceroot", "prompts", "setup-instrument.md")} there, then rerun`,
        );
      }
    });

    it(`launches setup's own agent with the task written for it, for ${name}`, async () => {
      make();
      const { task, launch } = await launched(service, changed);

      expect(launch.cwd).toBe(service === undefined ? dir : join(dir, service));
      expect(task).toContain("You are running non-interactively and cannot ask questions.");
      expect(task).toContain("Your permissions are already set for this task");
      // `buildAgentEnv` withholds the key whenever a file holds it, and the
      // task says that once.
      expect(task).toContain("`TRACEROOT_API_KEY` is **not** in your environment");
      expect(launch.env.TRACEROOT_API_KEY).toBeUndefined();
      expect(task).not.toContain("**your** environment");
      expect(task).not.toMatch(/ask the user|stop and ask/);
      expect(task).not.toContain("Work from");
      expect(task).not.toContain("skills install");
    });
  }

  it("does not tell the user's agent the key is in its environment when git kept it out of every file", async () => {
    // The tracked-env-file refusal. Setup's own agent gets the key from
    // `buildAgentEnv` then; an agent the user opens gets nothing, because
    // nothing set it in their shell.
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), "# committed by mistake\n");
    const { ctx } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });
    const result = await runSetupMachine(
      ctx,
      makeDeps({
        auth: authWithKey(),
        traces: [],
        runProcess: fakeRunProcess({
          git: (args) => (args.includes("ls-files") ? { output: ".env\n" } : {}),
        }).run,
      }),
    );

    expect(result.error).toBeNull();
    expect(ctx.refusedCredentialEnvFile).toBe(join(dir, ".env"));
    const task = readFileSync(join(dir, ".traceroot", "prompts", "setup-instrument.md"), "utf8");
    expect(task).not.toContain("already set in your environment");
    expect(task).toContain("did not put `TRACEROOT_API_KEY` in a file the application loads");
  });

  /**
   * Every command the task hands over to be run as written: the run line, each
   * fenced shell block, and the check step 5 names. Commands the task names in
   * order to forbid them are not instructions and are left out.
   */
  function commandsTheTaskRuns(task: string): string[] {
    const commands: string[] = [];
    const runLine = /run it with: `([^`]+)`/.exec(task)?.[1];
    if (runLine !== undefined) {
      commands.push(runLine);
    }
    for (const [, block] of task.matchAll(/```bash\n([\s\S]*?)```/g)) {
      for (const line of (block ?? "").split("\n")) {
        commands.push(...line.split(" && ").filter((part) => part.trim() !== ""));
      }
    }
    const check = /1\. Run `([^`]+)` once/.exec(task)?.[1];
    if (check !== undefined) {
      commands.push(check);
    }
    return commands.map((command) => command.trim());
  }

  /** The command prefixes the launch approves, read out of its `Bash(<prefix>:*)` rules. */
  function approvedPrefixes(args: readonly string[]): string[] {
    return args.flatMap((arg) => /^Bash\((.+):\*\)$/.exec(arg)?.[1] ?? []);
  }

  it.each([
    [
      "a Python service with a virtualenv and a test suite",
      () => {
        pythonRepo();
        mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
        writeFileSync(join(dir, ".venv", "bin", "python"), "");
      },
      undefined,
      " M main.py",
    ],
    ["a Python service in api/ with no virtualenv", apiService, "api", " M api/main.py"],
    [
      "a TypeScript service",
      () => {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
        writeFileSync(join(dir, "index.ts"), "export {};\n");
      },
      undefined,
      " M index.ts",
    ],
  ] as const)(
    "allows every program the launched task tells the agent to run, for %s",
    async (_, make, service, changed) => {
      // Both halves from one run: the task the agent was handed and the rules
      // it was launched with. A rule matches the start of a command literally,
      // which is how Claude Code applies it.
      make();
      const { task, launch } = await launched(service, changed);
      const prefixes = approvedPrefixes(launch.args);
      const commands = commandsTheTaskRuns(task);

      expect(commands.length).toBeGreaterThan(1);
      for (const command of commands) {
        const allowed = prefixes.some(
          (prefix) => command === prefix || command.startsWith(`${prefix} `),
        );
        expect({ command, allowed }).toEqual({ command, allowed: true });
      }
      // And the CLI's own commands are named only as things not to run.
      expect(task).not.toContain("skills install");
      const cliCommands = [...task.matchAll(/`(traceroot [^`]+)`/g)]
        .map((match) => match[1])
        .filter((command) => command !== "traceroot setup");
      expect(cliCommands.sort()).toEqual(["traceroot traces get", "traceroot traces list"]);
      expect(task).toContain(
        "Do not query the API yourself — not with\n`traceroot traces list`, not with `traceroot traces get`",
      );
    },
  );
});

describe("--no-instrument", () => {
  it("writes the task and stops short of claiming a trace", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess().run,
    });
    const { ctx, out, err } = makeCtx({
      flags: { agent: "claude", instrument: false, traceTimeoutSec: 1 },
    });
    const result = await runSetupMachine(ctx, deps);

    const taskPath = join(dir, ".traceroot", "prompts", "setup-instrument.md");
    expect(readFileSync(taskPath, "utf8")).toContain("Instrument this service with TraceRoot");
    expect(err.data).toContain("--resume");
    // It did not reach a trace, so it must not print the completion sentence.
    expect(out.data).not.toContain("TraceRoot is connected");
    expect(result.ok).toBe(true);
    expect(result.trace).toBeNull();
  });
});

describe("the agent a hand-over targets", () => {
  /** `.claude/` in the project, which is what Claude Code's adapter looks for. */
  function withClaudeConfigured(): void {
    mkdirSync(join(dir, ".claude"), { recursive: true });
  }

  /** `$CODEX_HOME`, pinned into the fixture by the suite's `beforeEach`. */
  function withCodexConfigured(): string {
    const home = join(dir, "codex-home");
    mkdirSync(home, { recursive: true });
    return home;
  }

  /** Records every question asked, so "it did not ask" is assertable. */
  function askRecorder(deps: SetupDeps): {
    deps: SetupDeps;
    asked: Array<{ message: string; options: string[] }>;
  } {
    const asked: Array<{ message: string; options: string[] }> = [];
    const inner = deps.select;
    return {
      asked,
      deps: {
        ...deps,
        select: async (input) => {
          asked.push({ message: input.message, options: input.options.map((o) => o.value) });
          return inner(input);
        },
      },
    };
  }

  /** A hand-over run: writes the task, edits nothing, stops short of a trace. */
  function handoverDeps(answers: string[] = []): SetupDeps {
    return makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess().run,
      answers,
    });
  }

  const skillInstalled = (...parts: string[]): boolean =>
    existsSync(join(...parts, "traceroot-instrument-repo", "SKILL.md"));

  it("names Codex, and installs the skill in Codex's own directory", async () => {
    // The route that writes a markdown task out drives nothing, so the
    // launchable-agent list has no business narrowing it. This machine has
    // Codex and not Claude Code; being told to run the task in Claude Code is
    // advice about software that is not here.
    pythonRepo();
    const codexHome = withCodexConfigured();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

    await runSetupMachine(ctx, handoverDeps());

    const said = plain(err.data);
    expect(said).toContain("Run it in Codex");
    expect(said).not.toContain("Claude Code");
    expect(ctx.agent?.id).toBe("codex");
    // Codex reads skills from the home directory, not from the repository, so
    // "the right agent" has to mean its path and not merely its name.
    expect(skillInstalled(codexHome, "skills")).toBe(true);
    expect(skillInstalled(dir, ".claude", "skills")).toBe(false);
  });

  it("names Claude Code when that is what is set up", async () => {
    pythonRepo();
    withClaudeConfigured();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

    await runSetupMachine(ctx, handoverDeps());

    const said = plain(err.data);
    expect(said).toContain("Run it in Claude Code");
    expect(said).not.toContain("Codex");
    expect(ctx.agent?.id).toBe("claude");
    expect(skillInstalled(dir, ".claude", "skills")).toBe(true);
  });

  /**
   * `$CODEX_HOME` outside the repository, where a real `~/.codex` is. The
   * suite's own pin sits inside the fixture, which makes Codex's copy of the
   * skill a write into the repository and hides the case these tests are for.
   */
  function withCodexHomeOutsideRepository(): string {
    const home = mkdtempSync(join(tmpdir(), "tr-codex-home-"));
    process.env.CODEX_HOME = home;
    return home;
  }

  it("says where the skill went when Codex keeps it outside the repository", async () => {
    // Codex is detected from the home directory, never from this repository,
    // so a fresh repository on a machine with a leftover `~/.codex` hands over
    // to Codex, and the skill is written into the home directory. Picking
    // Codex is right; doing that without a word is not, because `git diff`
    // will never show the write.
    pythonRepo();
    const home = withCodexHomeOutsideRepository();
    try {
      const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

      await runSetupMachine(ctx, handoverDeps());

      expect(ctx.agent?.id).toBe("codex");
      expect(skillInstalled(home, "skills")).toBe(true);
      // The whole destination, on one line. Matched on its tail, because
      // whether the home directory prints as `~` depends on where the temp
      // directory happens to sit.
      const line = plain(err.data)
        .split("\n")
        .find((l) => l.includes("Installed the TraceRoot skill"));
      expect(line).toContain("Installed the TraceRoot skill for Codex in ");
      expect(line).toContain(
        `${join(basename(home), "skills", "traceroot-instrument-repo")}, outside this repository.`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("names that place in the report's list of touched files", async () => {
    pythonRepo();
    const home = withCodexHomeOutsideRepository();
    try {
      // The task was run in Codex and its trace arrived, so the run reaches
      // the report — which is written only by a run that finishes.
      const deps = makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess().run,
      });
      const { ctx } = makeCtx({ flags: { instrument: false } });

      const result = await runSetupMachine(ctx, deps);

      expect(result.error).toBeNull();
      expect(result.ok).toBe(true);
      const report = readFileSync(join(dir, ".traceroot", "setup-report.md"), "utf8");
      const row = report.split("\n").find((l) => l.includes("The instrumentation skill"));
      expect(row).toContain(`${basename(home)}/skills/traceroot-instrument-repo/\``);
      expect(row).toMatch(/ \| The instrumentation skill, outside this repository\. \|$/);
      // Not the Claude Code directory, which this run never created.
      expect(report).not.toContain(".claude/skills/");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("names the generic agent's own skill directory in the report", async () => {
    // With no agent set up, the skill goes in the tool-neutral `.agents/`, and
    // the report has to say so rather than name Claude Code's directory.
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess().run,
    });
    const { ctx } = makeCtx({ flags: { instrument: false } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(ctx.agent?.id).toBe("generic");
    expect(skillInstalled(dir, ".agents", "skills")).toBe(true);
    const report = readFileSync(join(dir, ".traceroot", "setup-report.md"), "utf8");
    expect(report).toContain(
      "| `.agents/skills/traceroot-instrument-repo/` | The instrumentation skill. |",
    );
    expect(report).not.toContain(".claude/skills/");
  });

  it("says nothing about the skill when it lands inside the repository", async () => {
    // Claude Code's copy goes in `.claude/`, which `git diff` already shows, so
    // the install stays the silent bookkeeping it always was.
    pythonRepo();
    withClaudeConfigured();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

    await runSetupMachine(ctx, handoverDeps());

    expect(ctx.agent?.id).toBe("claude");
    expect(skillInstalled(dir, ".claude", "skills")).toBe(true);
    const said = plain(err.data);
    expect(said).not.toContain("Installed the TraceRoot skill");
    expect(said).not.toContain("outside this repository");
  });

  it("asks which one when both are set up, and honours the answer", async () => {
    pythonRepo();
    withClaudeConfigured();
    const codexHome = withCodexConfigured();
    const { deps, asked } = askRecorder(handoverDeps(["codex"]));
    const { ctx, err } = makeCtx({
      canPrompt: true,
      flags: { instrument: false, traceTimeoutSec: 1 },
    });

    await runSetupMachine(ctx, deps);

    const question = asked.find((q) => q.message.includes("Which coding agent"));
    expect(question?.options).toEqual(["claude", "codex"]);
    expect(ctx.agent?.id).toBe("codex");
    expect(plain(err.data)).toContain("Run it in Codex");
    expect(skillInstalled(codexHome, "skills")).toBe(true);
  });

  it("does not offer the generic fallback it created itself", async () => {
    // `.agents/` is where a hand-over with nothing to name puts the skill, so
    // from the second run onwards the repository has one. Counted as an agent
    // that is "set up here", it raises a second question — the one
    // `chooseInstrumentation` exists to avoid — between a real agent and a
    // category, and answering "Agent (generic)" is then met with "no coding
    // agent is set up here".
    pythonRepo();
    withClaudeConfigured();
    mkdirSync(join(dir, ".agents"), { recursive: true });
    const { deps, asked } = askRecorder(handoverDeps(["generic"]));
    const { ctx, err } = makeCtx({
      canPrompt: true,
      flags: { instrument: false, traceTimeoutSec: 1 },
    });

    await runSetupMachine(ctx, deps);

    expect(asked.filter((q) => q.message.includes("Which coding agent"))).toEqual([]);
    expect(ctx.agent?.id).toBe("claude");
    const said = plain(err.data);
    expect(said).toContain("Run it in Claude Code");
    expect(said).not.toContain("Agent (generic)");
  });

  it("never asks when it cannot, and says what it picked and how to change it", async () => {
    // A `--json` consumer and a CI job have nobody to answer a question, and
    // stdout there belongs to the event stream — so the choice is reported
    // after the fact rather than put to the user.
    pythonRepo();
    withClaudeConfigured();
    withCodexConfigured();
    const { deps, asked } = askRecorder(handoverDeps());
    const { ctx, err } = makeCtx({
      canPrompt: false,
      flags: { instrument: false, traceTimeoutSec: 1 },
    });

    await runSetupMachine(ctx, deps);

    expect(asked.filter((q) => q.message.includes("Which coding agent"))).toEqual([]);
    const said = plain(err.data);
    // Both are named, so the one it did not pick is not invisible.
    expect(said).toContain("Agents set up here: Claude Code, Codex");
    expect(said).toContain("Targeting Claude Code");
    // With the flag that keeps it a hand-over: `--agent` alone launches the
    // agent, with nobody there to confirm it. And by the ids the flag takes,
    // which the list above does not show.
    expect(said).toContain(
      "to target another, rerun with `--no-instrument --agent <id>`, where <id> is one of claude, codex, generic.",
    );
    // And not a word of the question itself.
    expect(said).not.toContain("Which coding agent");
    expect(ctx.agent?.id).toBe("claude");
  });

  it("keeps --manual in the flags that change the target of a manual hand-over", async () => {
    pythonRepo();
    withClaudeConfigured();
    withCodexConfigured();
    const { deps } = askRecorder(handoverDeps());
    const { ctx, err } = makeCtx({
      canPrompt: false,
      flags: { method: "manual", traceTimeoutSec: 1 },
    });

    await runSetupMachine(ctx, deps);

    const said = plain(err.data);
    expect(said).toContain("rerun with `--manual --agent <id>`");
    expect(said).not.toContain("--no-instrument --agent");
  });

  it("keeps the choice out of a --json run's event stream", async () => {
    pythonRepo();
    withClaudeConfigured();
    withCodexConfigured();
    const { deps, asked } = askRecorder(handoverDeps());
    const { ctx, out, err } = makeCtx({
      json: true,
      flags: { instrument: false, traceTimeoutSec: 1 },
    });

    await runSetupMachine(ctx, deps);

    expect(asked).toEqual([]);
    // stdout belongs to the event stream; the note about what was targeted is
    // stderr, like every other thing the run says about itself. Both halves
    // asserted: "not on stdout" alone passes just as well if the note is never
    // printed at all, which would lose the only account of what was picked.
    expect(plain(out.data)).not.toContain("Which coding agent");
    expect(plain(out.data)).not.toContain("Agents set up here");
    expect(plain(err.data)).toContain("Agents set up here: Claude Code, Codex");
    expect(plain(err.data)).toContain("Targeting Claude Code");
    expect(ctx.agent?.id).toBe("claude");
  });

  it("still writes a useful task when no agent is set up at all", async () => {
    // Not a dead end: the markdown is self-contained, so the run says so and
    // puts the skill in the tool-neutral location rather than naming a product
    // this machine has not got.
    pythonRepo();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

    await runSetupMachine(ctx, handoverDeps());

    const taskPath = join(dir, ".traceroot", "prompts", "setup-instrument.md");
    expect(readFileSync(taskPath, "utf8")).toContain("Instrument this service with TraceRoot");
    const said = plain(err.data);
    expect(said).toContain("No coding agent is set up here");
    expect(said).toContain("run it in whichever agent you use");
    expect(said).not.toContain("Run it in Claude Code");
    expect(ctx.agent?.id).toBe("generic");
    expect(skillInstalled(dir, ".agents", "skills")).toBe(true);
  });

  it("obeys --agent over what is on the machine", async () => {
    pythonRepo();
    withClaudeConfigured();
    const codexHome = join(dir, "codex-home");
    const { deps, asked } = askRecorder(handoverDeps());
    const { ctx, err } = makeCtx({
      canPrompt: true,
      flags: { agent: "codex", instrument: false, traceTimeoutSec: 1 },
    });

    await runSetupMachine(ctx, deps);

    expect(asked.filter((q) => q.message.includes("Which coding agent"))).toEqual([]);
    expect(ctx.agent?.id).toBe("codex");
    expect(plain(err.data)).toContain("Run it in Codex");
    expect(skillInstalled(codexHome, "skills")).toBe(true);
  });
});

describe("why no trace arrived", () => {
  /** A Python service with no test or health command for setup to run. */
  function pythonRepoWithoutTests(): void {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi"]\n');
    writeFileSync(join(dir, "main.py"), "print('hi')\n");
  }

  /** The same service, already wired up by hand before setup ever ran. */
  function alreadyInstrumented(): void {
    writeFileSync(
      join(dir, "main.py"),
      'import traceroot\n\nif __name__ == "__main__":\n    traceroot.initialize()\n',
    );
  }

  function traceless(): SetupDeps {
    return makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
  }

  it("ends an un-run hand-over as a pause, not as a program that never ran", async () => {
    // The live failure. `main.py` held zero TraceRoot references and the SDK
    // was not installed, and the run said "nothing has run your application —
    // Run your application once". Running an uninstrumented application again
    // produces the same nothing, so that advice is a loop with no exit; what
    // is outstanding is the instrumentation itself. Nor is it a failure: the
    // user chose to do that part, so the run ends normally and leaves the
    // trace unrecorded for `--resume` to look for.
    pythonRepoWithoutTests();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.trace).toBeNull();
    expect(result.stagesRun.find((s) => s.stage === "verify_trace")?.status).toBe("skipped");
    expect(ctx.checkpoint.lastError).toBeUndefined();
    expect(plain(err.data)).not.toContain("nothing has run your application");
    // Nothing can arrive, so nothing is waited for: no two-minute spinner in
    // front of an answer that was available immediately.
    expect(plain(err.data)).not.toContain("Waiting for your first trace");
  });

  it("pauses the same way when the project has a test command", async () => {
    // A test command changes nothing about uninstrumented code: "the
    // instrumented code path never ran" would still name the wrong one of the
    // two missing halves.
    pythonRepo();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(ctx.stack?.selected?.testCommand).toBe("pytest");
    expect(result.ok).toBe(true);
    expect(result.trace).toBeNull();
    expect(plain(err.data)).not.toContain("Waiting for your first trace");
  });

  it("pauses on the manual route too, with no task file to name", async () => {
    // `--manual` writes no task file, so there is no path to send anyone to.
    pythonRepoWithoutTests();
    const { ctx } = makeCtx({ flags: { method: "manual", traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(result.ok).toBe(true);
    expect(result.trace).toBeNull();
    expect(ctx.instrumentation?.mode).toBe("prompt-only");
    expect(ctx.instrumentation?.promptPath).toBeNull();
  });

  it("keeps the key it installed, which the resume needs", async () => {
    // The pause it replaced kept the key and the env file, and so must this:
    // the next step is the user's application sending a trace with them.
    pythonRepo();
    let revoked = 0;
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
      }),
      traces: [],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [],
        createApiKey: async ({ name }) => ({
          id: "ak_1",
          name,
          hint: "tr-…9999",
          project_id: "p_1",
          scope: "ingest",
          expires_at: null,
          key: "tr-minted-secret-value-42",
        }),
        revokeApiKey: async () => {
          revoked += 1;
        },
      }),
      runProcess: fakeRunProcess().run,
    });
    const { ctx } = makeCtx({ flags: { instrument: false, project: "demo", traceTimeoutSec: 1 } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(result.trace).toBeNull();
    expect(revoked).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("tr-minted-secret-value-42");
  });

  it("does not call a hand-picked repository uninstrumented", async () => {
    // A repository the user instrumented by hand before running setup is the
    // reason this route still reaches the trace stage at all. `detect_stack`
    // saw the initialization, so the hand-over says nothing about whether
    // there is instrumentation here — and the run waits and reports as usual.
    pythonRepo();
    alreadyInstrumented();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(ctx.stack?.existingInstrumentation.present).toBe(true);
    // A real timeout, so it still fails rather than pausing like a hand-over.
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(plain(result.error?.message ?? "")).toContain("No trace arrived within");
    // It really did wait for it, rather than giving up on a verdict it has no
    // grounds for.
    expect(plain(err.data)).toContain("Waiting for your first trace");
  });

  it("keeps a blank line above the wait", async () => {
    // The wait is the one line left moving for up to two minutes, and it sat
    // flush against the verification lines above it — reading as one more of
    // them rather than as the state of the whole run. A rail-only line first,
    // the same way the agent block gets one.
    pythonRepo();
    alreadyInstrumented();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

    await runSetupMachine(ctx, traceless());

    const lines = plain(err.data).split("\n");
    const spinner = lines.findIndex((line) => line.includes("Waiting for your first trace"));
    expect(spinner).toBeGreaterThan(0);
    expect(lines[spinner - 1]?.trim()).toBe("\u2502");
  });

  it("waits for the agent's trace when an agent did the instrumenting", async () => {
    // The other diagnosis has to keep working: here the code *was* changed, and
    // the agent was told to run the application, so a trace can be on its way
    // whether or not there is a test command. The run waits for it and, when
    // none comes, says so as a timeout rather than as an application nothing
    // ran.
    pythonRepoWithoutTests();
    initGit();
    const { ctx, err } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(ctx.instrumentation?.mode).toBe("background");
    expect(result.ok).toBe(false);
    expect(plain(result.error?.message ?? "")).toContain("No trace arrived within");
    expect(plain(result.error?.message ?? "")).not.toContain("nothing has run your application");
    expect(plain(err.data)).toContain("Waiting for your first trace");
  });

  it("pauses again on a resume that finds the hand-over still un-run", async () => {
    // The route a user is on: the first run writes the task and tells them to
    // rerun with `--resume`, so the resumed run is where this has to hold.
    // `--resume` restores the instrument stage from the checkpoint rather
    // than running it again — and a restored hand-over that claimed an agent
    // had edited the code is what sent them back to run an application with no
    // TraceRoot in it, which is the loop this whole route exists to break.
    pythonRepoWithoutTests();
    const first = makeCtx({ flags: { instrument: false, traceTimeoutSec: 120 } });
    await runSetupMachine(first.ctx, traceless());

    const { ctx, err } = makeCtx({
      flags: { instrument: false, traceTimeoutSec: 120, resume: true },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });
    const result = await runSetupMachine(ctx, traceless());

    // Restored as what it was, not as an agent run.
    expect(ctx.instrumentation?.mode).toBe("prompt-only");
    expect(result.ok).toBe(true);
    expect(result.trace).toBeNull();
    expect(plain(err.data)).not.toContain("nothing has run your application");
    expect(plain(err.data)).not.toContain("Waiting for your first trace");
  });

  it("waits for the trace on the resume after the task is applied, and finishes", async () => {
    // The pause records no trace, so the trace stage is unsatisfied on the
    // resume and runs again — this time over code that has TraceRoot in it.
    pythonRepo();
    const first = makeCtx({ flags: { instrument: false, traceTimeoutSec: 120 } });
    const paused = await runSetupMachine(first.ctx, traceless());
    expect(paused.ok).toBe(true);
    expect(paused.trace).toBeNull();

    // What the user's own agent did with the task.
    alreadyInstrumented();
    const { ctx, err } = makeCtx({
      flags: { instrument: false, traceTimeoutSec: 120, resume: true },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });
    const result = await runSetupMachine(
      ctx,
      makeDeps({
        auth: authWithKey(),
        traces: [traceRow()],
        runProcess: fakeRunProcess().run,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.trace?.traceUrl).toBe("https://app.example.test/trace/t_1");
    expect(plain(err.data)).toContain("Waiting for your first trace");
    expect(readCheckpoint(dir)?.trace?.traceId).toBe("t_1");
    expect(existsSync(join(dir, ".traceroot", "setup-report.md"))).toBe(true);
  });

  it("does not read a checkpoint with no recorded route as an agent run", async () => {
    // Every route records which one it took, so a completed stage without one
    // is a file something other than setup has edited. Absence must not be read
    // as "an agent ran" — read that way it restores a result claiming the code
    // was edited, which is the misdiagnosis above, back again and silent. There
    // is nothing to restore it from, so the stage runs instead and records what
    // it did this time.
    pythonRepoWithoutTests();
    const first = makeCtx({ flags: { instrument: false, traceTimeoutSec: 120 } });
    await runSetupMachine(first.ctx, traceless());

    // The same checkpoint with the route taken out of it.
    const legacy = readCheckpoint(dir);
    if (legacy !== null) {
      legacy.instrumentHandover = undefined;
    }

    const { ctx, err } = makeCtx({
      flags: { instrument: false, traceTimeoutSec: 120, resume: true },
      resumeFrom: legacy ?? undefined,
    });
    const result = await runSetupMachine(ctx, traceless());

    expect(ctx.instrumentation?.mode).toBe("prompt-only");
    expect(ctx.checkpoint.instrumentHandover).toBe("task-file");
    expect(result.ok).toBe(true);
    expect(plain(err.data)).not.toContain("nothing has run your application");
  });
});

describe("letting the user stop waiting for the first trace", () => {
  /** A Python service with no test or health command for setup to run. */
  function uninstrumentable(): void {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi"]\n');
    writeFileSync(join(dir, "main.py"), "print('hi')\n");
  }

  /** A repository whose entry point is already instrumented, so a trace could arrive. */
  function waitable(): void {
    pythonRepo();
    writeFileSync(
      join(dir, "main.py"),
      'import traceroot\n\nif __name__ == "__main__":\n    traceroot.initialize()\n',
    );
  }

  /** A run where no trace ever turns up, so only the waiting is under test. */
  function traceless(options: { skip?: boolean } = {}): SetupDeps {
    return makeDeps({
      auth: authWithKey(),
      traces: [],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      skipTraceWait: options.skip,
    });
  }

  it("finishes the run successfully when the user stops waiting", async () => {
    // The point of the whole change: the browser page is already watching for
    // this trace, so a blocked terminal adds nothing a user can act on — and
    // stopping the wait must be a finished run, not a failed one.
    waitable();
    const { ctx, err } = makeCtx({
      canPrompt: true,
      flags: { instrument: false, traceTimeoutSec: 120 },
    });

    const result = await runSetupMachine(ctx, traceless({ skip: true }));

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.trace).toBeNull();
    expect(ctx.traceWaitSkipped).toBe(true);
    // Said as a stop, not as a timeout: nothing ran out.
    const said = plain(err.data);
    expect(said).toContain("Stopped waiting for your first trace.");
    expect(said).not.toContain("No trace after");
    // And none of the three diagnoses of a wait that *did* run out.
    expect(said).not.toContain("this service is not instrumented");
    expect(said).not.toContain("nothing has run your application");
    expect(said).not.toContain("No trace arrived within");
  });

  it("records the stop on the checkpoint, but --resume still waits again", async () => {
    // The checkpoint's record is for `doctor` and the next `setup`. A run that
    // inherited it would close with a sentence about a key nobody pressed, so
    // the resume waits afresh, and clears the record when that wait ends some
    // other way.
    waitable();
    const first = makeCtx({
      canPrompt: true,
      flags: { instrument: false, traceTimeoutSec: 120 },
    });
    const stopped = await runSetupMachine(first.ctx, traceless({ skip: true }));

    expect(stopped.checkpoint.trace).toBeUndefined();
    expect(readCheckpoint(dir)?.traceWaitSkipped).toBe(true);

    const second = makeCtx({
      canPrompt: true,
      flags: { instrument: false, resume: true, traceTimeoutSec: 1 },
      resumeFrom: readCheckpoint(dir) ?? undefined,
    });
    const resumed = await runSetupMachine(second.ctx, traceless());

    expect(plain(second.err.data)).toContain("Waiting for your first trace");
    expect(second.ctx.traceWaitSkipped).toBeUndefined();
    expect(resumed.error?.code).toBe("TRACE_TIMEOUT");
    expect(readCheckpoint(dir)?.traceWaitSkipped).toBeUndefined();
  });

  it("offers the skip on the waiting line, where there is somebody to press it", async () => {
    waitable();
    const { err } = await (async () => {
      const made = makeCtx({
        canPrompt: true,
        flags: { instrument: false, traceTimeoutSec: 1 },
      });
      await runSetupMachine(made.ctx, traceless());
      return made;
    })();

    expect(plain(err.data)).toContain("Enter to stop waiting");
  });

  it("says nothing about a key when there is nobody at a terminal", async () => {
    // A CI job, a pipe, `--no-input`. The offer would be an instruction to
    // press something that is not being listened for.
    waitable();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 1 } });

    const result = await runSetupMachine(ctx, traceless({ skip: true }));

    const said = plain(err.data);
    expect(said).toContain("Waiting for your first trace");
    expect(said).not.toContain("Enter to stop waiting");
    // And the skip was never even offered, so the wait ran out as it always did.
    expect(ctx.traceWaitSkipped).toBeUndefined();
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
  });

  it("does not offer to skip a wait that is not happening", async () => {
    // `canArrive === false`: the service is not instrumented and nothing can
    // arrive, so the poll takes one look and returns. Offering to stop a wait
    // that is not running would be an instruction to press a key that does
    // nothing — and the short-circuit itself must survive.
    uninstrumentable();
    const { ctx, err } = makeCtx({
      canPrompt: true,
      flags: { instrument: false, traceTimeoutSec: 120 },
    });

    const result = await runSetupMachine(ctx, traceless({ skip: true }));

    const said = plain(err.data);
    expect(said).not.toContain("Waiting for your first trace");
    expect(said).not.toContain("Enter to stop waiting");
    // The hand-over's own ending, unchanged: no two-minute spinner in front of
    // an answer that was available immediately, and a pause rather than a wait
    // the user stopped.
    expect(result.ok).toBe(true);
    expect(result.trace).toBeNull();
    expect(ctx.traceWaitSkipped).toBeUndefined();
  });

  it("prefers a trace that landed while the key was being pressed", async () => {
    // The press and the request in flight race, and the trace is the stronger
    // answer: a run that saw one must report it rather than closing on "not
    // seen yet" because the keystroke won by a millisecond.
    waitable();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    let press: (() => void) | null = null;
    deps.watchForSkip = (onSkip) => {
      press = onSkip;
      return () => undefined;
    };
    // The press lands while the response that carries the trace is in flight:
    // the read is already answered, and the poll has not looked at it yet.
    // Staging it any earlier would not be the race — it would be a user who
    // stopped waiting before the trace existed, which is the case above.
    let pressedDuringRead = false;
    const createApi = deps.createSetupApi;
    deps.createSetupApi = (options) => {
      const api = createApi(options);
      return {
        ...api,
        // Typed as the poll calls it: `pollForTrace` reads through
        // `TraceLister`.
        listTraces: async (params: Parameters<TraceLister["listTraces"]>[0]) => {
          const response = await api.listTraces(params);
          // The press has to land on the read that carries THIS run's trace.
          // `listTraces` answers with the real `{ data, meta }` envelope, so
          // measuring the envelope's own `length` was `undefined > 0` — false
          // on every call, the key never pressed, and the test quietly became
          // the plain success path above. Every read is the same look at the
          // traces since setup started, so the first one that returns the
          // trace is the read to press on.
          if (response.data.length > 0) {
            pressedDuringRead = true;
            press?.();
          }
          return response;
        },
      } as SetupApi;
    };

    const { ctx, err } = makeCtx({
      canPrompt: true,
      flags: { instrument: false, traceTimeoutSec: 120 },
    });
    const result = await runSetupMachine(ctx, deps);

    // First, that the race was staged at all: without this the assertions below
    // are the ordinary "a trace arrived" path, and the precedence they are
    // here for is never exercised.
    expect(pressedDuringRead).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.trace).not.toBeNull();
    expect(ctx.traceWaitSkipped).toBeUndefined();
    expect(plain(err.data)).toContain("First trace received");
  });

  it("neither offers nor mentions a skip in --json", async () => {
    // stdout belongs to the event stream there, and a machine consumer has
    // nobody to ask. The run has to behave exactly as it did before this
    // existed, down to the absence of a frame for the waiting line to sit in.
    waitable();
    const { ctx, out, err } = makeCtx({
      json: true,
      flags: { instrument: false, traceTimeoutSec: 1 },
    });

    const result = await runSetupMachine(ctx, traceless({ skip: true }));

    for (const stream of [out.data, err.data]) {
      expect(stream).not.toContain("Enter to stop waiting");
      expect(stream).not.toContain("Stopped waiting");
      expect(stream).not.toContain("Waiting for your first trace");
    }
    expect(ctx.traceWaitSkipped).toBeUndefined();
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
  });
});

describe("how long setup waits for the first trace", () => {
  /** A trace read that answers with `rows` as they stand, counting every look. */
  function countingTraces(rows: unknown[] = []): {
    traces: () => unknown[];
    looks: () => number;
  } {
    let looks = 0;
    const traces = () => {
      looks += 1;
      return rows;
    };
    return { traces, looks: () => looks };
  }

  it("waits the full budget after the agent ran, even with no test command", async () => {
    // The agent is told to run the application, and its trace reaches the list
    // seconds after that run. Waiting used to key off setup's own check having
    // run, so a repository with no test command took one look straight after
    // the agent finished and reported "nothing has run your application" over
    // a trace that was a moment from arriving.
    writeFileSync(join(dir, "requirements.txt"), "flask\n");
    writeFileSync(join(dir, "app.py"), "x = 1\n");
    const { traces, looks } = countingTraces();
    const deps = makeDeps({
      auth: authWithKey(),
      traces,
      runProcess: fakeRunProcess({ gitStatus: ["", "", " M app.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 5 } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(result.error?.message).toMatch(/^No trace arrived within \ds\./);
    expect(looks()).toBeGreaterThan(1);
  });

  it("takes one look when nothing could send a trace", async () => {
    // A route that hands the task over instruments nothing, so nothing in this
    // run can send a trace. A test command used to buy a full wait here anyway:
    // two minutes of a spinner for a trace nothing could produce. The look
    // finds nothing, and the hand-over ends as the pause it is.
    pythonRepo();
    const { traces, looks } = countingTraces();
    const deps = makeDeps({
      auth: authWithKey(),
      traces,
      runProcess: fakeRunProcess().run,
    });
    const { ctx, err } = makeCtx({
      flags: { agent: "claude", instrument: false, traceTimeoutSec: 5 },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(looks()).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.stagesRun.find((s) => s.stage === "verify_trace")?.status).toBe("skipped");
    expect(plain(err.data)).not.toContain("Waiting for your first trace");
  });

  /** A TypeScript service whose entry point detection reads. */
  function typescriptRepo(): void {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "svc", main: "src/index.ts", dependencies: { express: "^4" } }),
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "console.log('hi');\n");
  }

  it.each([
    [
      "in a module the entry point imports",
      pythonRepo,
      {
        "main.py": "import tracing\n\nprint('hi')\n",
        "tracing.py": "import traceroot\n\ntraceroot.initialize()\n",
      },
    ],
    [
      "as a TypeScript `initialize({...})`",
      typescriptRepo,
      {
        "src/index.ts":
          'import { initialize } from "@traceroot-ai/traceroot";\n\ninitialize({ integrations: [] });\n',
      },
    ],
    [
      "with no entry point detection knows",
      pythonRepo,
      { "main.py": null, "worker.py": "import traceroot\n\ntraceroot.initialize()\n" },
    ],
  ])(
    "waits the full budget on a resume after the agent ran, initialization %s",
    async (_, repo, layout) => {
      // The resume a trace timeout asks for: run the application, then
      // `--resume`. No agent runs in this process, and detection reads only the
      // entry point, so it cannot see these layouts. Waiting keyed off the agent
      // having been launched in this process, so the resume took one look and
      // said nothing had run the application.
      repo();
      const traceless = () => makeDeps({ auth: authWithKey(), runProcess: fakeRunProcess().run });
      const first = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });
      const firstResult = await runSetupMachine(first.ctx, traceless());
      expect(firstResult.error?.message).toContain("No trace arrived within");
      for (const [file, content] of Object.entries(layout)) {
        if (content === null) {
          rmSync(join(dir, file));
        } else {
          writeFileSync(join(dir, file), content);
        }
      }

      const { traces, looks } = countingTraces();
      const { ctx, err } = makeCtx({
        flags: { agent: "claude", traceTimeoutSec: 5, resume: true },
        resumeFrom: readCheckpoint(dir) ?? undefined,
      });
      const result = await runSetupMachine(ctx, {
        ...traceless(),
        createSetupApi: makeDeps({ traces }).createSetupApi,
      });

      expect(ctx.stack?.existingInstrumentation.present).toBe(false);
      expect(looks()).toBeGreaterThan(1);
      expect(result.error?.code).toBe("TRACE_TIMEOUT");
      expect(result.error?.message).toMatch(/^No trace arrived within \ds\./);
      expect(plain(err.data)).toContain("Waiting for your first trace");
    },
  );

  it("waits the full budget for a service that already carries TraceRoot", async () => {
    // Whoever runs an instrumented application next sends a trace — the user,
    // on a resume after instrumenting by hand, or here a repository that was
    // wired up before setup arrived — so there is something to wait for even
    // though setup launched nothing.
    pythonRepo();
    writeFileSync(join(dir, "main.py"), "import traceroot\n\ntraceroot.initialize()\n");
    const { traces, looks } = countingTraces();
    const deps = makeDeps({
      auth: authWithKey(),
      traces,
      runProcess: fakeRunProcess().run,
    });
    const { ctx } = makeCtx({
      flags: { agent: "claude", instrument: false, traceTimeoutSec: 5 },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.existingInstrumentation.present).toBe(true);
    expect(result.error?.message).toMatch(/^No trace arrived within \ds\./);
    expect(looks()).toBeGreaterThan(1);
  });
});

describe("the first trace is the application's", () => {
  /** A trace row stamped now, the way the SDK stamps the traces it sends. */
  function sent(id: string, name: string, spans: number, at: number = Date.now()) {
    return {
      trace_id: id,
      trace_url: `https://app.example.test/trace/${id}`,
      trace_start_time: new Date(at).toISOString(),
      name,
      span_count: spans,
    };
  }

  /** The run's own clock, so the rows the fakes stamp fall after setup started. */
  function freshCtx(flags: Partial<SetupFlags> = {}) {
    return makeCtx({
      flags: { agent: "claude", ...flags },
      resumeFrom: newCheckpoint(new Date(Date.now() - 60_000)),
    });
  }

  it("opens the application's trace, not traffic that lands after it", async () => {
    // The run this replays. The agent ran the application, which sent one
    // trace of twenty-one spans, and then six traces landed — there, a test
    // suite exporting under the project's key; here, traffic that arrives
    // whatever setup does. The poll searched a window that opened after the
    // application's trace, took the earliest trace in it, and opened a
    // one-span unit test of `calculate` as "your first trace".
    pythonRepo();
    const rows: unknown[] = [];
    const inner = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const runProcess: SetupDeps["runProcess"] = async (o) => {
      // The agent's run takes real time: the application it runs sends its
      // trace partway through, and the burst lands after it.
      if (o.program === "claude") {
        const started = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
        rows.unshift(sent("app", "demo.run", 21, started + 5));
        for (const [i, name] of [
          "calculate",
          "calculate",
          "agent.execute_tool",
          "agent.run",
        ].entries()) {
          rows.unshift(sent(`burst-${i}`, name, i < 3 ? 1 : 4, started + 10));
        }
      }
      return inner.run(o);
    };
    const deps = makeDeps({
      auth: authWithKey(),
      traces: () => rows,
      runProcess,
    });
    const { ctx, err } = freshCtx();

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(ctx.trace?.traceId).toBe("app");
    // The burst is counted beside it, as information: five traces since setup
    // started is not, on its own, a reason to doubt the first.
    expect(plain(err.data)).toContain(
      "First trace received (21 spans) — first of 5 since setup started.",
    );
    expect(plain(err.data)).not.toContain("may not come from this service");
  });
});

describe("JSON mode", () => {
  it("emits typed stage events and a final result with no secrets", async () => {
    pythonRepo();
    const secret = "tr-live-project-key-abcd";
    const deps = makeDeps({
      auth: authWithKey(secret),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx, events } = makeCtx({ json: true, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);

    const final = events.at(-1);
    expect(final?.event).toBe("result");
    expect(final).toMatchObject({
      ok: true,
      data: { trace_url: "https://app.example.test/trace/t_1", project_name: "demo" },
    });

    const keyStage = events.find(
      (e) => e.event === "stage" && e.stage === "acquire_project_key" && "data" in e,
    );
    // Only a hint, and the hint cannot reconstruct the key.
    const hint = (keyStage as { data?: { key_hint?: string } } | undefined)?.data?.key_hint;
    if (hint !== undefined) {
      expect(secret).not.toContain(hint);
    }
  });

  /**
   * Drives a run through the real `--json` emitter rather than the recording
   * one, because the thing under test is what lands on stdout. A spy on `emit`
   * sees typed events whatever anyone prints.
   */
  function jsonRun(): { ctx: SetupContext; events: SetupEvent[]; out: StringSink } {
    const { ctx, events, out } = makeCtx({ json: true, flags: { agent: "claude" } });
    const emitJson = jsonEmitter(ctx.writers);
    ctx.emit = (event) => {
      events.push(event);
      emitJson(event);
    };
    return { ctx, events, out };
  }

  /** The run with the most to say: outside version control, no `claude` on PATH. */
  function talkativeRun(): SetupDeps {
    pythonRepo();
    return makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: [""] }).run,
    });
  }

  it("keeps stdout to one JSON document per line", async () => {
    const deps = talkativeRun();
    const { ctx, out } = jsonRun();

    await runSetupMachine(ctx, deps);

    // The whole point of the mode: a caller consumes it a line at a time. One
    // line of prose anywhere in it and the consumer is done, so this asserts
    // the stream rather than any single message within it.
    const lines = out.data.split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it("reports the repository state as data rather than only as a warning", async () => {
    const deps = talkativeRun();
    const { ctx, events, out } = jsonRun();

    await runSetupMachine(ctx, deps);

    // An agent is about to edit this directory and there is nothing to revert
    // to. Said in prose on stderr, that is unreadable to the only kind of
    // caller `--json` exists for.
    const precheck = events.find(
      (e) => e.event === "stage" && e.stage === "precheck" && "data" in e,
    );
    expect(precheck).toMatchObject({ data: { in_git_repo: false } });
    expect(out.data).toContain('"in_git_repo":false');
  });

  it("reports a repository under version control the same way", async () => {
    const deps = talkativeRun();
    initGit();
    const { ctx, events } = jsonRun();

    await runSetupMachine(ctx, deps);

    const precheck = events.find(
      (e) => e.event === "stage" && e.stage === "precheck" && "data" in e,
    );
    expect(precheck).toMatchObject({ data: { in_git_repo: true } });
  });

  it("emits a failure result carrying the stage and code", async () => {
    writeFileSync(join(dir, "go.mod"), "module x\n");
    const deps = makeDeps({ auth: authWithKey(), client: fakeApiClient() });
    const { ctx, events } = makeCtx({ json: true });
    await runSetupMachine(ctx, deps);

    const final = events.at(-1);
    expect(final).toMatchObject({
      event: "result",
      ok: false,
      error: { stage: "detect_stack", code: "UNSUPPORTED" },
    });
  });
});

describe("production wiring", () => {
  // Setup used to carry its own opener, which disagreed with the device flow's
  // on Windows. Identity, not behaviour: the only way the two can stay in step
  // is for there to be one of them, and a second copy is exactly what a
  // behavioural assertion would let back in.
  it("opens browsers with the device flow's opener, not a copy of it", () => {
    expect(defaultSetupDeps(authWithKey()).openBrowser).toBe(openBrowserForPlatform);
  });

  // Same reasoning, same shape: the production wiring had its own timer, byte
  // for byte the one in `trace.ts`, and `sleep` is a dependency precisely so
  // there is one of it to inject.
  it("waits with the shared timer, not a copy of it", () => {
    expect(defaultSetupDeps(authWithKey()).sleep).toBe(sleep);
  });
});

describe("the uncommitted-changes gate", () => {
  /** A repo that is already dirty when setup starts. */
  function dirtyRepo(files: string[]) {
    pythonRepo();
    initGit();
    // NUL-delimited, as `git status --porcelain -z` emits it.
    return fakeRunProcess({ gitStatus: [files.map((f) => ` M ${f}`).join(NUL)] });
  }

  it("lists what is already changed, numbered, before asking", async () => {
    const process = dirtyRepo([".DS_Store", "barebone.py"]);
    const base = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      answers: ["yes"],
    });
    const asked: string[] = [];
    const deps = {
      ...base,
      select: (input: Parameters<typeof base.select>[0]) => {
        asked.push(input.message);
        return base.select(input);
      },
    };
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    expect(err.data).toContain("Git changes detected");
    expect(err.data).toContain("1. .DS_Store");
    expect(err.data).toContain("2. barebone.py");
    // The warning now travels with the question rather than sitting above it,
    // so the reason to care is on screen at the moment of answering.
    expect(asked.join(" ")).toContain("its edits will be mixed with these changes");
  });

  it("emphasises the question and nothing else in it", async () => {
    // The weight itself is asserted in `wizard.colour.test.ts`, where colour is
    // forced on; this suite runs without it, so what can be pinned here is
    // *which* words go through the helper — the question, and not the sentence
    // explaining it.
    const process = dirtyRepo(["notes.md"]);
    const base = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      answers: ["yes"],
    });
    const asked: string[] = [];
    const deps = {
      ...base,
      select: (input: Parameters<typeof base.select>[0]) => {
        asked.push(input.message);
        return base.select(input);
      },
    };
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    expect(asked).toContain(
      `Setup can continue, but its edits will be mixed with these changes. ${wizardEmphasis("Continue?")}`,
    );
  });

  it("defaults to no, because the safe answer costs a stash and the other an afternoon", async () => {
    // Answering nothing takes the highlighted option. After the run the agent's
    // edits and the user's own are one indistinguishable diff.
    const process = dirtyRepo(["notes.md"]);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CANCELLED");
    // Declining is a decision, not a fault.
    expect(result.error?.exitCode).toBe(0);
    expect(result.error?.remedy).toContain("stash");
    // Nothing was launched at anybody's repository.
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
  });

  it("proceeds when the user says yes", async () => {
    const process = dirtyRepo(["notes.md"]);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      answers: ["yes"],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(1);
  });

  it("summarises rather than printing a hundred paths", async () => {
    const files = Array.from({ length: 25 }, (_, i) => `file-${i}.py`);
    const process = dirtyRepo(files);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
      answers: ["yes"],
    });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    expect(err.data).toContain("10. ");
    expect(err.data).not.toContain("11. ");
    expect(err.data).toContain("… and 15 more");
  });

  it("still warns and proceeds when there is nobody to ask", async () => {
    // A new blocking prompt in CI is a hang with nothing in the log to explain
    // it, so an unattended run keeps exactly the behaviour it had.
    const process = dirtyRepo(["notes.md"]);
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ canPrompt: false, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(err.data).toContain("uncommitted change(s)");
    expect(err.data).not.toContain("Git changes detected");
  });

  it("asks nothing at all when the worktree is clean", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ canPrompt: true, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(err.data).not.toContain("Git changes detected");
  });
});

describe("worktree safety", () => {
  it("preserves a dirty worktree and never runs a mutating git command", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      // Dirty before setup starts, and the pre-existing edit is not attributed
      // to the agent afterwards.
      gitStatus: [" M unrelated.py", ` M unrelated.py${NUL} M main.py`],
    });
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    expect(ctx.instrumentation?.observedChangedFiles).toEqual(["main.py"]);

    const mutating = process.runs.filter(
      (r) =>
        r.program === "git" &&
        ["stash", "checkout", "commit", "reset", "clean", "restore"].includes(r.args[0] ?? ""),
    );
    expect(mutating).toEqual([]);
  });
});

describe("where you run it is what it instruments", () => {
  it("targets the subdirectory you are standing in, not the repository above it", async () => {
    // The checkpoint lives at the git root, so the target must be taken from
    // the working directory instead — otherwise the agent is handed a whole
    // monorepo, finds some unrelated instrumented service, and does nothing.
    mkdirSync(join(dir, "test1"), { recursive: true });
    writeFileSync(join(dir, "test1", "requirements.txt"), "anthropic\n");
    writeFileSync(join(dir, "test1", "main.py"), "import anthropic\n");
    writeFileSync(join(dir, "requirements.txt"), "openai\n");
    writeFileSync(join(dir, "main.py"), "import openai\n");

    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M test1/main.py"] }).run,
    });
    const { ctx } = makeCtx({
      cwd: join(dir, "test1"),
      canPrompt: false,
      flags: { agent: "claude", method: "manual" },
    });
    await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.path).toBe("test1");
  });

  it("falls back to the repository from a directory with nothing to instrument", async () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "readme.md"), "# docs\n");
    writeFileSync(join(dir, "requirements.txt"), "openai\n");
    writeFileSync(join(dir, "main.py"), "import openai\n");

    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({
      cwd: join(dir, "docs"),
      canPrompt: false,
      flags: { agent: "claude", method: "manual" },
    });
    await runSetupMachine(ctx, deps);

    expect(ctx.stack?.selected?.path).toBe(".");
  });
});

describe("where a run leaves its files", () => {
  /** A second service one level down: the directory the user is standing in. */
  function subService(): string {
    const sub = join(dir, "test1");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
    writeFileSync(join(sub, "main.py"), "print('hi')\n");
    return sub;
  }

  /**
   * Deps that reach CONFIGURE_REPOSITORY with a key to write.
   *
   * A credential that resolved from the user's own config never gets written to
   * a file at all — the stage is satisfied before it runs — so a test about
   * where the file lands has to be a test about a freshly minted key.
   */
  function mintingDeps(run?: SetupDeps["runProcess"]): SetupDeps {
    return makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
      }),
      traces: [traceRow()],
      setupApi: fakeSetupApi({
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [],
        createApiKey: async ({ name }) => ({
          id: "ak_1",
          name,
          hint: "tr-…9999",
          project_id: "p_1",
          scope: "ingest",
          expires_at: null,
          key: "tr-minted-secret-value-42",
        }),
      }),
      runProcess: run ?? fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
  }

  it("puts the credential and the checkpoint beside the service, not at the root", async () => {
    // One run must not split itself across two directories: the credential and
    // the checkpoint belong with `.traceroot/config.json`, beside the service,
    // not at the repository root away from the application that reads them.
    pythonRepo();
    initGit();
    const sub = subService();
    const { ctx } = makeCtx({ cwd: sub, flags: { agent: "claude", project: "demo" } });
    const result = await runSetupMachine(ctx, mintingDeps());

    expect(result.ok).toBe(true);
    expect(readFileSync(join(sub, ".env"), "utf8")).toContain("tr-minted-secret-value-42");
    expect(existsSync(join(sub, ".traceroot", "setup.json"))).toBe(true);
    // And nothing of ours left at the root.
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(existsSync(join(dir, ".traceroot", "setup.json"))).toBe(false);
  });

  it("stands the agent in the service, and points it at a skill it can open", async () => {
    // Two halves of one invariant, which is why they are asserted together.
    //
    // An agent standing at the repository root spends its opening minutes
    // reading sibling projects, so it stands in the service instead. But the
    // skill installs at `<root>/.claude/skills/…`, so a relatively named skill
    // path would, from the service directory, make the very first instruction
    // — "read this file" — point at nothing, leaving the agent with no source
    // of truth for the SDK's API and nothing to do but guess.
    //
    // Any future change to one of these has to move the other.
    pythonRepo();
    initGit();
    const sub = subService();
    const process = fakeRunProcess({ gitStatus: ["", " M test1/main.py"] });
    const { ctx } = makeCtx({ cwd: sub, flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps(process.run));

    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch?.cwd).toBe(sub);
    // Standing in the service is only half of it: Claude Code scopes file
    // reads to the working directory, so without this the agent cannot open
    // the skill it was just told to read.
    expect(launch?.args).toContain("--add-dir");
    expect(launch?.args[(launch?.args.indexOf("--add-dir") ?? -1) + 1]).toBe(dir);

    // The path the task names has to resolve from where the agent stands.
    const named = /`([^`]*SKILL\.md)`/.exec(launch?.stdin ?? "")?.[1];
    expect(named).toBeDefined();
    // Resolved from where the agent stands, it has to land on the file the
    // skill actually installs to. Asserting the path exists would only test
    // the fake, which never writes it; where it points is the thing that
    // matters.
    expect(resolve(sub, named ?? "")).toBe(
      join(dir, ".claude", "skills", "traceroot-instrument-repo", "SKILL.md"),
    );
  });

  it("warns, naming the path it actually landed at, when git does not ignore it", async () => {
    // The entry has to name `test1/.env`, which is the path git was asked
    // about. This stage used to append that line to the user's `.gitignore`
    // itself, off a matcher that read only the root ignore file; it asks
    // `git check-ignore` now and leaves the acting to the user.
    pythonRepo();
    initGit();
    const sub = subService();
    const process = fakeRunProcess({
      gitStatus: ["", " M test1/main.py"],
      // `check-ignore` exits 1 when the path is not ignored. `ls-files` has to
      // keep saying "not tracked" or the stage refuses before it ever asks, so
      // the two are told apart by subcommand rather than by program.
      git: (args) => (args.includes("check-ignore") ? { exitCode: 1 } : { exitCode: 0 }),
    });
    const { ctx, err } = makeCtx({ cwd: sub, flags: { agent: "claude", project: "demo" } });

    await runSetupMachine(ctx, mintingDeps(process.run));

    const warning = plain(err.data);
    expect(warning).toContain("warning: test1/.env holds a live API key");
    expect(warning).toContain("Add a line for test1/.env to .gitignore");
    // Warned, not refused: the key still reached the file. Refusing here would
    // fail on a fresh repository with no `.gitignore` at all, which is the case
    // setup is most useful in.
    expect(readFileSync(join(sub, ".env"), "utf8")).toContain("tr-minted-secret-value-42");
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("says so when it cannot tell whether git ignores the file", async () => {
    // The state the old code handled worst: `ensureIgnored` returned "failed"
    // and the caller dropped it on the floor, so a run that could not tell
    // whether a live credential was ignored said nothing at all. 128 is what
    // git exits with when it cannot answer.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      git: (args) => (args.includes("check-ignore") ? { exitCode: 128 } : { exitCode: 0 }),
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    await runSetupMachine(ctx, mintingDeps(process.run));

    expect(plain(err.data)).toContain("could not check whether git ignores .env");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("tr-minted-secret-value-42");
  });

  it("stays quiet when git already ignores the file", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      git: (args) => (args.includes("check-ignore") ? { exitCode: 0 } : { exitCode: 0 }),
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    await runSetupMachine(ctx, mintingDeps(process.run));

    expect(plain(err.data)).not.toContain(".gitignore");
  });

  it("writes the host beside the key for a deployment that is not the hosted one", async () => {
    // The other half of the pair the closing notice now names. This was written
    // and never mentioned again: `TRACEROOT_HOST_URL` only appears off the
    // default host, so no run against the hosted product reaches it, and the
    // notice naming the key alone survived every run anyone had made.
    pythonRepo();
    initGit();
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps());

    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(ctx.session?.host).toBe("https://api.example.test");
    expect(written).toContain("TRACEROOT_API_KEY=tr-minted-secret-value-42");
    expect(written).toContain("TRACEROOT_HOST_URL=https://api.example.test");
  });

  it("writes the key alone for the hosted product", async () => {
    // A host line whose value is the default the SDK already uses is noise in a
    // file the user is told to copy out of.
    pythonRepo();
    initGit();
    const deps = mintingDeps();
    deps.resolvedAuth = {
      ...deps.resolvedAuth,
      hostUrl: { value: DEFAULT_HOST, source: "config" },
    };
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, deps);

    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(ctx.session?.host).toBe(DEFAULT_HOST);
    expect(written).toContain("TRACEROOT_API_KEY=");
    expect(written).not.toContain("TRACEROOT_HOST_URL");
  });

  describe("a host line the file already holds", () => {
    const REPO = "https://repo-chosen.example.test";
    const NOTICE = "replaced TRACEROOT_HOST_URL in .env";

    function onHostedProduct(): SetupDeps {
      const deps = mintingDeps();
      deps.resolvedAuth = {
        ...deps.resolvedAuth,
        hostUrl: { value: DEFAULT_HOST, source: "config" },
      };
      return deps;
    }

    it("is replaced by the run's host, even the hosted product's, and the run says so once", async () => {
      // Left alone, the application reads it and sends the new key — and its
      // traces — to a deployment the key does not belong to. A `--handoff` run
      // that ignored a repository `.env`'s host is how one gets here.
      pythonRepo();
      initGit();
      writeFileSync(join(dir, ".env"), `TRACEROOT_HOST_URL=${REPO}\n`);
      const { ctx, err } = makeCtx({ flags: { agent: "claude", project: "demo" } });
      await runSetupMachine(ctx, onHostedProduct());

      expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
        `TRACEROOT_HOST_URL=${DEFAULT_HOST}\n\nTRACEROOT_API_KEY=tr-minted-secret-value-42\n`,
      );
      const line = `${NOTICE} (${REPO}) with ${DEFAULT_HOST}, the deployment this run's key belongs to`;
      expect(plain(err.data).split(line)).toHaveLength(2);
    });

    it("is left untouched when it already names the run's host", async () => {
      for (const existing of [
        `TRACEROOT_HOST_URL=${DEFAULT_HOST}`,
        `TRACEROOT_HOST_URL=${DEFAULT_HOST}/`,
      ]) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        pythonRepo();
        initGit();
        writeFileSync(join(dir, ".env"), `${existing}\n`);
        const { ctx, err } = makeCtx({ flags: { agent: "claude", project: "demo" } });
        await runSetupMachine(ctx, onHostedProduct());

        expect(readFileSync(join(dir, ".env"), "utf8"), existing).toBe(
          `${existing}\n\nTRACEROOT_API_KEY=tr-minted-secret-value-42\n`,
        );
        expect(plain(err.data), existing).not.toContain(NOTICE);
      }
    });

    it("leaves a fresh repository's first run as it was", async () => {
      pythonRepo();
      initGit();
      const { ctx, err } = makeCtx({ flags: { agent: "claude", project: "demo" } });
      await runSetupMachine(ctx, onHostedProduct());

      const written = readFileSync(join(dir, ".env"), "utf8");
      expect(written.startsWith("# Created by `traceroot setup`.")).toBe(true);
      expect(written.endsWith("\n\nTRACEROOT_API_KEY=tr-minted-secret-value-42\n")).toBe(true);
      expect(written).not.toContain("TRACEROOT_HOST_URL");
      expect(plain(err.data)).toContain("Created .env with TRACEROOT_API_KEY (0600).");
      expect(plain(err.data)).not.toContain(NOTICE);
    });
  });

  it("heads the credential file it creates with what it is", async () => {
    pythonRepo();
    initGit();
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps());

    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(written.startsWith("# Created by `traceroot setup`.")).toBe(true);
    expect(written).toContain("Do not commit");
    // The key is in the file, and never in the part explaining the file.
    for (const line of written.split("\n")) {
      if (line.startsWith("#")) {
        expect(line).not.toContain("tr-minted-secret-value-42");
      }
    }
  });

  it("keeps everything at the root when the run started there", async () => {
    // The unchanged case, and the one most runs take.
    pythonRepo();
    initGit();
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps());

    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, ".traceroot", "setup.json"))).toBe(true);
  });

  it("tells the agent to load the credential file, on a repository with no env file of its own", async () => {
    // The whole point of the file, and the case it never used to reach.
    // `pythonRepo()` writes a manifest and an entry point and nothing else —
    // no `.env`, no `.env.local` — which is what a project `traceroot setup` is
    // run on actually looks like. The task's dotenv block was gated on the
    // app's own env files, so on exactly this repository it was omitted, and
    // the run finished having written a credential to disk that nothing would
    // ever read. The `.env` this run creates is one of the app's own env files,
    // so `detectEnvFiles` finds it and the one load covers both.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps(process.run));

    const task = process.runs.find((run) => run.program === "claude")?.stdin ?? "";
    expect(task).toContain('load_dotenv(Path(__file__).resolve().parent / ".env")');
    expect(task).toContain("wrote `TRACEROOT_API_KEY` into `./.env`");
  });

  it("does not name a credential file git refused to let it write", async () => {
    // `configure_repository` degrades rather than failing when git tracks the
    // file, because writing a live key into a tracked file is one `git commit
    // -a` away from a public repository. What is left on disk is then whatever
    // was committed — here a placeholder — so naming it in the task sends the
    // agent to load a file that does not hold this run's credential. The run
    // still works: the key reaches the child through its environment.
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), "# committed by mistake\n");
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      // `git status` is answered above this, and `ls-files` is the only other
      // git call setup makes — so this reports the file as tracked.
      results: { git: { output: ".env\n" } },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    await runSetupMachine(ctx, mintingDeps(process.run));

    // Untouched is the proof the write was refused: the stage overwrites this
    // file whenever it is allowed to.
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("# committed by mistake\n");
    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    expect(launch?.stdin ?? "").not.toContain("wrote `TRACEROOT_API_KEY` into");
  });

  it("does not ask the user to copy a key it never showed them into another file", async () => {
    // The refusal used to end "add it to an untracked env file to persist it",
    // but the run never prints the key, so there was nothing to add. It now
    // says what the closing block says, plus the one way to get a file written.
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), "# committed by mistake\n");
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: { git: { output: ".env\n" } },
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    await runSetupMachine(ctx, mintingDeps(process.run));

    expect(plain(err.data)).toContain(
      ".env is tracked by git, so the API key was not written to it. The key is available to this setup run only. Give your deployment a key of its own, or untrack .env and rerun setup to have one written to it.",
    );
    expect(plain(err.data)).not.toContain("untracked env file");
    // And the premise: the key really is nowhere in what the run printed.
    const key = ctx.credential?.key.reveal();
    expect(key).toBeDefined();
    expect(err.data).not.toContain(key as string);
  });

  it("survives a credential file it cannot read, rather than failing the stage", async () => {
    // Checking that the file holds this run's key means reading it, and the
    // reader swallows only a missing file — `EACCES`, a directory of that name
    // and a parse failure all come back out. This is called while the agent's
    // task is being built, so a throw there fails instrumentation and rolls it
    // back, over a file whose only consequence was whether a path got named.
    pythonRepo();
    initGit();
    mkdirSync(join(dir, ".env"));
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: { git: { output: ".env\n" } },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    const result = await runSetupMachine(ctx, mintingDeps(process.run));

    expect(result.error).toBeNull();
    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    expect(launch?.stdin ?? "").not.toContain("wrote `TRACEROOT_API_KEY` into");
  });

  it("names the credential file from where the agent stands, not from the root", async () => {
    // The artefacts follow the service, but the service is chosen after the
    // credential is written — a run started at the root writes it at the root
    // and may still instrument `test1/`, where the agent stands. A path
    // rendered from the root resolves to nothing from there, and the agent is
    // told to load it on the first line of the entry point.
    pythonRepo();
    initGit();
    subService();
    const process = fakeRunProcess({ gitStatus: ["", " M test1/main.py"] });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo", service: "test1" } });
    await runSetupMachine(ctx, mintingDeps(process.run));

    const launch = process.runs.find((run) => run.program === "claude");
    const named = /load_dotenv\(Path\(__file__\)\.resolve\(\)\.parent \/ "([^"]*\.env)"\)/.exec(
      launch?.stdin ?? "",
    )?.[1];
    expect(named).toBeDefined();
    // Anchored on the entry point, which this service keeps at its own root, so
    // resolving from where the agent stands is the same anchor. Either way it
    // has to land on the file the run actually wrote.
    expect(resolve(launch?.cwd ?? "", named ?? "")).toBe(join(dir, "test1", ".env"));
  });

  describe("for a service in a subdirectory", () => {
    /**
     * `git` in the fixture, as a real repository, because whether anything
     * under `.traceroot/` is left to commit is git's to answer. Kept away from
     * the developer's own configuration: a global excludes file that ignores
     * `.traceroot/` would pass this over a repository that does not.
     */
    function git(args: string[]): string {
      const home = join(dir, ".git", "no-home");
      const result = spawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout;
    }

    /** Every file `git status` would offer to commit from a `.traceroot/` directory. */
    function untrackedUnderTraceroot(): string[] {
      const status = git(["status", "--porcelain", "--untracked-files=all"]);
      // The service's own files are untracked too, which is what shows git is
      // looking at this fixture at all.
      expect(status).toContain("test1/main.py");
      return status.split("\n").filter((line) => line.includes(".traceroot/"));
    }

    /** The paths in the report's table of touched files, as it prints them. */
    function touched(report: string): string[] {
      const table = report.split("## Files this run touched")[1]?.split("\n\n")[1] ?? "";
      return table
        .split("\n")
        .slice(2)
        .map((row) => /^\| `([^`]+)` \|/.exec(row)?.[1] ?? row);
    }

    describe.each([
      ["started from the service directory, with a saved sign-in", true, true],
      ["started from the service directory, with a key already configured", true, false],
      ["started from the root with --service, with a saved sign-in", false, true],
      ["started from the root with --service, with a key already configured", false, false],
    ])("%s", (_name, fromService, session) => {
      /**
       * One run, started where the case says. A saved sign-in mints the CLI a
       * key and writes the config, into the directory setup was run from as
       * production does; a key already configured writes none.
       */
      function start(options: { flags: Partial<SetupFlags>; traces: unknown[]; json?: boolean }) {
        const sub = subService();
        const cwd = fromService ? sub : dir;
        const deps = makeDeps({
          auth: session ? authEmpty() : authWithKey(),
          storedCredential: session ? { session_token: "saved-session-token" } : null,
          setupApi: fakeSetupApi({
            listProjects: async () => [
              { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
            ],
            createProjectApiKey: async (input) => ({
              id: `ak_${input.scope}`,
              name: input.name,
              hint: "tr-…9999",
              project_id: input.projectId,
              scope: input.scope,
              expires_at: null,
              key: `tr-minted-${input.scope}-key-value`,
            }),
          }),
          traces: options.traces,
          runProcess: fakeRunProcess({ gitStatus: ["", " M test1/main.py"] }).run,
        });
        deps.writeConfig = (config) => {
          const target = join(cwd, ".traceroot", "config.json");
          writeCliConfig(config, target);
          return target;
        };
        const flags = fromService ? options.flags : { ...options.flags, service: "test1" };
        const harness = makeCtx({ cwd, flags, json: options.json });
        return { ...harness, deps };
      }

      beforeEach(() => {
        git(["init", "-q"]);
      });

      it("lists only files that exist in the report, and leaves git nothing under `.traceroot/`", async () => {
        const { ctx, deps } = start({ flags: { agent: "claude" }, traces: [traceRow()] });

        const result = await runSetupMachine(ctx, deps);

        expect(result.error).toBeNull();
        const report = readFileSync(join(dir, ".traceroot", "setup-report.md"), "utf8");
        const paths = touched(report);
        expect(paths).toContain("test1/.traceroot/setup.json");
        if (session) {
          expect(paths).toContain(
            fromService ? "test1/.traceroot/config.json" : ".traceroot/config.json",
          );
        } else {
          expect(report).not.toContain("The CLI's own credential");
        }
        for (const path of paths) {
          expect(existsSync(join(dir, path)), path).toBe(true);
        }
        expect(untrackedUnderTraceroot()).toEqual([]);
      });

      it("leaves git nothing under `.traceroot/` after a hand-over", async () => {
        // No trace, so no report: the task file is the one thing this run
        // writes in the root's `.traceroot/`.
        const { ctx, deps } = start({
          flags: { agent: "claude", instrument: false, traceTimeoutSec: 1 },
          traces: [],
        });

        const result = await runSetupMachine(ctx, deps);

        expect(result.ok).toBe(true);
        expect(result.trace).toBeNull();
        expect(existsSync(join(dir, ".traceroot", "prompts", "setup-instrument.md"))).toBe(true);
        expect(untrackedUnderTraceroot()).toEqual([]);
      });

      it("gives `--json` the checkpoint's real path", async () => {
        const { ctx, deps, events } = start({
          flags: { agent: "claude" },
          traces: [traceRow()],
          json: true,
        });

        await runSetupMachine(ctx, deps);

        expect(events.at(-1)).toMatchObject({
          event: "result",
          ok: true,
          data: { checkpoint_path: "test1/.traceroot/setup.json" },
        });
        expect(existsSync(join(dir, "test1", ".traceroot", "setup.json"))).toBe(true);
      });
    });
  });
});

describe("the machine contract, whatever the human sees", () => {
  it("emits every stage event, in order, however few of them are drawn", async () => {
    // Several stages stopped printing a heading when they stopped being
    // sections. None of them stopped happening, and a `--json` consumer never
    // saw a heading in the first place — so this list is what must not move,
    // and it is pinned in full rather than sampled.
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx, events } = makeCtx({ json: true, flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // Every stage the run passed through, in order and once each. A stage that
    // was already satisfied reports "skipped" and never "start", so filtering on
    // "start" alone would quietly excuse two of them from this list.
    const stages = [
      ...new Set(
        events
          .filter((e) => e.event === "stage")
          .map((e) => (e as unknown as { stage: string }).stage),
      ),
    ];
    expect(stages).toEqual([
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
    ]);
    // Every one of them settled, and the run ends with exactly one result.
    for (const stage of stages) {
      expect(
        events.some(
          (e) =>
            e.event === "stage" &&
            (e as unknown as { stage: string }).stage === stage &&
            e.status !== "start",
        ),
      ).toBe(true);
    }
    expect(events.filter((e) => e.event === "result")).toHaveLength(1);
  });
});

describe("a token configured in the environment rather than saved on disk", () => {
  it("signs in with it instead of failing for want of a credential", async () => {
    // `TRACEROOT_TOKEN` resolves to exactly the kind of credential a saved login
    // produces. It was resolved, then ignored because only the disk store was
    // consulted, so a non-interactive run failed NOT_AUTHENTICATED holding a
    // usable token.
    pythonRepo();
    initGit();
    const deps = makeDeps({
      // Typed, not `as never`: the casts hid that this fixture's workspace rows
      // used `workspace_id`/`workspace_name` while `WorkspaceSummary` is
      // `{id, name, role}` — the shape the machine actually reads. `env` is a
      // real `AuthSource`, so the credential needs no cast either.
      auth: {
        credential: { kind: "session", value: "env-session-token", source: "env" },
        hostUrl: { value: "https://api.example.test", source: "config" },
        authHost: { value: "https://api.example.test", source: "default" },
        projectId: { value: undefined, source: "none" },
      },
      storedCredential: null,
      traces: [traceRow()],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      setupApi: fakeSetupApi({
        listWorkspaces: async () => [{ id: "w_1", name: "acme", role: "admin" }],
        listProjects: async () => [
          { project_id: "p_1", project_name: "demo", workspace_id: "w_1" },
        ],
        listApiKeys: async () => [],
        createProjectApiKey: async () => ({
          id: "k_1",
          name: "setup",
          hint: "tr-…alue",
          project_id: "p_1",
          expires_at: null,
          created_at: "2026-07-26T12:00:00.000Z",
          key: "tr-minted-key-value",
        }),
      }),
    });
    const { ctx } = makeCtx({ canPrompt: false, flags: { agent: "claude", method: "manual" } });

    const result = await runSetupMachine(ctx, deps);

    // The point is that authentication did not stop the run.
    expect(result.checkpoint.completedStages).toContain("authenticate");
  });
});

describe("how much of the application the first trace covers", () => {
  /** A run that reaches a trace, with whatever `span_count` the backend reports. */
  function run(trace: Record<string, unknown>, options: { json?: boolean } = {}) {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: [traceRow(trace)],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const harness = makeCtx({ json: options.json ?? false, flags: { agent: "claude" } });
    return { harness, result: runSetupMachine(harness.ctx, deps) };
  }

  it("gives the size of a one-span trace and passes no judgement on it", async () => {
    // The run this replaces warned over a trace of one span, and the trace it
    // warned over was a unit test's, opened by mistake. One span is the whole
    // truth for a single-function script, and nothing the run inspected says
    // which case it is in: it states the count and leaves it there.
    const { harness, result } = run({ span_count: 1 });
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(outcome.trace?.traceUrl).toBe("https://app.example.test/trace/t_1");
    expect(plain(harness.err.data)).not.toContain("warning: your first trace");
    // The line the wait closes on carries the size, which is where a user
    // watching the run sees it first.
    expect(plain(harness.err.data)).toContain("First trace received (a single span).");
    // On the checkpoint, because the report is rendered from it — including by a
    // `--resume` that never polled.
    expect(outcome.checkpoint.trace?.spanCount).toBe(1);
  });

  it("gives the size of a trace that holds several", async () => {
    const { harness, result } = run({ span_count: 7 });
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(plain(harness.err.data)).not.toContain("warning: your first trace");
    expect(plain(harness.err.data)).toContain("First trace received (7 spans).");
    expect(outcome.checkpoint.trace?.spanCount).toBe(7);
  });

  it("claims no size when the deployment did not report one", async () => {
    // A row without `span_count`. Silence is not evidence of anything, so the
    // run says what it always said and records no number.
    const { harness, result } = run({});
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(plain(harness.err.data)).toContain("First trace received.");
    expect(plain(harness.err.data)).not.toContain("warning: your first trace");
    expect(outcome.checkpoint.trace?.spanCount).toBeUndefined();
  });

  it("carries the count into the JSON envelope", async () => {
    // A machine consumer has only the fields, so the number is on the stage
    // and nothing has to parse prose to act on it.
    const { harness, result } = run({ span_count: 1 }, { json: true });
    await result;

    const stage = harness.events.find(
      (e) =>
        e.event === "stage" &&
        (e as unknown as { stage: string }).stage === "verify_trace" &&
        e.status === "ok",
    ) as unknown as { data: { span_count: number | null } };
    expect(stage.data.span_count).toBe(1);
    expect(harness.err.data).not.toContain("warning: your first trace");
  });

  it("reports null rather than zero for a count the JSON consumer never got", async () => {
    // The two cases a consumer must be able to tell apart: a trace worth
    // looking at, and a deployment that said nothing about this one.
    const { harness, result } = run({}, { json: true });
    await result;

    const stage = harness.events.find(
      (e) =>
        e.event === "stage" &&
        (e as unknown as { stage: string }).stage === "verify_trace" &&
        e.status === "ok",
    ) as unknown as { data: { span_count: number | null } };
    expect(stage.data.span_count).toBeNull();
  });
});

describe("a project that already had traces before setup started", () => {
  const EARLIER = traceRow({ trace_id: "t_old", trace_start_time: "2026-07-25T09:00:00.000000" });

  /**
   * A run that reaches a trace, with `earlier` answering the one read bounded
   * by `end_before`: the question of whether anything else sends to this
   * project.
   */
  function run(options: { earlier: unknown[] | Error; rows?: unknown[]; json?: boolean }) {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      traces: options.rows ?? [traceRow({ name: "demo.run", span_count: 7 })],
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const createApi = deps.createSetupApi;
    /** Every `end_before` the run asked with, so a test can check the bound itself. */
    const bounds: string[] = [];
    deps.createSetupApi = (o) => {
      const api = createApi(o);
      return {
        ...api,
        listTraces: async (params) => {
          if (params?.endBefore === undefined) {
            return api.listTraces(params);
          }
          bounds.push(params.endBefore);
          if (options.earlier instanceof Error) {
            throw options.earlier;
          }
          return listTracesFrom(options.earlier)(params);
        },
      };
    };
    const harness = makeCtx({ json: options.json ?? false, flags: { agent: "claude" } });
    return { harness, bounds, result: runSetupMachine(harness.ctx, deps) };
  }

  function foundLine(err: StringSink): string | undefined {
    return plain(err.data)
      .split("\n")
      .find((l) => l.includes("First trace received"));
  }

  function traceStage(events: SetupEvent[]): Record<string, unknown> {
    const stage = events.find(
      (e) =>
        e.event === "stage" &&
        (e as unknown as { stage: string }).stage === "verify_trace" &&
        e.status === "ok",
    ) as unknown as { data: Record<string, unknown> };
    return stage.data;
  }

  it("says exactly what it always said when the project had none and one trace arrived", async () => {
    // The onboarding case, and the approved core path: nothing about it changes.
    const { harness, result } = run({ earlier: [] });
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(foundLine(harness.err)).toBe("│  First trace received (7 spans).");
    expect(plain(harness.err.data)).not.toContain("may not come from this service");
    expect(outcome.checkpoint.trace?.attributed).toBe(true);
  });

  it("warns, names the trace and still succeeds when the project already had traffic", async () => {
    const { harness, bounds, result } = run({ earlier: [EARLIER] });
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    // Asked once, and bounded by this run's own start: a later bound would
    // count the agent's own traces as another sender's.
    expect(bounds).toEqual([new Date(outcome.checkpoint.startedAt).toISOString()]);
    expect(foundLine(harness.err)).toBe("│  First trace received (7 spans).");
    expect(plain(harness.err.data)).toContain(
      'warning: this project already had traces before setup started, so the trace "demo.run" may not come from this service. Open it and check.',
    );
    // On the checkpoint, so a resumed run's report says the same.
    expect(outcome.checkpoint.trace?.attributed).toBe(false);
  });

  it("strips control characters from the name it warns about", async () => {
    // The name is the sending process's own text, and here that sender may be
    // the other one: an escape or a newline in it must not reach the terminal.
    const { harness, result } = run({
      earlier: [EARLIER],
      rows: [traceRow({ name: "demo.run\u001b[2J\nwarning: forged", span_count: 7 })],
    });
    await result;

    expect(harness.err.data).not.toContain("\u001b[2J");
    expect(plain(harness.err.data)).toContain(
      'so the trace "demo.run[2Jwarning: forged" may not come from this service.',
    );
  });

  it("puts the attribution on the JSON step", async () => {
    const { harness, result } = run({ earlier: [EARLIER], json: true });
    await result;

    expect(traceStage(harness.events)).toMatchObject({
      trace_name: "demo.run",
      candidates: 1,
      truncated: false,
      trace_attributed: false,
    });
  });

  it("counts several traces since setup started without doubting the first", async () => {
    // An agent that runs the application twice sends two. Only earlier traffic
    // shows another sender exists.
    const { harness, result } = run({
      earlier: [],
      rows: [
        traceRow({ trace_id: "t_2", trace_start_time: "2026-07-26T12:00:40.000000" }),
        traceRow({ name: "demo.run", span_count: 7 }),
      ],
    });
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(foundLine(harness.err)).toBe(
      "│  First trace received (7 spans) — first of 2 since setup started.",
    );
    expect(plain(harness.err.data)).not.toContain("may not come from this service");
  });

  it("neither warns nor guesses when the look for earlier traffic fails", async () => {
    const { harness, result } = run({
      earlier: new Error("request to host failed: fetch failed"),
      json: true,
    });
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(harness.err.data).not.toContain("may not come from this service");
    expect(traceStage(harness.events)).toMatchObject({ trace_attributed: null });
    expect(outcome.checkpoint.trace?.attributed).toBeUndefined();
  });
});
