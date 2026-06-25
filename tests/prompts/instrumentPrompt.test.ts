import { describe, expect, it } from "vitest";
import { buildInstrumentPrompt } from "../../src/prompts/instrumentPrompt.js";
import type { RepoDetection, RepoLanguage } from "../../src/repo/detect.js";

function detect(likelyLanguages: RepoLanguage[]): RepoDetection {
  return {
    root: "/repo",
    hasPackageJson:
      likelyLanguages.includes("javascript") || likelyLanguages.includes("typescript"),
    hasPyprojectToml: likelyLanguages.includes("python"),
    hasRequirementsTxt: false,
    hasTsconfigJson: likelyLanguages.includes("typescript"),
    likelyLanguages,
  };
}

function languageLine(langs: RepoLanguage[]): string {
  const prompt = buildInstrumentPrompt(detect(langs));
  return prompt.split("\n").find((l) => l.includes("likely language:")) ?? "";
}

describe("buildInstrumentPrompt — languageSummary", () => {
  it("keeps both languages for a mixed Python + JavaScript repo", () => {
    expect(languageLine(["javascript", "python"])).toContain(
      "likely language: Python and JavaScript",
    );
  });

  it("keeps both for Python + TypeScript", () => {
    expect(languageLine(["typescript", "javascript", "python"])).toContain(
      "likely language: Python and TypeScript/JavaScript",
    );
  });

  it("reports JavaScript-only repos as JavaScript (not TypeScript)", () => {
    expect(languageLine(["javascript"])).toContain("likely language: JavaScript");
    expect(languageLine(["javascript"])).not.toContain("TypeScript");
  });

  it("reports TypeScript repos as TypeScript/JavaScript", () => {
    expect(languageLine(["typescript", "javascript"])).toContain(
      "likely language: TypeScript/JavaScript",
    );
  });

  it("reports Python-only repos as Python", () => {
    expect(languageLine(["python"])).toContain("likely language: Python");
    expect(languageLine(["python"])).not.toContain("JavaScript");
  });

  it("falls back to unknown when no language is detected", () => {
    expect(languageLine([])).toContain("likely language: unknown");
  });
});
