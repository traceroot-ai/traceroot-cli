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
    for (const agentId of ["codex", "generic"] as const) {
      expect(() => buildInvocation({ agentId, task: "t", interactive: false })).toThrow(
        /cannot be launched/,
      );
    }
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
