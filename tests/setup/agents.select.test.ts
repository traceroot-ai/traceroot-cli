import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
