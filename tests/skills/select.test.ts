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
    let listShownBeforePrompt = false;
    await resolveSkillOrPrompt({
      skillName: undefined,
      json: false,
      isInteractive: true,
      writers,
      prompt: async (q) => {
        // Capture whether the list was already printed when the prompt fired.
        listShownBeforePrompt = err.data.includes("Available skills:");
        asked = q;
        return "";
      },
    });
    expect(err.data).toContain("Available skills:");
    expect(err.data).toContain("traceroot-instrument-repo");
    expect(err.data).toContain("traceroot-quickstart");
    expect(err.data).toContain("Add TraceRoot tracing"); // a description snippet
    // The list is rendered BEFORE the compact prompt is shown.
    expect(listShownBeforePrompt).toBe(true);
    // ANSI-stripped so the assertion holds whether or not the default is dimmed.
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    expect(asked.replace(ansi, "")).toBe("Skill (default: traceroot-instrument-repo): ");
    // The prompt itself does not repeat the options inline.
    expect(asked).not.toContain("traceroot-quickstart");
  });

  it("bolds the skill names in the list when color is enabled", async () => {
    const out = new StringSink(true);
    const err = new StringSink(true);
    await resolveSkillOrPrompt({
      skillName: undefined,
      json: false,
      isInteractive: true,
      writers: { out, err },
      prompt: async () => "",
    });
    expect(err.data).toContain("\x1b[1mtraceroot-instrument-repo\x1b[0m");
    expect(err.data).toContain("\x1b[1mtraceroot-quickstart\x1b[0m");
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
