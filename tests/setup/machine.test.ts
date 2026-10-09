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
import { BackendUnavailableError, SetupApiError } from "../../src/api/setup.js";
import { openBrowserForPlatform } from "../../src/auth/deviceFlow.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import { CliError, ExitCode } from "../../src/output.js";
import { serviceArtifactDir } from "../../src/setup/artifacts.js";
import { newCheckpoint, readCheckpoint, writeCheckpoint } from "../../src/setup/checkpoint.js";
import { type SetupEvent, jsonEmitter } from "../../src/setup/events.js";
import type { SetupDeps } from "../../src/setup/machine.js";
import { defaultSetupDeps, runSetupMachine, uniqueKeyName } from "../../src/setup/machine.js";
import { makeSecret } from "../../src/setup/secret.js";
import type { SetupContext, SetupFlags } from "../../src/setup/types.js";
import { wizardEmphasis } from "../../src/setup/wizard.js";
import type { StringSink } from "../helpers/stringSink.js";
import { plain } from "./colour.js";
import {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-setup-machine-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal single-service Python repository. */
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

  it("hands the credential to the agent through the environment, not argv", async () => {
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
    expect(agentRun?.args.join(" ")).not.toContain("tr-live-project-key-abcd");
    expect(agentRun?.env.TRACEROOT_API_KEY).toBe("tr-live-project-key-abcd");
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

    const checks = process.runs.filter((r) => r.program === "pytest");
    expect(checks).toHaveLength(2);
    expect(checks[0]?.env.TRACEROOT_API_KEY).toBeDefined();
    // Absent, not empty: an SDK treats "" as configured-but-blank.
    expect("TRACEROOT_API_KEY" in (checks[1]?.env ?? {})).toBe(false);
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
    expect(result.error?.exitCode).toBe(9);
    expect(result.error?.message).toContain("rather than replacing it");
  });

  it("fails with a flag hint when there are no credentials and no way to ask", async () => {
    pythonRepo();
    const deps = makeDeps({ auth: authEmpty() });
    const { ctx } = makeCtx({ canPrompt: false });
    const result = await runSetupMachine(ctx, deps);

    expect(result.error?.code).toBe("NOT_AUTHENTICATED");
    expect(result.error?.exitCode).toBe(2);
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
    expect(attempted).toHaveLength(2);
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
    expect(result.error?.exitCode).toBe(8);
    expect(result.error?.message).toContain("--no-browser");
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

describe("project credential", () => {
  it("reuses a valid key already in .env.traceroot rather than minting another", async () => {
    pythonRepo();
    writeFileSync(join(dir, ".env.traceroot"), "TRACEROOT_API_KEY=tr-existing-env-key-99\n");
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
    writeFileSync(join(dir, ".env.traceroot"), "TRACEROOT_API_KEY=tr-other-project-key-77\n");
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
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toContain("tr-other-project-key-77");
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
    // But it does reach `.env.traceroot`, which is where the app reads it from.
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toContain(
      "tr-minted-secret-value-42",
    );
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
    expect(existsSync(join(dir, ".env.traceroot"))).toBe(false);
  });

  it("names no credential file to the agent when it never wrote one", async () => {
    // The converse of the load the task now carries. This stage is satisfied
    // before it runs when the application can already resolve the key, so there
    // is no `.env.traceroot` on disk — and telling the entry point to load one
    // would trade a credential the app already has for an exception on startup.
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
    expect(existsSync(join(dir, ".env.traceroot"))).toBe(false);
    // The assertion below is a negative one, so it passes for free if the run
    // never got as far as launching an agent. Pin the launch down first.
    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    expect(launch?.stdin ?? "").not.toContain(".env.traceroot");
  });

  it("writes nothing for a key already in the `.env` beside the application", async () => {
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), `TRACEROOT_API_KEY=${KEY}\n`);
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("auto-env-file")));

    expect(result.error).toBeNull();
    // The file an application's own dotenv loader reads really does hold it.
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(KEY);
    expect(statusOf(events, "configure_repository")).toBe("skipped");
    expect(existsSync(join(dir, ".env.traceroot"))).toBe(false);
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
    expect(existsSync(join(dir, ".env.traceroot"))).toBe(false);
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
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toContain(KEY);
  });

  it("writes anyway when there is no `.env` to have resolved from", async () => {
    pythonRepo();
    initGit();
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("auto-env-file")));

    expect(result.error).toBeNull();
    expect(statusOf(events, "configure_repository")).toBe("ok");
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toContain(KEY);
  });

  it("writes anyway when the `.env` holds a different key", async () => {
    // A stale `.env` is not this credential, and the application loading it
    // would authenticate as something else or not at all.
    pythonRepo();
    initGit();
    writeFileSync(join(dir, ".env"), "TRACEROOT_API_KEY=tr-some-other-key\n");
    const { ctx, events } = makeCtx({ flags: { agent: "claude" } });

    const result = await runSetupMachine(ctx, configuredKeyRun(authFrom("auto-env-file")));

    expect(result.error).toBeNull();
    expect(statusOf(events, "configure_repository")).toBe("ok");
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toContain(KEY);
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
      expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toContain(KEY);
    });
  }

  it("writes the pasted key, and ignores the file it wrote", async () => {
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
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toContain(pasted);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env.traceroot");
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
    expect(result.error?.exitCode).toBe(4);
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
    expect(result.error?.exitCode).toBe(5);
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
        // Passes with the key, fails without it — the exact regression the
        // second run exists to catch.
        return pytestCalls === 1
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
    expect(result.error?.exitCode).toBe(6);
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
    expect(result.error?.exitCode).toBe(7);
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
    const checks = process.runs.filter((run) => run.program === "pytest");
    expect(checks).toHaveLength(2);
    expect(checks[0]?.env.TRACEROOT_API_KEY).toBeDefined();
    expect(checks[1]?.env.TRACEROOT_API_KEY).toBeUndefined();
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
    expect(result.error?.exitCode).toBe(5);
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

  it("does not revoke a minted key when the user asked to resume", async () => {
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

  it("revokes a key it minted when a later stage fails without --resume", async () => {
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
    const { ctx } = makeCtx({
      flags: { agent: "claude", project: "demo", traceTimeoutSec: 1 },
    });
    await runSetupMachine(ctx, deps);

    expect(revoked).toBe("ak_1");
    // The rolled-back credential is gone from the env file too.
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).not.toContain(
      "tr-minted-secret-value-42",
    );
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
    expect(readFileSync(join(sub, ".env.traceroot"), "utf8")).toContain(
      "tr-minted-secret-value-42",
    );
    expect(existsSync(join(sub, ".traceroot", "setup.json"))).toBe(true);
    // And nothing of ours left at the root.
    expect(existsSync(join(dir, ".env.traceroot"))).toBe(false);
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

  it("ignores the credential at the path it actually landed at", async () => {
    // The entry has to name `test1/.env.traceroot`. Getting this wrong commits
    // an API key, which is the one mistake in this file that cannot be undone.
    pythonRepo();
    initGit();
    const sub = subService();
    const { ctx } = makeCtx({ cwd: sub, flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps());

    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("test1/.env.traceroot");
  });

  it("heads the credential file it creates with what it is", async () => {
    pythonRepo();
    initGit();
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps());

    const written = readFileSync(join(dir, ".env.traceroot"), "utf8");
    expect(written.startsWith("# Written by `traceroot setup`.")).toBe(true);
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

    expect(existsSync(join(dir, ".env.traceroot"))).toBe(true);
    expect(existsSync(join(dir, ".traceroot", "setup.json"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env.traceroot");
  });

  it("tells the agent to load the credential file, on a repository with no env file of its own", async () => {
    // The whole point of the file, and the case it never used to reach.
    // `pythonRepo()` writes a manifest and an entry point and nothing else —
    // no `.env`, no `.env.local` — which is what a project `traceroot setup` is
    // run on actually looks like. The task's dotenv block was gated on the
    // app's own env files, so on exactly this repository it was omitted, and
    // the run finished having written a credential to disk that nothing would
    // ever read.
    pythonRepo();
    initGit();
    const process = fakeRunProcess({ gitStatus: ["", " M main.py"] });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });
    await runSetupMachine(ctx, mintingDeps(process.run));

    const task = process.runs.find((run) => run.program === "claude")?.stdin ?? "";
    expect(task).toContain('load_dotenv("./.env.traceroot")');
    expect(task).toContain("Add `python-dotenv` to the dependency manifest");
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
    writeFileSync(join(dir, ".env.traceroot"), "# committed by mistake\n");
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      // `git status` is answered above this, and `ls-files` is the only other
      // git call setup makes — so this reports the file as tracked.
      results: { git: { output: ".env.traceroot\n" } },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    await runSetupMachine(ctx, mintingDeps(process.run));

    // Untouched is the proof the write was refused: the stage overwrites this
    // file whenever it is allowed to.
    expect(readFileSync(join(dir, ".env.traceroot"), "utf8")).toBe("# committed by mistake\n");
    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    expect(launch?.stdin ?? "").not.toContain(".env.traceroot");
  });

  it("survives a credential file it cannot read, rather than failing the stage", async () => {
    // Checking that the file holds this run's key means reading it, and the
    // reader swallows only a missing file — `EACCES`, a directory of that name
    // and a parse failure all come back out. This is called while the agent's
    // task is being built, so a throw there fails instrumentation and rolls it
    // back, over a file whose only consequence was whether a path got named.
    pythonRepo();
    initGit();
    mkdirSync(join(dir, ".env.traceroot"));
    const process = fakeRunProcess({
      gitStatus: ["", " M main.py"],
      results: { git: { output: ".env.traceroot\n" } },
    });
    const { ctx } = makeCtx({ flags: { agent: "claude", project: "demo" } });

    const result = await runSetupMachine(ctx, mintingDeps(process.run));

    expect(result.error).toBeNull();
    const launch = process.runs.find((run) => run.program === "claude");
    expect(launch).toBeDefined();
    expect(launch?.stdin ?? "").not.toContain(".env.traceroot");
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
    const named = /load_dotenv\("([^"]*\.env\.traceroot)"\)/.exec(launch?.stdin ?? "")?.[1];
    expect(named).toBeDefined();
    // Resolved from where the agent stands, it has to land on the file the run
    // actually wrote.
    expect(resolve(launch?.cwd ?? "", named ?? "")).toBe(join(dir, "test1", ".env.traceroot"));
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
