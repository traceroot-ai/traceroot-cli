import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHABLE_AGENTS, detectAgents, selectAgent } from "../../src/setup/agents.js";
import { SetupError } from "../../src/setup/errors.js";

let bin: string;
let cwd: string;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "tr-agent-bin-"));
  cwd = mkdtempSync(join(tmpdir(), "tr-agent-cwd-"));
});

afterEach(() => {
  for (const dir of [bin, cwd]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An executable of that name on the PATH the probe is given. */
function onPath(name: string): void {
  const file = join(bin, name);
  writeFileSync(file, "#!/bin/sh\n", "utf8");
  chmodSync(file, 0o755);
}

/** A selector that fails the test if it is ever reached. */
const neverAsk = async (): Promise<string> => {
  throw new Error("selectAgent should not have asked anything");
};

describe("which agents setup offers to run", () => {
  it("probes only the agents it has a verified way to drive", () => {
    // The CLI installs skills for more agents than setup can drive headless.
    // Reporting one here makes it a run option, and an option setup cannot
    // carry through to a trace is worse than no option at all.
    onPath("claude");
    onPath("codex");

    const detected = detectAgents({ cwd, env: { PATH: bin }, platform: "linux" });

    expect(detected.map((a) => a.id)).toEqual(["claude"]);
    expect(detected[0]?.runnable).toBe(true);
  });

  it("refuses an agent it cannot drive and points at the task file", async () => {
    let warned = "";
    const refusal = await selectAgent({
      detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
      requested: "codex",
      canPrompt: false,
      select: neverAsk,
      warn: (message) => {
        warned = message;
      },
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SetupError);
    const error = refusal as SetupError;
    expect(error.stage).toBe("select_agent");
    expect(error.message).toContain("Setup cannot run 'codex'");
    expect(error.message).toContain("claude");
    expect(error.remedy).toContain("--no-instrument");
    // Not a PATH problem, so not a PATH warning.
    expect(warned).toBe("");
  });

  it("still honours an agent it can drive that is not on PATH", async () => {
    // A wrapper, an alias, or an install made after this shell started. The
    // warning is the whole response; refusing would be presumptuous.
    let warned = "";
    const chosen = await selectAgent({
      detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
      requested: "claude",
      canPrompt: false,
      select: neverAsk,
      warn: (message) => {
        warned = message;
      },
    });

    expect(chosen.id).toBe("claude");
    expect(chosen.runnable).toBe(false);
    expect(warned).toContain("not found on PATH");
  });

  it("names a real agent in the nothing-installed remedy", async () => {
    const refusal = await selectAgent({
      detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
      canPrompt: false,
      select: neverAsk,
      warn: () => undefined,
    }).catch((err: unknown) => err as SetupError);

    expect(refusal.message).toContain("No coding agent was found on PATH");
    for (const adapter of LAUNCHABLE_AGENTS) {
      expect(refusal.remedy).toContain(adapter.displayName);
    }
    // The remedy used to name an agent setup no longer runs.
    expect(refusal.remedy).not.toContain("Codex");
  });

  it("adds nothing to what it reports for a POSIX binary", () => {
    onPath("claude");

    const [claude] = detectAgents({ cwd, env: { PATH: bin }, platform: "linux" });

    expect(claude?.runnable).toBe(true);
    expect(claude).not.toHaveProperty("unlaunchable");
  });
});

describe("an agent installed on Windows as a batch shim", () => {
  // The platform and PATHEXT are injected, so the win32 branch runs from a
  // POSIX host against real files.
  const onWindows = (path: string = bin) =>
    detectAgents({ cwd, env: { PATH: path, PATHEXT: ".EXE;.CMD" }, platform: "win32" });

  it("is not offered as runnable, and says why in one line", () => {
    // `npm i -g @anthropic-ai/claude-code` installs `claude.cmd`. Its launch
    // carries `Bash(prog:*)` rules that cmd.exe would re-interpret, so the
    // process runner refuses it: offered, it fails on every resume.
    onPath("claude.cmd");

    const [claude] = onWindows();

    expect(claude?.runnable).toBe(false);
    expect(claude?.unlaunchable).toBe(
      `Claude Code is on PATH as a batch shim, ${join(bin, "claude.cmd")}, which setup cannot launch on Windows. Put the native claude.exe ahead of it on PATH for setup to run it.`,
    );
    expect(claude?.unlaunchable).not.toContain("\n");
  });

  it("is still runnable from a native build ahead of the shim", () => {
    const shims = mkdtempSync(join(tmpdir(), "tr-agent-shims-"));
    try {
      onPath("claude.exe");
      writeFileSync(join(shims, "claude.cmd"), "", { mode: 0o755 });

      const [claude] = onWindows(`${bin}${delimiter}${shims}`);

      expect(claude?.runnable).toBe(true);
      expect(claude).not.toHaveProperty("unlaunchable");
    } finally {
      rmSync(shims, { recursive: true, force: true });
    }
  });

  it("refuses with that reason when nothing else can run, instead of 'not found'", async () => {
    onPath("claude.cmd");

    const refusal = await selectAgent({
      detected: onWindows(),
      canPrompt: false,
      select: neverAsk,
      warn: () => undefined,
    }).catch((err: unknown) => err as SetupError);

    expect(refusal).toBeInstanceOf(SetupError);
    expect(refusal.code).toBe("UNSUPPORTED");
    expect(refusal.message).toBe(`${onWindows()[0]?.unlaunchable}\n\n${refusal.remedy}`);
    expect(refusal.remedy).toContain("traceroot setup --no-instrument");
  });

  it("refuses an explicit --agent for it rather than trying and failing", async () => {
    // The not-on-PATH warning allows for a wrapper or an alias. Here the
    // launch would find this same shim, so trying can only fail.
    onPath("claude.cmd");
    let warned = "";

    const refusal = await selectAgent({
      detected: onWindows(),
      requested: "claude",
      canPrompt: false,
      select: neverAsk,
      warn: (message) => {
        warned = message;
      },
    }).catch((err: unknown) => err as SetupError);

    expect(refusal).toBeInstanceOf(SetupError);
    expect(refusal.code).toBe("UNSUPPORTED");
    expect(refusal.message).toContain("batch shim");
    expect(warned).toBe("");
  });
});
