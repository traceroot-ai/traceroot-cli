import { describe, expect, it } from "vitest";
import { CliError } from "../../src/output.js";
import {
  BUILTIN_SKILLS,
  isBuiltinSkillName,
  requireBuiltinSkill,
} from "../../src/skills/registry.js";

describe("skills registry", () => {
  it("lists both built-in skills with descriptions and bestFor tags", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    expect(names).toContain("traceroot-instrument-repo");
    expect(names).toContain("traceroot-quickstart");
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.bestFor.length).toBeGreaterThan(0);
    }
  });

  it("recognizes known names and rejects unknown ones", () => {
    expect(isBuiltinSkillName("traceroot-quickstart")).toBe(true);
    expect(isBuiltinSkillName("nope")).toBe(false);
    // A traversal attempt is just an unknown name — never a path.
    expect(isBuiltinSkillName("../evil")).toBe(false);
  });

  it("requireBuiltinSkill returns the skill for a valid name", () => {
    expect(requireBuiltinSkill("traceroot-quickstart").name).toBe("traceroot-quickstart");
  });

  it("requireBuiltinSkill throws an actionable CliError for an unknown name", () => {
    try {
      requireBuiltinSkill("../../etc/passwd");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("Unknown skill");
      expect((err as CliError).message).toContain("traceroot-instrument-repo");
    }
  });
});
