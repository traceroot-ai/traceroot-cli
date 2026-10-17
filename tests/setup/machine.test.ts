import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** `git status --porcelain -z` record separator. */
const NUL = String.fromCharCode(0);
import type { ApiClientOptions } from "../../src/api/client.js";
import { BackendUnavailableError, SetupApiError } from "../../src/api/setup.js";
import type { CredentialEntry } from "../../src/auth/credentials.js";
import { openBrowserForPlatform } from "../../src/auth/deviceFlow.js";
import { DEFAULT_HOST } from "../../src/commands/constants.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import { CliError, ExitCode } from "../../src/output.js";
import { serviceArtifactDir } from "../../src/setup/artifacts.js";
import { newCheckpoint, readCheckpoint, writeCheckpoint } from "../../src/setup/checkpoint.js";
import { SETUP_EXIT_CODES } from "../../src/setup/errors.js";
import { type SetupEvent, jsonEmitter } from "../../src/setup/events.js";
import type { SetupDeps } from "../../src/setup/machine.js";
import {
  SETUP_PIPELINE,
  defaultSetupDeps,
  projectOptions,
  runSetupMachine,
  uniqueKeyName,
} from "../../src/setup/machine.js";
import { makeSecret } from "../../src/setup/secret.js";
import { SETUP_STAGES, type SetupContext, type SetupFlags } from "../../src/setup/types.js";
import { wizardEmphasis } from "../../src/setup/wizard.js";
import { sleep } from "../../src/util/sleep.js";
import type { StringSink } from "../helpers/stringSink.js";
import { plain } from "./colour.js";
import {
  type MakeDepsOptions,
  type RecordedRun,
  authEmpty,
  authWithKey,
  defaultFlags,
  fakeApiClient,
  fakeRunProcess,
  fakeSetupApi,
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow({ trace_url: odd })] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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

  it("runs the application check twice, the second time without the credential", async () => {
    pythonRepo();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    await runSetupMachine(ctx, deps);

    // Three runs, not two: the first is the baseline taken before the agent
    // edits anything, which is what lets a later failure be attributed. The
    // verification is the pair after it.
    const checks = process.runs.filter((r) => r.program === "pytest");
    expect(checks).toHaveLength(3);
    const [, withKey, withoutKey] = checks;
    expect(withKey?.env.TRACEROOT_API_KEY).toBeDefined();
    // Absent, not empty: an SDK treats "" as configured-but-blank.
    expect("TRACEROOT_API_KEY" in (withoutKey?.env ?? {})).toBe(false);
  });

  it("records a non-secret checkpoint", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey("tr-live-project-key-abcd"),
      client: fakeApiClient({ traces: [traceRow()] }),
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

    const deps = makeDeps({ auth: authWithKey(), client: fakeApiClient({ traces: [traceRow()] }) });
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
        traces: [traceRow()],
      }),
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
    const written: Array<{ api_key: string; host_url: string }> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      client: fakeApiClient({ traces: [traceRow()] }),
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
      { api_key: "tr-browser-minted-key-1234", host_url: "https://api.example.test" },
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
    const saved: Array<[string, string, string | null]> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
    const written: Array<{ api_key: string; host_url: string }> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      client: fakeApiClient({ traces: [traceRow()] }),
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
    expect(created[0][0]).toBe(basename(ctx.root));
    // The device flow hands back identity only — no workspace comes attached
    // the way the old fat handoff payload carried one — so the workspace is
    // resolved here instead, from `listWorkspaces`. A sole workspace is used
    // without asking.
    expect(created[0][1]).toBe("w_1");
    expect(ctx.project?.projectId).toBe("p_new");
    expect(ctx.credential?.origin).toBe("minted");
    expect(written).toEqual([
      { api_key: "tr-key-for-the-new-project", host_url: "https://api.example.test" },
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
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      // The workspace choice, then the project name (empty accepts the default).
      answers: ["w_2", ""],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(created[0][1]).toBe("w_2");
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
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      // Only the project name: filtering leaves one workspace, so nothing is asked.
      answers: [""],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(created[0][1]).toBe("w_2");
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
      storedCredential: { sessionToken: makeSecret("saved-session-token"), expiresAt: null },
    });
    const { ctx } = makeCtx({ canPrompt: false });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("AMBIGUOUS");
    expect(result.error?.message).toContain("no projects yet");
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
    const written: Array<{ api_key: string; host_url: string }> = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      onWriteConfig: (config) => written.push(config),
      storedCredential: { sessionToken: makeSecret("saved-session-token"), expiresAt: null },
      requestDeviceCode: async () => {
        deviceFlowCalls += 1;
        throw new Error("the browser handoff should not have been reached");
      },
    });
    const { ctx, err, out } = makeCtx({
      canPrompt: true,
      flags: { browser: true, agent: "claude" },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // The entire point: no device code, no link, no waiting.
    expect(deviceFlowCalls).toBe(0);
    expect(err.data).toContain("Signed in as a returning user. No browser needed.");
    expect(ctx.session?.via).toBe("user-credential");
    expect(ctx.credential?.origin).toBe("minted");
    expect(ctx.project?.projectId).toBe("p_1");
    expect(written).toEqual([
      { api_key: "tr-minted-without-a-browser", host_url: "https://api.example.test" },
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
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      storedCredential: { sessionToken: makeSecret("revoked-session-token"), expiresAt: null },
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
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      storedCredential: { sessionToken: makeSecret("tru-saved-token"), expiresAt: null },
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { browser: true, agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    // Rerunning setup in a repository must not fail just because the previous
    // run named a key after it; the old secret is unrecoverable anyway.
    expect(result.ok).toBe(true);
    // Three attempts for two keys: the first name was taken, so it was retried
    // with the run date appended, and the application's key follows.
    expect(attempted).toHaveLength(3);
    expect(attempted[1]).not.toBe(attempted[0]);
    expect(attempted[1]).toContain(attempted[0]);
  });

  it("does not use a saved credential belonging to a different host", async () => {
    // `readCredential` is keyed by host; this pins that the machine asks for
    // the host it is actually talking to.
    pythonRepo();
    const asked: string[] = [];
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi: fakeSetupApi(),
      client: fakeApiClient({ traces: [traceRow()] }),
    });
    const spied: SetupDeps = {
      ...deps,
      readCredential: (host) => {
        asked.push(host);
        return undefined;
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
   * mint, the redemptions attempted, and whether the device flow was used.
   */
  function handoffRun(options: HandoffRun = {}) {
    pythonRepo();
    const written: CredentialEntry[] = [];
    const minted: string[] = [];
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
      traces: [traceRow()],
    });
    const deps = makeDeps({
      auth: options.auth ?? authEmpty(),
      setupApi: projectApi(),
      client,
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      storedCredential: options.stored ?? null,
      onWriteCredential: (_host, entry) => written.push(entry),
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
      minted,
      redeemed,
      keysUsed,
      deviceFlows: () => deviceFlows,
    };
  }

  /** Resolved auth holding an API key the user never asked this run to use. */
  function ambientKey(source: "config" | "auto-env-file"): ResolvedAuth {
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
      "Signed in as alice@old.example; this handoff is for bob@new.example — switching.",
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
      "Signed in as bob@new.example; this handoff replaced the TraceRoot sign-in already saved on this machine.",
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

  it("redeems the code before any coding agent could read it", () => {
    // A handoff code is live until it is redeemed, and `instrument` hands a
    // coding agent a shell in the user's repository — one that can read shell
    // history and run `ps`. That the code is already spent by then is a
    // property of stage ORDER, which a later reshuffle could quietly break.
    const order = SETUP_PIPELINE.map((definition) => definition.stage);
    expect(order).toEqual([...SETUP_STAGES]);
    expect(order.indexOf("authenticate")).toBeLessThan(order.indexOf("instrument"));
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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

describe("project credential", () => {
  it("reuses a valid key already in the project's .env rather than minting another", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-existing-env-key-99\n");
    let minted = 0;
    const deps = makeDeps({
      auth: authWithKey(),
      // Force the mint/reuse branch by making the user key resolve elsewhere.
      client: fakeApiClient({ whoamiResult: whoami(), traces: [traceRow()] }),
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
        traces: [traceRow()],
      }),
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
    // The file must be untouched.
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("tr-other-project-key-77");
  });

  it("mints a uniquely-named key and never prints it", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
        traces: [traceRow()],
      }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("auto-env-file")));

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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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

    const deps = makeDeps({ auth: authWithKey(), client: fakeApiClient({ traces: [traceRow()] }) });
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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

  it("fails when the application stops working without TraceRoot credentials", async () => {
    pythonRepo();
    let pytestCalls = 0;
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const wrapped: SetupDeps["runProcess"] = async (o) => {
      if (o.program === "pytest") {
        pytestCalls += 1;
        // Three runs: the baseline before anything is instrumented, then the
        // verification pair. Only the last one — the credential-free run — is
        // meant to fail, which is the exact regression it exists to catch.
        return pytestCalls < 3
          ? { exitCode: 0, output: "", durationMs: 1, timedOut: false, spawnFailed: false }
          : {
              exitCode: 1,
              output: "KeyError: TRACEROOT_API_KEY",
              durationMs: 1,
              timedOut: false,
              spawnFailed: false,
            };
      }
      return process.run(o);
    };
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: wrapped,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("APP_VERIFICATION_FAILED");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.APP_VERIFICATION_FAILED);
    expect(result.error?.message).toContain("must keep working when TraceRoot is absent");
    expect(result.error?.message).toContain("KeyError");
  });

  it("fails when no trace arrives before the timeout", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    expect(result.error?.exitCode).toBe(SETUP_EXIT_CODES.TRACE_TIMEOUT);
    expect(result.error?.remedy).toContain("--resume");
  });

  it("ignores traces that predate the run", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        traces: [traceRow({ trace_start_time: "2020-01-01T00:00:00.000Z" })],
      }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 1 } });
    const result = await runSetupMachine(ctx, deps);
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
  });

  it("skips application verification honestly when no command is detectable", async () => {
    // A Python project with no pytest marker: nothing to run.
    writeFileSync(join(dir, "requirements.txt"), "flask\n");
    writeFileSync(join(dir, "app.py"), "x = 1\n");
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", "", " M app.py"] }).run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    // Said nowhere on screen. A repository with no test script is a fact about
    // it rather than something the user did wrong, and a run that reports the
    // absence spends a line on a step it never promised. What must survive is
    // the stage status below — the JSON result still carries the reason, and
    // nothing may claim checks that were never run.
    expect(err.data).not.toContain("No test or health command detected");
    expect(err.data).not.toContain("warning: no test");
    expect(err.data).not.toContain("--verify-command");
    // Nothing anywhere may claim checks that were never run.
    expect(err.data).not.toContain("passes its checks");
    expect(result.stagesRun.find((stage) => stage.stage === "verify_application")?.status).toBe(
      "skipped",
    );
  });

  it("still runs the project's own checks twice when it has one", async () => {
    // The stage is not what was removed, and this is why it exists: the second
    // run, with the key deleted from the environment, is the proof that the
    // instrumentation did not make the application depend on TraceRoot.
    pythonRepo();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });
    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(ctx.application?.command).toBe("pytest");
    expect(ctx.application?.withCredentials.ran).toBe(true);
    expect(ctx.application?.withoutCredentials.ran).toBe(true);
    // The baseline first, then the pair. The baseline carries no credential
    // either, so the pair is identified by position rather than by env.
    const checks = process.runs.filter((run) => run.program === "pytest");
    expect(checks).toHaveLength(3);
    expect(checks[0]?.env.TRACEROOT_API_KEY).toBeUndefined();
    expect(checks[1]?.env.TRACEROOT_API_KEY).toBeDefined();
    expect(checks[2]?.env.TRACEROOT_API_KEY).toBeUndefined();
  });
});

describe("a suite that was already failing", () => {
  /** A run whose project check fails every time it is invoked. */
  function redSuite(): ReturnType<typeof fakeRunProcess> {
    return fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: { pytest: { exitCode: 1, output: "E   assert 1 == 2\n1 failed" } },
    });
  }

  it("does not blame instrumentation for a check that was red beforehand", async () => {
    // A real run ended on "pytest failed after instrumentation" for a suite
    // that was failing before setup started, which sent the user looking for a
    // fault in work that had just been done correctly.
    pythonRepo();
    initGit();
    const process = redSuite();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    // Not a failure, and the run goes on to establish the thing it still can.
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(ctx.application?.outcome).toBe("inconclusive");
    expect(ctx.application?.passed).toBe(false);
    expect(ctx.application?.baseline).toMatchObject({ ran: true, exitCode: 1 });
    expect(result.trace?.traceId).toBe("t_1");
    expect(plain(err.data)).toContain("failing before setup changed anything");

    // Two runs of the suite, not three: the credential-free run exists to show
    // the application works without TraceRoot, which a suite failing either way
    // cannot show, so it is not attempted.
    expect(process.runs.filter((r) => r.program === "pytest")).toHaveLength(2);
  });

  it("carries the outcome into the JSON envelope as its own value", async () => {
    // `passed: false` is true of both a broken suite and broken
    // instrumentation, and a consumer acts on them differently.
    pythonRepo();
    initGit();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: redSuite().run,
    });
    const { ctx, events } = makeCtx({ json: true, flags: { agent: "claude" } });

    await runSetupMachine(ctx, deps);

    const stage = events.find(
      (e) => e.event === "stage" && e.stage === "verify_application" && e.status !== "start",
    );
    expect(stage?.event === "stage" ? stage.data : undefined).toMatchObject({
      outcome: "inconclusive",
      passed: false,
      baseline_exit_code: 1,
    });
    const settled = events.find((e) => e.event === "result");
    expect(settled?.event === "result" ? settled.data : undefined).toMatchObject({
      application_outcome: "inconclusive",
      application_passed: false,
    });
  });

  it("still fails when the check passed before the run and fails after it", async () => {
    // The baseline is what makes the claim attributable, so the message says
    // the thing it can now support.
    pythonRepo();
    initGit();
    let calls = 0;
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const runProcess: SetupDeps["runProcess"] = async (o) => {
      if (o.program === "pytest") {
        calls += 1;
        // The baseline passes; everything after it fails.
        return calls === 1
          ? { exitCode: 0, output: "", durationMs: 1, timedOut: false, spawnFailed: false }
          : { exitCode: 1, output: "boom", durationMs: 1, timedOut: false, spawnFailed: false };
      }
      return process.run(o);
    };
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("APP_VERIFICATION_FAILED");
    expect(plain(result.error?.message ?? "")).toContain(
      "passed before this run instrumented anything, and fails now",
    );
    expect(ctx.application?.outcome).toBe("failed");
  });

  it("takes no baseline on the route that writes the task, and names no cause", async () => {
    // `--no-instrument` writes the instrumentation task and edits nothing, so
    // there is no moment inside the run at which a "before" could be measured —
    // the code changes afterwards, outside this process. The decision is to
    // measure nothing there rather than carry a baseline whose age nothing can
    // check, and the consequence has to be an outcome that names no cause.
    pythonRepo();
    initGit();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: redSuite().run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude", instrument: false } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.checkpoint.applicationBaseline).toBeUndefined();
    // Not a failure of this run, and in the same word the agent route uses for
    // a suite it measured and found red.
    expect(result.error).toBeNull();
    expect(ctx.application?.outcome).toBe("inconclusive");
    expect(ctx.application?.passed).toBe(false);
    const said = plain(err.data);
    expect(said).toContain("nothing ran it before the code was instrumented");
    // And not the other inconclusive sentence, which would assert a prior
    // failure nothing observed.
    expect(said).not.toContain("failing before setup changed anything");
    // The failing output still reaches the user: it is the only diagnostic a
    // run with no baseline has.
    expect(said).toContain("assert 1 == 2");
  });

  it("covers --manual by the same decision as the task-file route", async () => {
    // Both hand the edit over; neither has an "about to change your code"
    // instant inside the run. A decision that held for one and not the other
    // would be a difference with no reason behind it.
    pythonRepo();
    initGit();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: redSuite().run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude", method: "manual" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.checkpoint.applicationBaseline).toBeUndefined();
    expect(result.error).toBeNull();
    expect(ctx.application?.outcome).toBe("inconclusive");
    expect(plain(err.data)).toContain("nothing ran it before the code was instrumented");
  });

  it("runs every check in the virtualenv the real check uses", async () => {
    // The command is `pytest` as the project documents it, which resolves only
    // because the user's shell has the virtualenv activated. Handed the CLI's
    // own environment it fails to spawn, and the measurement the whole
    // mechanism depends on never happens — on the commonest shape of Python
    // project there is.
    pythonRepo();
    initGit();
    const venvPython = join(dir, ".venv", "bin", "python");
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    writeFileSync(venvPython, "");
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    const checks = process.runs.filter((r) => r.program === "pytest");
    expect(checks).toHaveLength(3);
    // All three of them: the baseline, and the two verification runs after it.
    // Asserted together because they are one claim — the comparison is only a
    // comparison if every run is made in the same environment — and because
    // pinning the baseline alone is what let this through the first time. The
    // baseline was handed the interpreter, the verification was not, and a run
    // stopped on `pytest` not being found after the instrumentation had
    // already succeeded. Nothing failed until it was in front of a user.
    for (const check of checks) {
      expect(check.env.PATH).toContain(join(dir, ".venv", "bin"));
    }
    expect(ctx.checkpoint.applicationBaseline).toMatchObject({ ran: true, exitCode: 0 });
  });

  it("says nothing about the suite when the baseline could not run", async () => {
    // An un-run baseline has `exitCode: null`, and `null !== 0`. Warning on the
    // code alone announced that the project's suite does not pass whenever the
    // measurement simply did not happen — a false claim about the user's code,
    // made on every run where the command could not be spawned.
    //
    // Silence about the suite is right here, but it is not the whole answer:
    // a command that cannot spawn cannot be baselined either, so this branch
    // also swallows a spawn failure, and the one thing the user could act on —
    // that `pytest` was never found — does not reach them. Distinguishing the
    // two needs the spawn-failure fields on the verification failure, which
    // arrive with the branch that adds them rather than here, so that is where
    // the distinction is made and tested.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: { pytest: { spawnFailed: true, exitCode: 127 } },
    });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx, err } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.checkpoint.applicationBaseline).toMatchObject({ ran: false, exitCode: null });
    // Nothing is claimed about the project's own suite, which was never
    // measured — and nothing is said about it either way.
    expect(plain(err.data)).not.toContain("does not pass");
    expect(ctx.application?.outcome).toBe("inconclusive");
    // The run carries on rather than failing: nothing was measured, so there is
    // nothing to fail on. What it does not yet do is say that the command could
    // not be started.
    expect(result.error).toBeNull();
    // And it does not claim the suite passes either — only that nothing here
    // established it.
    expect(plain(err.data)).toContain("could not establish whether");
  });

  it("does not retake the baseline on a resumed instrumentation", async () => {
    // A resumed `instrument` stage runs over a worktree the agent may already
    // have edited, where a second measurement would be the wrong thing wearing
    // the name of a baseline.
    pythonRepo();
    initGit();
    const previous = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    previous.applicationBaseline = { ran: true, exitCode: 1, durationMs: 5 };
    const process = redSuite();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({
      resumeFrom: previous,
      flags: { agent: "claude", resume: true },
    });

    const result = await runSetupMachine(ctx, deps);

    expect(result.ok).toBe(true);
    expect(ctx.application?.outcome).toBe("inconclusive");
    expect(ctx.checkpoint.applicationBaseline).toMatchObject({ durationMs: 5 });
    // One run of the suite: the verification's first phase. No baseline, and no
    // credential-free run.
    expect(process.runs.filter((r) => r.program === "pytest")).toHaveLength(1);
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
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
      storedCredential: { sessionToken: makeSecret("tru-saved-token"), expiresAt: null },
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
    // An ingest key can send telemetry and nothing else. Reading traces with it
    // worked only because the trace routes do not enforce scope yet, so this
    // stage would have broken on the day they started to.
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

  it("falls back to a send-only CLI key when this account may not mint one", async () => {
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
        fakeApiClient({
          whoamiResult: async () => whoami({ project_id: "p_other" }),
          traces: [traceRow()],
        }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(result.error).toBeNull();
    expect(importChecks(process.runs)).toEqual([]);
  });
});

describe("proving the agent did something", () => {
  /** An agent's completion block, as it arrives on stdout. */
  function completion(body: Record<string, unknown>, prose = "done"): string {
    return [prose, "```json traceroot-setup-result", JSON.stringify(body), "```"].join("\n");
  }

  it("fails the stage when the agent reports it changed nothing", async () => {
    // Exit 0 means the agent finished, not that it acted. A sandboxed agent
    // blocked from installing or editing reports the block and still exits 0 —
    // and without this the run passes `verify_application` on untouched code,
    // then spends the whole trace timeout before blaming the instrumented path
    // for never running.
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
    // And the run stops here rather than carrying on to the checks that would
    // pass on untouched code.
    expect(result.checkpoint.completedStages).not.toContain("verify_application");
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
    // `verify_application` on untouched code, and spent the whole trace timeout
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
    expect(result.checkpoint.completedStages).not.toContain("verify_application");
    // And the point of failing here: no two-minute wait for a trace that this
    // service cannot emit.
    expect(result.stagesRun.map((s) => s.stage)).not.toContain("verify_trace");
  });

  it("catches an uninstrumented service outside a git repository", async () => {
    // No `.git`, so `observedChangedFiles` is empty however much the agent did
    // or did not do, and an inference from file counts is blind here. Reading
    // the entry point is not.
    pythonRepo();
    const process = fakeRunProcess({ instrument: false });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
    });
    const { ctx } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, deps);

    expect(ctx.stack?.existingInstrumentation.present).toBe(false);
    expect(result.error).toBeNull();
    expect(result.checkpoint.completedStages).toContain("instrument");
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
      "verify_application",
    ] as const) {
      previous.completedStages.push(stage);
    }
    previous.lastError = { stage: "verify_trace", code: "TRACE_TIMEOUT", message: "no trace" };
    writeCheckpoint(dir, previous);

    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
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

  it("does not revoke a minted key when the failure leaves a run to resume", async () => {
    pythonRepo();
    let revoked = 0;
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({
        whoamiResult: async () => whoami({ project_id: "p_other" }),
        traces: [],
      }),
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
        traces: [],
      }),
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
        traces: [],
      }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      /** Let the run finish instead, so the success path is reachable. */
      succeed?: boolean;
      /** Called where the failure happens, while the run is still in flight. */
      atFailure?: () => void;
    } = {},
  ): {
    deps: SetupDeps;
    minted: string[];
    revoked: string[];
  } {
    const minted: string[] = [];
    const revoked: string[] = [];
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
      revokeApiKey: async (id) => {
        if (options.revokeFails === true) {
          throw new Error("the session was revoked while the run was in flight");
        }
        revoked.push(id);
      },
    });
    const deps = makeDeps({
      auth: authEmpty(),
      setupApi,
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      storedCredential: { sessionToken: makeSecret("tru-saved-token"), expiresAt: null },
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

  it("writes a minted key to disk before the run can lose it", async () => {
    // The case this has to survive is a key minted and then not recorded
    // because the process died, and no in-memory list survives that. So the
    // checkpoint is written at the mint rather than at the end of the stage,
    // and this reads it from disk from inside the run, four stages later.
    pythonRepo();
    let midRun: ReturnType<typeof readCheckpoint> = null;
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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

  it("asks when it can, and honours the answer", async () => {
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
      runProcess: process.run,
      answers: ["task-file"],
    });
    const { ctx } = makeCtx({ canPrompt: true, flags: { agent: undefined } });
    await runSetupMachine(ctx, deps);

    expect(process.runs.filter((r) => r.program === "claude")).toHaveLength(0);
    expect(ctx.instrumentation?.promptPath).not.toBeNull();
  });

  /** A PATH with a real, statable `claude` on it, so detection finds one. */
  function withClaudeInstalled(): NodeJS.ProcessEnv {
    mkdirSync(join(dir, "bin"), { recursive: true });
    const binary = join(dir, "bin", "claude");
    writeFileSync(binary, "#!/bin/sh\n");
    // Executable, because that is what "installed" means: resolution checks the
    // execute bit, so a plain file here is not an agent anyone could run.
    chmodSync(binary, 0o755);
    return { PATH: join(dir, "bin") };
  }

  /** Records every question, so the *number* of them can be asserted. */
  function recordingSelect(deps: SetupDeps): {
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
        client: fakeApiClient({ traces: [traceRow()] }),
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
        client: fakeApiClient({ traces: [traceRow()] }),
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

  it("still launches exactly what --agent names", async () => {
    // The flag is an instruction, and it bypasses the question entirely.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { deps, asked } = recordingSelect(
      makeDeps({
        auth: authWithKey(),
        client: fakeApiClient({ traces: [traceRow()] }),
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

describe("the last word before an agent edits the code", () => {
  /** Records every question asked, so the prompt itself can be inspected. */
  function askingDeps(answers: string[]) {
    const asked: Array<{ message: string; options: string[]; initial?: string }> = [];
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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

describe("--no-instrument", () => {
  it("writes the task and stops short of claiming a trace", async () => {
    pythonRepo();
    const deps = makeDeps({
      auth: authWithKey(),
      client: fakeApiClient({ traces: [] }),
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
    expect(result.error?.code).toBe("TRACE_TIMEOUT");
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
      client: fakeApiClient({ traces: [] }),
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
    expect(said).toContain("--agent");
    // And not a word of the question itself.
    expect(said).not.toContain("Which coding agent");
    expect(ctx.agent?.id).toBe("claude");
  });

  it("keeps the choice out of a --json run's event stream", async () => {
    pythonRepo();
    withClaudeConfigured();
    withCodexConfigured();
    const { deps, asked } = askRecorder(handoverDeps());
    const { ctx, out } = makeCtx({
      json: true,
      flags: { instrument: false, traceTimeoutSec: 1 },
    });

    await runSetupMachine(ctx, deps);

    expect(asked).toEqual([]);
    // stdout belongs to the event stream; the note about what was targeted is
    // stderr, like every other thing the run says about itself.
    expect(plain(out.data)).not.toContain("Which coding agent");
    expect(plain(out.data)).not.toContain("Agents set up here");
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
      client: fakeApiClient({ traces: [] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
  }

  it("blames the missing instrumentation, not a program that never ran", async () => {
    // The live failure. `main.py` held zero TraceRoot references and the SDK
    // was not installed, and the run said "nothing has run your application —
    // Run your application once". Running an uninstrumented application again
    // produces the same nothing, so that advice is a loop with no exit; what
    // is outstanding is the instrumentation itself.
    pythonRepoWithoutTests();
    const { ctx, err } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(result.error?.code).toBe("TRACE_TIMEOUT");
    const message = plain(result.error?.message ?? "");
    expect(message).toContain("this service is not instrumented");
    expect(message).toContain(".traceroot/prompts/setup-instrument.md");
    expect(message).not.toContain("nothing has run your application");
    // And the remedy is the one the wizard printed a few lines earlier.
    const remedy = plain(result.error?.remedy ?? "");
    expect(remedy).toContain(".traceroot/prompts/setup-instrument.md");
    expect(remedy).toContain("traceroot setup --resume");
    expect(remedy).not.toContain("Run your application once");
    // Nothing can arrive, so nothing is waited for: no two-minute spinner in
    // front of an answer that was available immediately.
    expect(plain(err.data)).not.toContain("Waiting for your first trace");
  });

  it("says the same thing when the project's own suite did run", async () => {
    // A test command exercising uninstrumented code is still uninstrumented
    // code: "the instrumented code path never ran" would name the wrong one of
    // the two missing halves.
    pythonRepo();
    const { ctx } = makeCtx({ flags: { instrument: false, traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(ctx.application?.withCredentials.ran).toBe(true);
    expect(plain(result.error?.message ?? "")).toContain("this service is not instrumented");
  });

  it("points at the printed steps rather than a file on the manual route", async () => {
    // `--manual` writes no task file, so there is no path to send anyone to.
    pythonRepoWithoutTests();
    const { ctx } = makeCtx({ flags: { method: "manual", traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    const message = plain(result.error?.message ?? "");
    expect(message).toContain("this service is not instrumented");
    expect(message).toContain("printed the manual instructions");
    expect(message).not.toContain(".traceroot/prompts");
    expect(plain(result.error?.remedy ?? "")).toContain("Apply the steps above");
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
    const message = plain(result.error?.message ?? "");
    expect(message).not.toContain("this service is not instrumented");
    expect(message).toContain("No trace arrived within");
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

  it("still blames the unrun application when an agent did the instrumenting", async () => {
    // The other diagnosis has to keep working: here the code *was* changed, and
    // there is no test or health command to exercise it.
    pythonRepoWithoutTests();
    initGit();
    const { ctx } = makeCtx({ flags: { agent: "claude", traceTimeoutSec: 120 } });

    const result = await runSetupMachine(ctx, traceless());

    expect(ctx.instrumentation?.mode).toBe("background");
    const message = plain(result.error?.message ?? "");
    expect(message).toContain("nothing has run your application");
    expect(message).not.toContain("this service is not instrumented");
  });
});

describe("JSON mode", () => {
  it("emits typed stage events and a final result with no secrets", async () => {
    pythonRepo();
    const secret = "tr-live-project-key-abcd";
    const deps = makeDeps({
      auth: authWithKey(secret),
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
        traces: [traceRow()],
      }),
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      "verify_application",
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
      client: fakeApiClient({ traces: [traceRow()] }),
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
      client: fakeApiClient({ traces: [traceRow(trace)] }),
      runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
    });
    const harness = makeCtx({ json: options.json ?? false, flags: { agent: "claude" } });
    return { harness, result: runSetupMachine(harness.ctx, deps) };
  }

  it("says so when the trace it found holds a single span", async () => {
    // The run this closes. The closing report said "TraceRoot is connected and a
    // trace has been received" and named a trace of one span — one instrumented
    // function — so the central claim was true and the user was told their
    // instrumentation worked.
    const { harness, result } = run({ span_count: 1 });
    const outcome = await result;

    // Said, not failed: the credential works and the trace is real.
    expect(outcome.ok).toBe(true);
    expect(outcome.trace?.traceUrl).toBe("https://app.example.test/trace/t_1");
    expect(plain(harness.err.data)).toContain(
      "warning: your first trace holds a single span: one instrumented function ran, and nothing instrumented ran inside it. That is enough to show the credential works, and not enough to show that the instrumentation reaches the code you care about — open the trace and check that the functions you expected to see are in it.",
    );
    // And the line the wait closes on carries the size, which is where a user
    // watching the run sees it first.
    expect(plain(harness.err.data)).toContain("First trace received (a single span).");
    // On the checkpoint, because the report is rendered from it — including by a
    // `--resume` that never polled.
    expect(outcome.checkpoint.trace?.spanCount).toBe(1);
  });

  it("says nothing of the kind about a trace that holds several", async () => {
    const { harness, result } = run({ span_count: 7 });
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(plain(harness.err.data)).not.toContain("warning: your first trace");
    // The count is still reported. "Received" with no size to it is the claim
    // that needed qualifying, and leaving it unqualified for the healthy case
    // would leave a user no way to see the number at all.
    expect(plain(harness.err.data)).toContain("First trace received (7 spans).");
    expect(outcome.checkpoint.trace?.spanCount).toBe(7);
  });

  it("claims no size when the deployment did not report one", async () => {
    // A row without `span_count`. Silence is not evidence of a small trace, so
    // the run says what it always said and records no number.
    const { harness, result } = run({});
    const outcome = await result;

    expect(outcome.ok).toBe(true);
    expect(plain(harness.err.data)).toContain("First trace received.");
    expect(plain(harness.err.data)).not.toContain("warning: your first trace");
    expect(outcome.checkpoint.trace?.spanCount).toBeUndefined();
  });

  it("carries the count into the JSON envelope, and the remark with it", async () => {
    // A machine consumer has only the fields. The sentence reaches it as a
    // `warn` event, and the number behind the sentence is on the stage so
    // nothing has to parse prose to act on it.
    const { harness, result } = run({ span_count: 1 }, { json: true });
    await result;

    const stage = harness.events.find(
      (e) =>
        e.event === "stage" &&
        (e as unknown as { stage: string }).stage === "verify_trace" &&
        e.status === "ok",
    ) as unknown as { data: { span_count: number | null } };
    expect(stage.data.span_count).toBe(1);
    // The sentence itself still reaches stderr, unrailed, because stdout in this
    // mode belongs to the event stream.
    expect(harness.err.data).toContain("warning: your first trace holds a single span:");
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
