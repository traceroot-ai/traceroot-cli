import { describe, expect, it } from "vitest";
import { resolveAgentOrPrompt } from "../../src/agents/select.js";
import { CliError } from "../../src/output.js";

const base = {
  json: false,
  example: "traceroot skills install traceroot-quickstart --agent claude",
};

describe("resolveAgentOrPrompt (explicit --agent)", () => {
  it("returns the adapter without prompting", async () => {
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt");
    };
    const agent = await resolveAgentOrPrompt({ ...base, agentId: "codex", prompt });
    expect(agent.id).toBe("codex");
  });

  it("rejects an unknown explicit agent", async () => {
    await expect(resolveAgentOrPrompt({ ...base, agentId: "windsurf" })).rejects.toThrow(
      /Unknown agent/,
    );
  });
});

describe("resolveAgentOrPrompt (missing --agent, no prompt path)", () => {
  it("throws an actionable error when non-interactive", async () => {
    try {
      await resolveAgentOrPrompt({ ...base, agentId: undefined, isInteractive: false });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const msg = (err as CliError).message;
      expect(msg).toContain("--agent");
      expect(msg).toContain("claude, codex, generic");
      expect(msg).toContain(base.example);
    }
  });

  it("throws in JSON mode even when interactive, and never prompts", async () => {
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt in JSON mode");
    };
    await expect(
      resolveAgentOrPrompt({ ...base, agentId: undefined, json: true, isInteractive: true, prompt }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("resolveAgentOrPrompt (interactive prompt, login-style)", () => {
  it("offers the options and a claude default on one line", async () => {
    let asked = "";
    await resolveAgentOrPrompt({
      ...base,
      agentId: undefined,
      isInteractive: true,
      prompt: async (q) => {
        asked = q;
        return "codex";
      },
    });
    expect(asked).toContain("claude, codex, generic");
    expect(asked).toContain("default: claude");
  });

  it("selects claude on empty input (Enter accepts the default)", async () => {
    const agent = await resolveAgentOrPrompt({
      ...base,
      agentId: undefined,
      isInteractive: true,
      prompt: async () => "",
    });
    expect(agent.id).toBe("claude");
  });

  it("honors a codex selection", async () => {
    const agent = await resolveAgentOrPrompt({
      ...base,
      agentId: undefined,
      isInteractive: true,
      prompt: async () => "codex",
    });
    expect(agent.id).toBe("codex");
  });

  it("honors a generic selection", async () => {
    const agent = await resolveAgentOrPrompt({
      ...base,
      agentId: undefined,
      isInteractive: true,
      prompt: async () => "generic",
    });
    expect(agent.id).toBe("generic");
  });

  it("rejects an unknown typed selection", async () => {
    await expect(
      resolveAgentOrPrompt({
        ...base,
        agentId: undefined,
        isInteractive: true,
        prompt: async () => "bogus",
      }),
    ).rejects.toThrow(/Unknown agent/);
  });
});
