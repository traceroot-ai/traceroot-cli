import { describe, expect, it } from "vitest";
import { buildAgentEnv, buildInvocation, launchAgent } from "../../src/setup/launch.js";
import { makeSecret } from "../../src/setup/secret.js";
import { buildSetupTask, taskInterpreters } from "../../src/setup/task.js";
import type { DetectedService } from "../../src/setup/types.js";
import { fakeRunProcess } from "./helpers.js";

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

  it("claims no activity format, so no parser is pointed at its output", () => {
    // Codex's `--json` event names differ between releases and nothing here has
    // been run against the binary to settle which. A feed built on a guessed
    // schema reads as a record of what the agent did.
    expect(codex().activityFormat).toBe("none");
    expect(codex().args).not.toContain("--json");
    // And Claude's, which this parser *was* written against, still declares it.
    expect(
      buildInvocation({ agentId: "claude", task: "t", interactive: false }).activityFormat,
    ).toBe("claude-stream-json");
  });

  it("silently drops the Claude-shaped options it has no mechanism for", () => {
    // `--add-dir` answers a read scope Codex does not have, and there is no
    // per-program allow list to translate `Bash(prog:*)` into. Leaving the
    // flags off is the decision; emitting a nearest-looking one is not.
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

  it("adds no allowlist flag when there is nothing to allow", () => {
    const { args } = buildInvocation({ agentId: "claude", task: "t", interactive: false });
    expect(args).not.toContain("--allowedTools");
  });
});

describe("the interpreter the task recommends and the one the agent may run", () => {
  const ROOT = "/repo";
  const SERVICE_PATH = "api";

  function task(pythonInterpreter: string | null): string {
    return buildSetupTask({
      service: {
        path: SERVICE_PATH,
        language: "python",
        framework: null,
        entryPoint: "main.py",
        packageManager: "pip",
        testCommand: null,
        evidence: [],
      } as unknown as DetectedService,
      root: ROOT,
      sdk: { package: "traceroot", version: "1.2.3", source: "registry" },
      skillPath: ".claude/skills/traceroot-instrument-repo",
      verifyCommand: null,
      interactive: false,
      existingInstrumentation: [],
      pythonInterpreter,
      credentialFiles: [],
    });
  }

  function rules(pythonInterpreter: string | null): string[] {
    return buildInvocation({
      agentId: "claude",
      task: "t",
      interactive: false,
      allowedPrograms: taskInterpreters(pythonInterpreter, ROOT, SERVICE_PATH),
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
    return (command as string).split(" ")[0];
  }

  it("allows the relative spelling the run command uses for a virtualenv in the tree", () => {
    const interpreter = "/repo/api/.venv/bin/python";
    const named = programInRunCommand(task(interpreter));
    // Non-vacuous only because the two spellings differ. The absolute path is
    // the one a caller has in hand, and it is not the one the task gives.
    expect(named).not.toBe(interpreter);
    expect(rules(interpreter)).toContain(`Bash(${named}:*)`);
    // And the absolute path as well: the install step names it that way,
    // quotes included, because there the quoting is written for the agent.
    expect(rules(interpreter)).toContain(`Bash(${interpreter}:*)`);
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
});
