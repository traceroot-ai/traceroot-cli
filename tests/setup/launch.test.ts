import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunProcessResult, runProcess } from "../../src/setup/exec.js";
import {
  buildAgentEnv,
  buildInvocation,
  launchAgent,
  prepareWritableDir,
  resolveNpmCacheDir,
  shadowingApiKey,
} from "../../src/setup/launch.js";
import { makeSecret } from "../../src/setup/secret.js";
import { buildSetupTask, taskPrograms } from "../../src/setup/task.js";
import type { DetectedService } from "../../src/setup/types.js";
import { fakeRunProcess } from "./helpers.js";

/**
 * The rules `--allowedTools` carries, as argv presents them.
 *
 * The flag is variadic, so its value is every token up to the next flag — which
 * is also the reason the tests below read it as a slice rather than looking for
 * a single argument.
 */
function allowRules(args: readonly string[]): string[] {
  const at = args.indexOf("--allowedTools");
  if (at === -1) {
    return [];
  }
  const rest = args.slice(at + 1);
  const end = rest.findIndex((arg) => arg.startsWith("-"));
  return end === -1 ? [...rest] : rest.slice(0, end);
}

describe("reaching a skill that lives outside the working directory", () => {
  it("passes each readable directory as its own --add-dir", () => {
    const invocation = buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      // Two, because with one the argv is identical whether the flag repeats or
      // is emitted once with a list — which is the thing this asserts.
      readableDirs: ["/repo", "/other"],
    });
    expect(invocation.args.slice(0, 4)).toEqual(["--add-dir", "/repo", "--add-dir", "/other"]);
  });

  it("adds nothing when the agent already stands where it needs to read", () => {
    const invocation = buildInvocation({ agentId: "claude", task: "t", interactive: false });
    expect(invocation.args).not.toContain("--add-dir");
  });

  it("keeps --add-dir clear of the variadic flag that would swallow it", () => {
    // `--disallowedTools` takes an unbounded list. Anything after it that is
    // not another flag is read as one more tool name.
    const invocation = buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      readableDirs: ["/repo"],
    });
    expect(invocation.args.indexOf("--add-dir")).toBeLessThan(
      invocation.args.indexOf("--disallowedTools"),
    );
  });
});

describe("which agents can be launched at all", () => {
  it("refuses an agent setup has no verified way to drive", () => {
    // Setup only offers the agents in `LAUNCHABLE_AGENTS`, so nothing should
    // reach here with another id — and if something does, failing at the
    // invocation is better than spawning a run whose sandbox, network and
    // package-manager cache nobody has established.
    expect(() => buildInvocation({ agentId: "generic", task: "t", interactive: false })).toThrow(
      /cannot be launched/,
    );
  });

  it("refuses a Codex run it has no established interactive form for", () => {
    // The headless `codex exec` invocation is the one this CLI worked out of
    // Codex's documentation. How the TUI takes a starting prompt is not, and
    // nothing in the pipeline asks for it — so the honest answer is to fail
    // naming the gap rather than to invent the flag that would fill it.
    expect(() => buildInvocation({ agentId: "codex", task: "t", interactive: true })).toThrow(
      /cannot be launched interactively/,
    );
  });
});

describe("driving Codex headless", () => {
  function codex(extra: Partial<Parameters<typeof buildInvocation>[0]> = {}) {
    return buildInvocation({ agentId: "codex", task: "t", interactive: false, ...extra });
  }

  it("runs the non-interactive subcommand and takes the prompt on stdin", () => {
    const invocation = codex();
    expect(invocation.program).toBe("codex");
    expect(invocation.args[0]).toBe("exec");
    expect(invocation.interactive).toBe(false);
    // `-` is Codex's documented "read the prompt from stdin", and it is the
    // positional argument, so it has to be last or it is read as a flag's value.
    expect(invocation.promptVia).toBe("stdin");
    expect(invocation.args.at(-1)).toBe("-");
  });

  it("asks for the sandbox that can write, since exec defaults to read-only", () => {
    // The equivalent of Claude's `--permission-mode acceptEdits`, and not
    // optional: `codex exec` is read-only by default, so without this the agent
    // reads the task and cannot write a line of the instrumentation.
    const { args } = codex();
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("never passes a bypass-everything switch", () => {
    // The same rule the Claude path follows: a first-run install must not teach
    // a user to disable their agent's safety rails.
    const joined = codex().args.join(" ");
    expect(joined).not.toContain("--yolo");
    expect(joined).not.toContain("dangerously-bypass");
    expect(joined).not.toContain("danger-full-access");
    // `--full-auto` is documented as no longer supported, so passing it would
    // fail the run at the moment the user is watching.
    expect(joined).not.toContain("--full-auto");
  });

  it("turns the sandbox's network on, because the task starts with an install", () => {
    // Under `workspace-write` the sandbox has no network access by default. The
    // first thing this task asks for is `pip install` or `npm install`.
    //
    // Paired with its `-c`, not merely present: a dropped flag leaves the
    // setting as a stray positional, which `codex exec` reads as part of the
    // prompt — and since an unrecognised config key only warns, the run would
    // go on with the sandbox's network off and still exit 0.
    const { args } = codex();
    const at = args.indexOf("sandbox_workspace_write.network_access=true");
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe("-c");
  });

  it("pins the approval policy rather than inheriting the user's config", () => {
    // A captured run has nobody to approve anything, and the policy otherwise
    // comes from `$CODEX_HOME/config.toml` — a file setup has never read.
    const { args } = codex();
    const at = args.indexOf('approval_policy="never"');
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe("-c");
  });

  it("keeps colour out of the output the completion block is parsed from", () => {
    // `parseCompletion` finds a fenced block by regex, and the "exited 0 having
    // changed nothing" check depends on that parse. A user with FORCE_COLOR
    // exported must not be able to break it.
    const { args } = codex();
    expect(args[args.indexOf("--color") + 1]).toBe("never");
  });

  it("starts outside a git repository, which setup supports and exec refuses", () => {
    expect(codex().args).toContain("--skip-git-repo-check");
  });

  it("turns the shell snapshot off, so the user's profile cannot replace the key", () => {
    // The snapshot re-applies the user's shell-profile exports to every command
    // Codex runs. In a recorded run that put a production key over the staging
    // one setup had injected, and the application got a 401.
    //
    // Paired with its `-c` for the same reason as the network setting above.
    const { args } = codex();
    const at = args.indexOf("features.shell_snapshot=false");
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe("-c");
  });

  it("passes each writable directory as its own --add-dir, ahead of the prompt", () => {
    // Two, because with one the argv is identical whether the flag repeats or
    // is emitted once with a list.
    const { args } = codex({ writableDirs: ["/home/u/.npm", "/other"] });
    expect(args.slice(-5)).toEqual(["--add-dir", "/home/u/.npm", "--add-dir", "/other", "-"]);
  });

  it("adds no --add-dir when nothing outside the workspace has to be written", () => {
    expect(codex().args).not.toContain("--add-dir");
    expect(codex({ writableDirs: [] }).args).not.toContain("--add-dir");
  });

  it("builds one argv, in one order", () => {
    // The whole list, so a setting cannot move, repeat or go missing without
    // this saying so.
    expect(codex({ writableDirs: ["/home/u/.npm"] }).args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--color",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'approval_policy="never"',
      "-c",
      "features.shell_snapshot=false",
      "--add-dir",
      "/home/u/.npm",
      "-",
    ]);
  });

  it("claims no activity format, so no parser is pointed at its output", () => {
    // Codex's `--json` event names differ between releases, and the recorded
    // runs did not pass `--json`, so nothing has settled which. A feed built on
    // a guessed schema reads as a record of what the agent did.
    expect(codex().activityFormat).toBe("none");
    expect(codex().args).not.toContain("--json");
    // And Claude's, which this parser *was* written against, still declares it.
    expect(
      buildInvocation({ agentId: "claude", task: "t", interactive: false }).activityFormat,
    ).toBe("claude-stream-json");
  });

  it("silently drops the Claude-shaped options it has no mechanism for", () => {
    // Claude's `--add-dir` answers a read scope Codex does not have (Codex's
    // flag of that name grants writes, and only `writableDirs` drives it), and
    // there is no per-program allow list to translate `Bash(prog:*)` into.
    // Leaving the flags off is the decision; emitting a nearest-looking one is
    // not.
    const { args } = codex({ readableDirs: ["/repo"], allowedPrograms: ["python3"] });
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--allowedTools");
    expect(args.join(" ")).not.toContain("python3");
    // And nothing from the other agent's permission vocabulary leaked in.
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--permission-mode");
  });

  it("keeps the task off argv and out of the process table", async () => {
    const { run, runs } = fakeRunProcess();
    await launchAgent({
      invocation: codex(),
      task: "instrument this service",
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret("tr-a-long-enough-credential"),
      credentialFiles: [],
      host: "https://api.example.test",
      runProcess: run,
    });

    const launched = runs[0];
    expect(launched?.program).toBe("codex");
    expect(launched?.stdin).toBe("instrument this service");
    expect(launched?.args.join(" ")).not.toContain("instrument this service");
    // `-` survives the launch as the last argument, which is the whole reason
    // the prompt reaches the process at all.
    expect(launched?.args.at(-1)).toBe("-");
    expect(launched?.env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
  });
});

describe("Claude Code, which the writable directories do not reach", () => {
  const base = {
    agentId: "claude" as const,
    task: "t",
    readableDirs: ["/repo"],
    allowedPrograms: ["python3"],
  };

  it("builds the same invocation with them as without, in both modes", () => {
    // Its recorded npm runs wrote the cache with nothing named, so nothing here
    // is allowed to change what it is launched with.
    for (const interactive of [true, false]) {
      expect(buildInvocation({ ...base, interactive, writableDirs: ["/home/u/.npm"] })).toEqual(
        buildInvocation({ ...base, interactive }),
      );
    }
  });

  it("keeps the headless argv it had", () => {
    expect(
      buildInvocation({ ...base, interactive: false, writableDirs: ["/home/u/.npm"] }).args,
    ).toEqual([
      "--add-dir",
      "/repo",
      "--allowedTools",
      "Read(**)",
      "Edit(**)",
      "Bash(python3:*)",
      "Bash(TRACEROOT_ENABLED=false python3:*)",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--disallowedTools",
      "EnterPlanMode",
      "Task",
      "Agent",
      "--permission-mode",
      "acceptEdits",
    ]);
  });
});

describe("finding the npm cache a sandboxed agent has to write", () => {
  /** Resolves against an npm that answers `npm`, with `/home/u` as the home directory. */
  function resolveWith(npm: Partial<RunProcessResult>, env: NodeJS.ProcessEnv = {}) {
    const { run, runs } = fakeRunProcess({ results: { npm } });
    return {
      runs,
      resolved: resolveNpmCacheDir({ env, runProcess: run, homeDir: "/home/u" }),
    };
  }

  it("takes npm's own answer, asked from the home directory", async () => {
    // The user's `.npmrc` can move the cache, and npm is the one that knows.
    const { runs, resolved } = resolveWith({ output: "/home/u/.cache/npm\n" });
    expect(await resolved).toBe("/home/u/.cache/npm");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.program).toBe("npm");
    expect(runs[0]?.args).toEqual([
      "config",
      "get",
      "cache",
      "--loglevel=silent",
      "--no-update-notifier",
    ]);
    // Never the project: npm reads the `.npmrc` of the directory it runs in,
    // and the project's is the repository's to write.
    expect(runs[0]?.cwd).toBe("/home/u");
  });

  it("falls back to npm_config_cache when npm cannot answer", async () => {
    const failures = [
      { spawnFailed: true, exitCode: 127 },
      // What npm 10 says when an `.npmrc` sets a relative cache.
      { exitCode: 1, output: "npm error The cache option is protected" },
      { timedOut: true, exitCode: 143 },
    ];
    for (const failure of failures) {
      const { resolved } = resolveWith(failure, { npm_config_cache: "/home/u/env-cache" });
      expect(await resolved).toBe("/home/u/env-cache");
    }
  });

  it("falls back to ~/.npm when neither npm nor the environment says", async () => {
    const { resolved } = resolveWith({ spawnFailed: true, exitCode: 127 });
    expect(await resolved).toBe(join("/home/u", ".npm"));
  });

  it("does not take a warning, a relative path or nothing as the answer", async () => {
    // The runner hands back stdout and stderr as one string.
    for (const output of ["npm warn something\n/home/u/.npm-other\n", "relcache\n", ""]) {
      const { resolved } = resolveWith({ output });
      expect(await resolved).toBe(join("/home/u", ".npm"));
    }
  });

  it("opens nothing outside the home directory, nor the home directory or above it", async () => {
    // Codex runs with the network on and no approval prompts, so this
    // directory is as far as anything in the repository can write. A cache set
    // to `/` made the whole disk writable.
    for (const outside of ["/", "/home", "/home/u", "/home/u/", "/etc/npm", "/home/u/../v/.npm"]) {
      const fromNpm = resolveWith({ output: `${outside}\n` });
      expect(await fromNpm.resolved).toBe(join("/home/u", ".npm"));
      // The environment gets the same check, and a relative value is no path.
      const fromEnv = resolveWith(
        { spawnFailed: true, exitCode: 127 },
        { npm_config_cache: outside },
      );
      expect(await fromEnv.resolved).toBe(join("/home/u", ".npm"));
    }
    const relative = resolveWith(
      { spawnFailed: true, exitCode: 127 },
      { npm_config_cache: "cache" },
    );
    expect(await relative.resolved).toBe(join("/home/u", ".npm"));
  });

  it("opens nothing through a link in the home directory that points out of it", async () => {
    // The sandbox is handed the resolved path, so the link is what it opens.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tr-npm-home-")));
    try {
      symlinkSync("/", join(home, "everything"));
      const { run } = fakeRunProcess({
        results: { npm: { output: `${join(home, "everything")}\n` } },
      });
      expect(await resolveNpmCacheDir({ env: {}, runProcess: run, homeDir: home })).toBe(
        join(home, ".npm"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("opens nothing through a link when the cache below it does not exist yet", async () => {
    // A fresh cache is created after this check, and creating it follows the
    // link: `~/link/npm-cache` with `~/link` pointing outside becomes a
    // directory outside the home directory.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tr-npm-home-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "tr-npm-outside-")));
    try {
      symlinkSync(outside, join(home, "link"));
      mkdirSync(join(home, "real"));
      symlinkSync(join(home, "real"), join(home, "inner"));
      const answer = async (path: string) => {
        const { run } = fakeRunProcess({ results: { npm: { output: `${path}\n` } } });
        return resolveNpmCacheDir({ env: {}, runProcess: run, homeDir: home });
      };

      expect(await answer(join(home, "link", "npm-cache"))).toBe(join(home, ".npm"));
      expect(await answer(join(home, "link", "a", "b"))).toBe(join(home, ".npm"));
      // A link that stays inside the home directory is still fine.
      expect(await answer(join(home, "inner", "npm-cache"))).toBe(join(home, "inner", "npm-cache"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not let the project's .npmrc choose the directory, with the real npm", async () => {
    // The report: a project `.npmrc` with `cache=/` built `--add-dir /`, and
    // `cache=~/.ssh` made `~/.ssh` writable. `~/.ssh` is inside the home
    // directory, so only asking from outside the project stops that one.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tr-npm-home-")));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "tr-npm-project-")));
    try {
      writeFileSync(join(project, "package.json"), '{"name":"app"}\n');
      writeFileSync(join(project, ".npmrc"), `cache=${join(home, ".ssh")}\n`);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      for (const name of ["npm_config_cache", "NPM_CONFIG_CACHE", "npm_config_userconfig"]) {
        delete env[name];
      }
      // The same npm, asked in the project, gives the project's line: that is
      // the question setup used to ask.
      const inProject = await runProcess({
        program: "npm",
        args: ["config", "get", "cache", "--loglevel=silent", "--no-update-notifier"],
        cwd: project,
        env,
        stdio: "capture",
        timeoutMs: 15_000,
      });
      expect(inProject.output.trim()).toBe(join(home, ".ssh"));

      const resolved = await resolveNpmCacheDir({ env, runProcess, homeDir: home });

      expect(resolved).toBe(join(home, ".npm"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("making the npm cache exist before the sandbox needs it", () => {
  let base: string;
  beforeEach(() => {
    // Real, because `/var` on macOS is itself a link and the answer is a real path.
    base = realpathSync(mkdtempSync(join(tmpdir(), "tr-writable-dir-")));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("creates a cache that is not there yet, parents included", () => {
    // A fresh machine has no `~/.npm` until npm's first run, and that run is
    // the sandboxed one, which cannot create it.
    const dir = join(base, "home", ".npm");
    expect(prepareWritableDir(dir)).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("leaves an existing cache as it is", () => {
    const dir = join(base, ".npm");
    mkdirSync(join(dir, "_cacache"), { recursive: true });
    writeFileSync(join(dir, "_cacache", "index"), "kept");
    const before = statSync(dir);

    expect(prepareWritableDir(dir)).toBe(dir);
    expect(readdirSync(dir)).toEqual(["_cacache"]);
    expect(readFileSync(join(dir, "_cacache", "index"), "utf8")).toBe("kept");
    expect(statSync(dir).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(dir).mode).toBe(before.mode);
  });

  it("names a linked cache by its target, which Codex's sandbox accepts", () => {
    // Codex's macOS sandbox refuses a writable root with a symlink in it, and
    // refuses it for every command.
    const target = join(base, "other-disk", "npm-cache");
    mkdirSync(target, { recursive: true });
    const link = join(base, ".npm");
    symlinkSync(target, link);
    expect(prepareWritableDir(link)).toBe(target);
  });

  it("returns null when the directory cannot be made", () => {
    // A file where the cache, or one of its parents, would have to be.
    writeFileSync(join(base, "blocker"), "");
    expect(prepareWritableDir(join(base, "blocker"))).toBeNull();
    expect(prepareWritableDir(join(base, "blocker", ".npm"))).toBeNull();
  });
});

describe("keeping the run to one agent", () => {
  it("denies the subagent tools in both modes", () => {
    // A subagent inherits the parent's file access, so it cannot read what the
    // parent could not — but it takes minutes to discover that. One measured
    // run lost 147 seconds, 37% of the total, to a subagent sent to read a
    // source tree outside the allowed directories.
    for (const interactive of [true, false]) {
      const { args } = buildInvocation({ agentId: "claude", task: "t", interactive });
      expect(args).toContain("Task");
      expect(args).toContain("Agent");
      expect(args.indexOf("Task")).toBeGreaterThan(args.indexOf("--disallowedTools"));
    }
  });

  it("still ends the variadic list before the flag that follows it", () => {
    // `--disallowedTools` swallows everything until the next flag, so the
    // extra names must not push `--permission-mode` out of the list.
    const { args } = buildInvocation({ agentId: "claude", task: "t", interactive: false });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });
});

describe("letting the agent run what it was told to run", () => {
  it("allows each named program, before the variadic deny list", () => {
    // `acceptEdits` accepts edits and nothing else. A non-interactive run has
    // nobody to ask about a Bash call, so an unlisted program is refused — and
    // the agent finds out only by trying, at the end of a run it has otherwise
    // finished. One measured pass instrumented the code correctly, tried to run
    // it twice, was refused both times, and emitted no trace at all.
    const { args } = buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      allowedPrograms: ["/repo/.venv/bin/python", "python3"],
    });
    expect(args).toContain("Bash(/repo/.venv/bin/python:*)");
    expect(args).toContain("Bash(python3:*)");
    expect(args.indexOf("--allowedTools")).toBeLessThan(args.indexOf("--disallowedTools"));
  });

  it("allows each named program behind TRACEROOT_ENABLED=false as well", () => {
    // The task tells the agent to run the project's checks as
    // `TRACEROOT_ENABLED=false <command>`, so its own test runs send no traces.
    // Claude Code matches a rule against the start of the command, and an
    // environment assignment is the start: a headless run given only
    // `Bash(python3:*)` refused the prefixed command as needing approval.
    const programs = ["/repo/.venv/bin/python", "python3", "npm"];
    const { args } = buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      allowedPrograms: programs,
    });
    for (const program of programs) {
      expect(args).toContain(`Bash(${program}:*)`);
      expect(args).toContain(`Bash(TRACEROOT_ENABLED=false ${program}:*)`);
    }
    // Two per program and no more: the assignment is never a rule on its own,
    // which would let anything at all follow it.
    expect(args).not.toContain("Bash(TRACEROOT_ENABLED=false:*)");
    expect(args.filter((arg) => arg.startsWith("Bash(")).length).toBe(programs.length * 2);
  });

  it("allows the check exactly as the task hands it over", () => {
    // Read back from the task rather than restated, so a change to how step 5
    // spells the check moves this expectation with it.
    const text = buildSetupTask({
      service: {
        path: ".",
        language: "typescript",
        framework: null,
        entryPoint: "src/index.ts",
        packageManager: "npm",
        testCommand: "npm test",
        evidence: [],
      } as unknown as DetectedService,
      root: "/repo",
      sdk: { package: "@traceroot-ai/traceroot", version: "1.2.3", source: "registry" },
      skillPath: ".claude/skills/traceroot-instrument-repo",
      verifyCommand: "npm test",
      interactive: false,
      existingInstrumentation: [],
      credentialFiles: [],
    });
    const command = /1\. Run `([^`]+)` once and confirm it passes\./.exec(text)?.[1];
    expect(command).toBe("TRACEROOT_ENABLED=false npm test");
    const [assignment, program] = (command as string).split(" ");
    const { args } = buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      allowedPrograms: ["npm"],
    });
    expect(args).toContain(`Bash(${assignment} ${program}:*)`);
  });

  it("still allows the file tools when there is no program to allow", () => {
    // The flag used to be dropped entirely here, which tied the agent's ability
    // to edit the service to whether that service happened to come with an
    // interpreter worth naming.
    const { args } = buildInvocation({ agentId: "claude", task: "t", interactive: false });
    expect(args).toContain("--allowedTools");
    expect(allowRules(args)).toEqual(["Read(**)", "Edit(**)"]);
  });
});

describe("letting the agent edit the service it was pointed at", () => {
  it("permits the file tools, not only the named programs", () => {
    // Regression. Two consecutive live runs ended identically: `Claude Code
    // finished.`, exit 0, the SDK installed into the service's `.venv`, and
    // `main.py` untouched — an agent that had run Bash and never changed a
    // file. Every command it needed was pinned by a rule; the one capability
    // the whole stage exists for was the only thing in the argv that nothing
    // stated, and it held only while `--permission-mode acceptEdits` did.
    //
    // Asserting that the `Bash(...)` rules are present is what let that
    // through, so this asserts the part whose absence was the failure — and
    // asserts the programs in the same breath, so the fix cannot be read as
    // trading one for the other.
    const { args } = buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      allowedPrograms: ["./.venv/bin/python", "python3"],
    });
    const rules = allowRules(args);
    // `Edit(path)` is the matcher that covers Edit, Write and NotebookEdit.
    // There is no `Write(path)` rule to write: one written for `Write` is
    // accepted and never consulted.
    expect(rules).toContain("Edit(**)");
    expect(rules).toContain("Read(**)");
    expect(rules).toContain("Bash(./.venv/bin/python:*)");
    expect(rules).toContain("Bash(python3:*)");
  });

  it("permits them in an interactive run too", () => {
    const rules = allowRules(
      buildInvocation({
        agentId: "claude",
        task: "t",
        interactive: true,
        allowedPrograms: ["python3"],
      }).args,
    );
    expect(rules).toContain("Edit(**)");
    expect(rules).toContain("Read(**)");
  });

  it("keeps the file rules scoped to the service and never restricts the toolset", () => {
    const { args } = buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      allowedPrograms: ["python3"],
    });
    // `**` anchors at the working directory, which is the service. A bare
    // `Edit` or `Write` would pre-approve a write anywhere on the disk —
    // wider than the `acceptEdits` mode these rules exist to back up.
    expect(args).not.toContain("Edit");
    expect(args).not.toContain("Write");
    expect(args).not.toContain("NotebookEdit");
    // `--allowedTools` pre-approves and takes nothing away. `--tools` is the
    // flag that would cut the agent down to a list, and it is never passed.
    expect(args).not.toContain("--tools");
  });
});

describe("the interpreter the task recommends and the one the agent may run", () => {
  const ROOT = "/repo";
  const SERVICE_PATH = "api";
  const SDK = { package: "traceroot", version: "1.2.3", source: "registry" } as const;

  /** A Python service on pip unless a case says otherwise. */
  function service(overrides: Partial<DetectedService> = {}): DetectedService {
    return {
      path: SERVICE_PATH,
      language: "python",
      framework: null,
      entryPoint: "main.py",
      packageManager: "pip",
      testCommand: null,
      evidence: [],
      ...overrides,
    } as unknown as DetectedService;
  }

  function task(
    pythonInterpreter: string | null,
    overrides: Partial<DetectedService> = {},
  ): string {
    const detected = service(overrides);
    return buildSetupTask({
      service: detected,
      root: ROOT,
      sdk: SDK,
      skillPath: ".claude/skills/traceroot-instrument-repo",
      // From the service, as the instrument stage takes it, so a fixture's
      // check reaches the task and the rules by the same route.
      verifyCommand: detected.testCommand,
      interactive: false,
      existingInstrumentation: [],
      pythonInterpreter,
      credentialFiles: [],
    });
  }

  function rules(
    pythonInterpreter: string | null,
    overrides: Partial<DetectedService> = {},
  ): string[] {
    const detected = service(overrides);
    return buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      // The call the instrument stage makes, so a program the task names is
      // asserted against the rules the launched agent is actually given.
      allowedPrograms: taskPrograms({
        service: detected,
        root: ROOT,
        sdk: SDK,
        pythonInterpreter,
        verifyCommand: detected.testCommand,
      }),
    }).args;
  }

  /**
   * The program out of the task's own run command, read back rather than
   * restated. Both halves of each assertion below therefore come from the
   * prose, so a change to how the task names the interpreter moves the
   * expectation with it instead of leaving it behind.
   */
  function programInRunCommand(text: string): string {
    const command = /run it with: `([^`]+)`/.exec(text)?.[1];
    expect(command).toBeDefined();
    return (command as string).split(" ")[0] ?? "";
  }

  /** The same, for the one command step 2 of the task hands over in full. */
  function programInInstallCommand(text: string): string {
    const command = /### 2\. Install the SDK[\s\S]*?```bash\n([^\n]+)\n```/.exec(text)?.[1];
    expect(command).toBeDefined();
    return (command as string).split(" ")[0] ?? "";
  }

  /**
   * The interpreter word step 2's pip command starts with, as written — quotes,
   * escapes and any space in the path included, which `split(" ")` would cut.
   */
  function interpreterInPipInstall(text: string): string {
    const command = /### 2\. Install the SDK[\s\S]*?```bash\n([^\n]+)\n```/.exec(text)?.[1] ?? "";
    const at = command.indexOf(" -m pip install ");
    expect(at, "step 2 is a pip install through a named interpreter").toBeGreaterThan(0);
    return command.slice(0, at);
  }

  /** And for the check the task tells the agent to run once, when one exists. */
  /**
   * How the check in step 5 starts, as a rule has to name it: the
   * `TRACEROOT_ENABLED=false` the task puts in front of it, then the program.
   */
  function programInCheckCommand(text: string): string {
    const command = /1\. Run `([^`]+)` once and confirm it passes\./.exec(text)?.[1];
    expect(command).toBeDefined();
    const [assignment, program] = (command as string).split(" ");
    expect(assignment).toBe("TRACEROOT_ENABLED=false");
    return `${assignment} ${program}`;
  }

  it("allows the relative spelling the run command uses for a virtualenv in the tree", () => {
    const interpreter = "/repo/api/.venv/bin/python";
    const named = programInRunCommand(task(interpreter));
    // Non-vacuous only because the two spellings differ. The absolute path is
    // the one a caller has in hand, and it is not the one the task gives.
    expect(named).not.toBe(interpreter);
    expect(rules(interpreter)).toContain(`Bash(${named}:*)`);
    // And the install step's spelling: absolute, and single-quoted for the
    // shell. A rule matches the start of a command literally, so the quotes are
    // part of what it has to name — the unquoted rule does not cover it.
    const installed = interpreterInPipInstall(task(interpreter));
    expect(installed).toBe(`'${interpreter}'`);
    expect(rules(interpreter)).toContain(`Bash(${installed}:*)`);
    // The unquoted absolute path stays allowed beside it.
    expect(rules(interpreter)).toContain(`Bash(${interpreter}:*)`);
  });

  it("allows the quoted interpreter whole when its path has a space or a quote", () => {
    // A repository path routinely contains a space, and the pip command closes
    // and re-opens its quoting around a `'`. Split on whitespace, the word is
    // cut in two and the rule names a path that is not the interpreter.
    const interpreter = "/opt/it's here/bin/python3";
    const installed = interpreterInPipInstall(task(interpreter));
    expect(installed).toContain(" ");
    expect(installed).toContain("'\\''");
    expect(rules(interpreter)).toContain(`Bash(${installed}:*)`);
  });

  it("allows the absolute spelling when the interpreter sits outside the repository", () => {
    const interpreter = "/opt/homebrew/bin/python3";
    const named = programInRunCommand(task(interpreter));
    expect(named).toBe(interpreter);
    expect(rules(interpreter)).toContain(`Bash(${interpreter}:*)`);
  });

  it("allows the virtualenv the task tells a service without one to create", () => {
    // Not covered by `python3` or `python` being allowed outright: the task
    // says to stop using those and use the new virtualenv from then on, and a
    // permission rule matches the start of a command literally.
    const named = /run the application with `([^`]+)` throughout/.exec(task(null))?.[1];
    expect(named).toBeDefined();
    expect(rules(null)).toContain(`Bash(${named}:*)`);
  });

  it("allows the program the run command names for a TypeScript entry point", () => {
    // `npx tsx <entry>`, which is the run line for 8 of the 13 entry points in
    // `NODE_ENTRY_POINTS`. Unallowed, a headless run has nobody to ask, so the
    // call is refused: the service is instrumented, never once executed, and
    // the trace wait ends up reporting that the instrumented path never ran —
    // true, and the symptom rather than the denial.
    const ts: Partial<DetectedService> = {
      language: "typescript",
      entryPoint: "src/index.ts",
      packageManager: "npm",
    };
    const named = programInRunCommand(task(null, ts));
    expect(named).toBe("npx");
    expect(rules(null, ts)).toContain("Bash(npx:*)");
  });

  it("allows the package manager the install step names", () => {
    // Step 2 is the first command of the run and it is handed over in full,
    // for whichever manager was detected. Two that no rule used to cover.
    const poetry: Partial<DetectedService> = { packageManager: "poetry" };
    expect(programInInstallCommand(task(null, poetry))).toBe("poetry");
    expect(rules(null, poetry)).toContain("Bash(poetry:*)");

    const bun: Partial<DetectedService> = {
      language: "typescript",
      entryPoint: "index.js",
      packageManager: "bun",
    };
    expect(programInInstallCommand(task(null, bun))).toBe("bun");
    expect(rules(null, bun)).toContain("Bash(bun:*)");
  });

  it("allows the check the task tells the agent to run once", () => {
    // Step 5 is handed over in full, like step 2, and `pytest` is the bare
    // string `detectStack` produces for a Python project on pip or Poetry. A
    // refused check costs the agent the single attempt the task is written to
    // buy it, and its recovery — `./.venv/bin/python -m pytest` — only works
    // where a virtualenv was found.
    //
    // The task hands it over behind `TRACEROOT_ENABLED=false`, so the suite
    // sends no traces of its own, and the prefixed rule `buildInvocation`
    // writes for every program is the one that matches — beside the file rules
    // this pull request adds, not instead of them.
    const pip: Partial<DetectedService> = { testCommand: "pytest" };
    expect(programInCheckCommand(task(null, pip))).toBe("TRACEROOT_ENABLED=false pytest");
    expect(rules(null, pip)).toContain("Bash(TRACEROOT_ENABLED=false pytest:*)");
    expect(rules(null, pip)).toContain("Bash(pytest:*)");
    expect(rules(null, pip)).toContain("Edit(**)");

    // `uv` runs it through its own environment, which was already allowed —
    // asserted so the two spellings cannot be mistaken for one case.
    const uv: Partial<DetectedService> = { packageManager: "uv", testCommand: "uv run pytest" };
    expect(programInCheckCommand(task(null, uv))).toBe("TRACEROOT_ENABLED=false uv");
    expect(rules(null, uv)).toContain("Bash(TRACEROOT_ENABLED=false uv:*)");
  });

  it("allows no check when none was detected", () => {
    // There the task tells the agent to find the project's own check, which is
    // a command nobody here can name — so there is nothing to allow, and an
    // empty rule would be a rule matching everything.
    const named = rules(null);
    expect(named).not.toContain("Bash(:*)");
    expect(named).not.toContain("Bash(pytest:*)");
  });

  it("names no program the task did not, and never widens to every command", () => {
    // Scoped per run: a Python service's rules must not carry the Node
    // manager's program, and the whole point of an allow list is lost if a
    // bare `Bash(*)` ever reaches the argv.
    const python = rules("/repo/api/.venv/bin/python");
    expect(python).not.toContain("Bash(bun:*)");
    expect(python).not.toContain("Bash(npx:*)");
    expect(python).not.toContain("Bash(*)");
    expect(python).not.toContain("Bash");
  });
});

describe("where the credential is allowed to appear", () => {
  const KEY = "tr-a-long-enough-credential";

  it("puts it in the child's environment when that is the only channel", () => {
    // No file the application can read the key out of, so the environment is
    // all there is — and an agent that cannot authenticate cannot prove any of
    // its own work. Not argv (visible in `ps`), not the task file (written to
    // disk), and not the parent's own environment, which would leak into every
    // later child in this process.
    const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const env = buildAgentEnv({
      parentEnv,
      credential: makeSecret(KEY),
      credentialFiles: [],
      host: "https://api.example.test",
    });

    expect(env.TRACEROOT_API_KEY).toBe(KEY);
    expect(env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    expect(env.PATH).toBe("/usr/bin");
    expect(parentEnv.TRACEROOT_API_KEY).toBeUndefined();
  });

  it("withholds it when a file the application loads already holds it", () => {
    // Every command the agent runs inherits this variable and the SDK
    // initializes from it unasked, so an agent that runs the project's own test
    // suite to check its work exported a trace per instrumented call — into the
    // user's project, under the same key as the application's own traces. With
    // the key in the file the entry point loads, the application reaches it the
    // way production will deliver it and the suite reaches nothing.
    const env = buildAgentEnv({
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: ["/repo/.env"],
      host: "https://api.example.test",
    });

    expect("TRACEROOT_API_KEY" in env).toBe(false);
    // The host stays either way: it is not a credential, nothing exports
    // without a key, and an agent pointed at the wrong instance is a long
    // debugging session for a user.
    expect(env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
  });

  for (const interactive of [false, true]) {
    it(`keeps it out of argv on the ${interactive ? "argv" : "stdin"}-prompt path`, async () => {
      const { run, runs } = fakeRunProcess();
      const invocation = buildInvocation({ agentId: "claude", task: "do it", interactive });
      await launchAgent({
        invocation,
        task: "do it",
        cwd: "/repo",
        parentEnv: { PATH: "/usr/bin" },
        credential: makeSecret(KEY),
        credentialFiles: [],
        host: "https://api.example.test",
        runProcess: run,
      });

      const launched = runs[0];
      expect(launched?.env.TRACEROOT_API_KEY).toBe(KEY);
      expect(launched?.args.join(" ")).not.toContain(KEY);
      expect(launched?.stdin ?? "").not.toContain(KEY);
    });
  }

  it("carries the withholding through the launch, not only the env builder", async () => {
    // `launchAgent` builds the child's environment itself, so a gate the caller
    // cannot reach through it is a gate the run never applies.
    const { run, runs } = fakeRunProcess();
    const invocation = buildInvocation({ agentId: "claude", task: "do it", interactive: false });
    await launchAgent({
      invocation,
      task: "do it",
      cwd: "/repo",
      parentEnv: { PATH: "/usr/bin" },
      credential: makeSecret(KEY),
      credentialFiles: ["/repo/.env"],
      host: "https://api.example.test",
      runProcess: run,
    });

    const launched = runs[0];
    expect(launched).toBeDefined();
    expect("TRACEROOT_API_KEY" in (launched?.env ?? {})).toBe(false);
    expect(launched?.env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    // And the key is still redacted out of everything the launch does carry,
    // which is the property the list above never depended on.
    expect(launched?.args.join(" ")).not.toContain(KEY);
    expect(launched?.stdin ?? "").not.toContain(KEY);
  });

  it("drops an inherited TRACEROOT_ENABLED and leaves the parent's untouched", () => {
    // Exported as `false`, it switched off the application run the task asks
    // for, and the trace wait then blamed the code path.
    const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", TRACEROOT_ENABLED: "false" };
    const env = buildAgentEnv({
      parentEnv,
      credential: makeSecret(KEY),
      credentialFiles: ["/repo/.env"],
      host: "https://api.example.test",
    });

    expect("TRACEROOT_ENABLED" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
    expect(parentEnv.TRACEROOT_ENABLED).toBe("false");
  });

  it("shortens the export delay for what the agent runs, and still strips what it stripped", () => {
    // A server the agent stops within the SDK's default five seconds of its
    // request loses its trace: the TypeScript SDK flushes only on `beforeExit`,
    // which a signal never reaches. Set over an exported value, because the
    // agent's own runs are the ones that have to export quickly.
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      TRACEROOT_ENABLED: "false",
      TRACEROOT_FLUSH_INTERVAL: "30",
    };
    const env = buildAgentEnv({
      parentEnv,
      credential: makeSecret(KEY),
      credentialFiles: ["/repo/.env"],
      host: "https://api.example.test",
    });

    expect(env.TRACEROOT_FLUSH_INTERVAL).toBe("1");
    expect("TRACEROOT_ENABLED" in env).toBe(false);
    expect("TRACEROOT_API_KEY" in env).toBe(false);
    expect(env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    expect(env.PATH).toBe("/usr/bin");
    // The agent's copy only: the user's own environment keeps its value.
    expect(parentEnv.TRACEROOT_FLUSH_INTERVAL).toBe("30");
  });
});

describe("an exported key that would beat the env file", () => {
  const KEY = "tr-this-runs-own-credential";
  const OTHER = "tr-another-projects-credential";

  it("is named by its hint when a file carries this run's key", () => {
    // dotenv does not override a variable that is already set, so the
    // application would send its traces with the exported key.
    expect(
      shadowingApiKey({
        parentEnv: { TRACEROOT_API_KEY: OTHER },
        credential: makeSecret(KEY),
        credentialFiles: ["/repo/.env"],
      }),
    ).toBe("tr-…tial");
  });

  it.each([
    ["nothing is exported", {}, ["/repo/.env"]],
    ["the exported key is this run's", { TRACEROOT_API_KEY: KEY }, ["/repo/.env"]],
    // Setup's own copy goes into the agent's environment over it.
    ["no file carries the key", { TRACEROOT_API_KEY: OTHER }, []],
  ])("is null when %s", (_, parentEnv, credentialFiles) => {
    expect(shadowingApiKey({ parentEnv, credential: makeSecret(KEY), credentialFiles })).toBeNull();
  });
});
