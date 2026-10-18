import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHABLE_AGENTS, detectAgents, selectAgent } from "../../src/setup/agents.js";
import { SetupError } from "../../src/setup/errors.js";

let bin: string;
let cwd: string;
let codexHome: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "tr-agent-bin-"));
  cwd = mkdtempSync(join(tmpdir(), "tr-agent-cwd-"));
  // The Codex adapter resolves its home from `$CODEX_HOME`, falling back to the
  // real `~/.codex`. Pinned at an empty temp path so `configured` is a fact
  // about the fixture rather than about whoever is running the suite — and so
  // nothing here can ever look at, or write into, a developer's own Codex home.
  codexHome = join(cwd, "codex-home");
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (prevCodexHome === undefined) {
    // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = prevCodexHome;
  }
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

/**
 * What `selectAgent` refused with, failing the test if it chose an agent.
 *
 * A bare `.catch((err) => err as SetupError)` typed the outcome of a choice as
 * an error too, so a selection that resolved reached the assertions as an agent
 * with no `code` or `remedy` to compare.
 */
async function refusalFrom(choice: Promise<unknown>): Promise<SetupError> {
  const outcome = await choice.then(
    (chosen) => chosen,
    (err: unknown) => err,
  );
  if (!(outcome instanceof SetupError)) {
    throw new Error(`selectAgent did not refuse with a SetupError: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("which agents setup offers to run", () => {
  it("probes only the agents it has a verified way to drive", () => {
    // The CLI installs skills for more agents than setup can drive headless.
    // Reporting one here makes it a run option, and an option setup cannot
    // carry through to a trace is worse than no option at all.
    onPath("claude");
    onPath("codex");

    const detected = detectAgents({ cwd, env: { PATH: bin }, platform: "linux" });

    // Both launchable agents, in the registry's order; `generic` has no binary
    // and is still absent, because nothing can be driven through it.
    expect(detected.map((a) => a.id)).toEqual(["claude", "codex"]);
    expect(detected.every((a) => a.runnable)).toBe(true);
  });

  it("reports a launchable agent that is installed and one that is not", () => {
    // The ordinary machine: one of the two on PATH. The absent one still has to
    // appear in the probe's output — `runnable: false` is what keeps it out of
    // the run options, and dropping the row entirely would leave `setup doctor`
    // unable to say anything about it.
    onPath("codex");

    const detected = detectAgents({ cwd, env: { PATH: bin }, platform: "linux" });

    expect(detected.find((a) => a.id === "claude")?.runnable).toBe(false);
    expect(detected.find((a) => a.id === "codex")?.runnable).toBe(true);
    expect(detected.find((a) => a.id === "codex")?.evidence).toContain("`codex` found on PATH");
  });

  it("refuses an agent it cannot drive and points at the task file", async () => {
    let warned = "";
    const refusal = await selectAgent({
      detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
      // `generic` is a skill target, not something with a binary to drive.
      requested: "generic",
      canPrompt: false,
      select: neverAsk,
      warn: (message) => {
        warned = message;
      },
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SetupError);
    const error = refusal as SetupError;
    expect(error.stage).toBe("select_agent");
    expect(error.message).toContain("Setup cannot run 'generic'");
    // Named from the launchable list, so the refusal lists every agent it can
    // drive rather than the one it could drive when this test was written.
    for (const adapter of LAUNCHABLE_AGENTS) {
      expect(error.message).toContain(adapter.id);
    }
    expect(error.remedy).toContain("--no-instrument");
    // Not a PATH problem, so not a PATH warning.
    expect(warned).toBe("");
  });

  it("honours an explicitly requested Codex and warns when it is not on PATH", async () => {
    let warned = "";
    const chosen = await selectAgent({
      detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
      requested: "codex",
      canPrompt: false,
      select: neverAsk,
      warn: (message) => {
        warned = message;
      },
    });

    expect(chosen.id).toBe("codex");
    expect(warned).toContain("`codex` was not found on PATH");
  });

  it("asks which of two installed agents should do the work", async () => {
    onPath("claude");
    onPath("codex");
    let asked: { value: string; label: string }[] = [];

    const chosen = await selectAgent({
      detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
      canPrompt: true,
      select: async (input) => {
        asked = input.options.map((o) => ({ value: o.value, label: o.label }));
        return "codex";
      },
      warn: () => undefined,
    });

    expect(asked.map((o) => o.value)).toEqual(["claude", "codex"]);
    expect(chosen.id).toBe("codex");
  });

  it("names --agent rather than guessing when two are installed and nobody can be asked", async () => {
    onPath("claude");
    onPath("codex");

    const refusal = await refusalFrom(
      selectAgent({
        detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
        canPrompt: false,
        select: neverAsk,
        warn: () => undefined,
      }),
    );

    expect(refusal.code).toBe("AMBIGUOUS");
    expect(refusal.message).toContain("claude, codex");
    expect(refusal.remedy).toContain("--agent");
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
    const refusal = await refusalFrom(
      selectAgent({
        detected: detectAgents({ cwd, env: { PATH: bin }, platform: "linux" }),
        canPrompt: false,
        select: neverAsk,
        warn: () => undefined,
      }),
    );

    expect(refusal.message).toContain("No coding agent was found on PATH");
    for (const adapter of LAUNCHABLE_AGENTS) {
      expect(refusal.remedy).toContain(adapter.displayName);
    }
    // Both of them, because both are agents setup can now drive: a remedy that
    // names only one tells half the machines reading it to install software
    // they did not need.
    expect(refusal.remedy).toContain("Claude Code");
    expect(refusal.remedy).toContain("Codex");
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

    const refusal = await refusalFrom(
      selectAgent({
        detected: onWindows(),
        canPrompt: false,
        select: neverAsk,
        warn: () => undefined,
      }),
    );

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

    const refusal = await refusalFrom(
      selectAgent({
        detected: onWindows(),
        requested: "claude",
        canPrompt: false,
        select: neverAsk,
        warn: (message) => {
          warned = message;
        },
      }),
    );

    expect(refusal).toBeInstanceOf(SetupError);
    expect(refusal.code).toBe("UNSUPPORTED");
    expect(refusal.message).toContain("batch shim");
    expect(warned).toBe("");
  });
});
