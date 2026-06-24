import { describe, expect, it } from "vitest";
import { resolveAgentOrPrompt } from "../../src/agents/select.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const base = {
  cwd: "/repo",
  json: false,
  example: "traceroot skills install traceroot-quickstart --agent claude",
};

describe("resolveAgentOrPrompt (explicit --agent)", () => {
  it("returns the adapter without prompting", async () => {
    const { writers, err } = makeWriters();
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt");
    };
    const agent = await resolveAgentOrPrompt({ ...base, agentId: "codex", writers, prompt });
    expect(agent.id).toBe("codex");
    expect(err.data).toBe("");
  });

  it("rejects an unknown explicit agent", async () => {
    const { writers } = makeWriters();
    await expect(resolveAgentOrPrompt({ ...base, agentId: "windsurf", writers })).rejects.toThrow(
      /Unknown agent/,
    );
  });
});

describe("resolveAgentOrPrompt (missing --agent, no prompt path)", () => {
  it("throws an actionable error when non-interactive", async () => {
    const { writers, out } = makeWriters();
    try {
      await resolveAgentOrPrompt({ ...base, agentId: undefined, isInteractive: false, writers });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const msg = (err as CliError).message;
      expect(msg).toContain("--agent");
      expect(msg).toContain("claude, codex, generic");
      expect(msg).toContain(base.example);
    }
    expect(out.data).toBe("");
  });

  it("throws in JSON mode even when interactive, and never prompts", async () => {
    const { writers } = makeWriters();
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt in JSON mode");
    };
    await expect(
      resolveAgentOrPrompt({
        ...base,
        agentId: undefined,
        json: true,
        isInteractive: true,
        prompt,
        writers,
      }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("resolveAgentOrPrompt (missing --agent, interactive prompt)", () => {
  it("prompts, shows a choice menu on stderr, and returns the selected adapter", async () => {
    const { writers, err, out } = makeWriters();
    const agent = await resolveAgentOrPrompt({
      ...base,
      agentId: undefined,
      isInteractive: true,
      prompt: async () => "codex",
      writers,
    });
    expect(agent.id).toBe("codex");
    // Menu is human text → stderr, never stdout.
    expect(err.data).toContain("claude");
    expect(err.data).toContain("codex");
    expect(err.data).toContain("generic");
    expect(out.data).toBe("");
  });

  it("honors a generic selection", async () => {
    const { writers } = makeWriters();
    const agent = await resolveAgentOrPrompt({
      ...base,
      agentId: undefined,
      isInteractive: true,
      prompt: async () => "generic",
      writers,
    });
    expect(agent.id).toBe("generic");
  });

  it("rejects an unknown/empty selection", async () => {
    const { writers } = makeWriters();
    await expect(
      resolveAgentOrPrompt({
        ...base,
        agentId: undefined,
        isInteractive: true,
        prompt: async () => "",
        writers,
      }),
    ).rejects.toThrow(/Unknown agent/);
  });
});
