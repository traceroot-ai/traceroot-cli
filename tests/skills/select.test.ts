import { describe, expect, it } from "vitest";
import { CliError, type Writers } from "../../src/output.js";
import { resolveSkillOrPrompt } from "../../src/skills/select.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

describe("resolveSkillOrPrompt (explicit <skill>)", () => {
  it("returns the skill without prompting", async () => {
    const { writers, err } = makeWriters();
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt");
    };
    const skill = await resolveSkillOrPrompt({
      skillName: "traceroot-quickstart",
      json: false,
      writers,
      prompt,
    });
    expect(skill.name).toBe("traceroot-quickstart");
    expect(err.data).toBe("");
  });

  it("rejects an unknown explicit skill", async () => {
    const { writers } = makeWriters();
    await expect(resolveSkillOrPrompt({ skillName: "nope", json: false, writers })).rejects.toThrow(
      /Unknown skill 'nope'/,
    );
  });
});

describe("resolveSkillOrPrompt (missing, no prompt path)", () => {
  it("throws an actionable error when non-interactive", async () => {
    const { writers } = makeWriters();
    await expect(
      resolveSkillOrPrompt({ skillName: undefined, json: false, isInteractive: false, writers }),
    ).rejects.toThrow(
      /Missing required argument <skill>[\s\S]*traceroot-instrument-repo, traceroot-quickstart/,
    );
  });

  it("throws in JSON mode even when interactive and never prompts", async () => {
    const { writers } = makeWriters();
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt in JSON mode");
    };
    await expect(
      resolveSkillOrPrompt({
        skillName: undefined,
        json: true,
        isInteractive: true,
        prompt,
        writers,
      }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("resolveSkillOrPrompt (interactive)", () => {
  it("lists the available skills (name + description) before prompting", async () => {
    const { writers, err } = makeWriters();
    let asked = "";
    await resolveSkillOrPrompt({
      skillName: undefined,
      json: false,
      isInteractive: true,
      writers,
      prompt: async (q) => {
        asked = q;
        return "";
      },
    });
    expect(err.data).toContain("Available skills:");
    expect(err.data).toContain("traceroot-instrument-repo");
    expect(err.data).toContain("traceroot-quickstart");
    expect(err.data).toContain("Add TraceRoot tracing"); // a description snippet
    // The list is rendered before the compact prompt.
    expect(err.data.indexOf("Available skills:")).toBeLessThan(err.data.length);
    expect(asked).toBe("Skill (default: traceroot-instrument-repo): ");
    // The prompt itself does not repeat the options inline.
    expect(asked).not.toContain("traceroot-quickstart");
  });

  it("selects traceroot-instrument-repo on empty input", async () => {
    const { writers } = makeWriters();
    const skill = await resolveSkillOrPrompt({
      skillName: undefined,
      json: false,
      isInteractive: true,
      writers,
      prompt: async () => "",
    });
    expect(skill.name).toBe("traceroot-instrument-repo");
  });

  it("honors a traceroot-quickstart selection", async () => {
    const { writers } = makeWriters();
    const skill = await resolveSkillOrPrompt({
      skillName: undefined,
      json: false,
      isInteractive: true,
      writers,
      prompt: async () => "traceroot-quickstart",
    });
    expect(skill.name).toBe("traceroot-quickstart");
  });

  it("rejects an unknown typed skill", async () => {
    const { writers } = makeWriters();
    await expect(
      resolveSkillOrPrompt({
        skillName: undefined,
        json: false,
        isInteractive: true,
        writers,
        prompt: async () => "bogus",
      }),
    ).rejects.toThrow(/Unknown skill 'bogus'/);
  });
});
