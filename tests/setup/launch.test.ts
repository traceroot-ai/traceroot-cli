import { describe, expect, it } from "vitest";
import { buildAgentEnv, buildInvocation, launchAgent } from "../../src/setup/launch.js";
import { makeSecret } from "../../src/setup/secret.js";
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

describe("where the credential is allowed to appear", () => {
  const KEY = "tr-a-long-enough-credential";

  it("puts it in the child's environment and leaves the parent's alone", () => {
    // Not argv (visible in `ps`), not the task file (written to disk), and not
    // the parent's own environment, which would leak into every later child in
    // this process.
    const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const env = buildAgentEnv({
      parentEnv,
      credential: makeSecret(KEY),
      host: "https://api.example.test",
    });

    expect(env.TRACEROOT_API_KEY).toBe(KEY);
    expect(env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
    expect(env.PATH).toBe("/usr/bin");
    expect(parentEnv.TRACEROOT_API_KEY).toBeUndefined();
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
        host: "https://api.example.test",
        runProcess: run,
      });

      const launched = runs[0];
      expect(launched?.env.TRACEROOT_API_KEY).toBe(KEY);
      expect(launched?.args.join(" ")).not.toContain(KEY);
      expect(launched?.stdin ?? "").not.toContain(KEY);
    });
  }
});
