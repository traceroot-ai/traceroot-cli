import { describe, expect, it } from "vitest";
import { buildInstrumentPrompt } from "../../src/prompts/instrumentPrompt.js";
import type { RepoDetection, RepoLanguage } from "../../src/repo/detect.js";
import { buildSetupTask, manualInstructions } from "../../src/setup/task.js";
import type { DetectedService } from "../../src/setup/types.js";

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

const SDK = { package: "traceroot", version: "1.2.3", source: "registry" as const };

const PYTHON_SERVICE = {
  path: ".",
  language: "python",
  framework: null,
  entryPoint: "main.py",
  packageManager: "pip",
  testCommand: null,
  evidence: [],
} as unknown as DetectedService;

describe("every surface that says where to initialize", () => {
  // All three of them, read out of the builders rather than restated: the task
  // an agent is launched with, the prompt `instrument` writes for an agent
  // someone drives themselves, and the instructions for doing it by hand. A
  // claim fixed in one of them and left in another is the whole reason this
  // reads them together.
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ["the instrument prompt", buildInstrumentPrompt(detect(["python"]))],
    [
      "the agent task",
      buildSetupTask({
        service: PYTHON_SERVICE,
        root: "/repo",
        sdk: SDK,
        skillPath: ".claude/skills/traceroot-instrument-repo",
        verifyCommand: null,
        interactive: false,
        existingInstrumentation: [],
        credentialFiles: [],
      }),
    ],
    [
      "the hand instructions",
      manualInstructions({
        service: PYTHON_SERVICE,
        sdk: SDK,
        skillPath: ".claude/skills/traceroot-instrument-repo",
      }),
    ],
  ];

  for (const [name, text] of surfaces) {
    it(`${name} — names the run path, not the import order`, () => {
      // Initializing before the provider's import was never true of this SDK:
      // the instrumentors patch the provider's own methods, which does not care
      // which was imported first. Saying it sends the reader reordering imports
      // instead of moving the call off module scope, which is the thing that
      // decides whether the project's own test suite exports traces.
      expect(text).not.toMatch(/as early as possible/i);
      expect(text).not.toMatch(/before (any|the) (LLM|agent|provider)/i);
      expect(text).toMatch(/module scope/i);
      expect(text).toContain('if __name__ == "__main__":');
    });
  }

  for (const [name, text] of surfaces) {
    it(`${name} — runs the tests with TraceRoot switched off`, () => {
      // The placement keeps `initialize()` off the import path, and that is all
      // it does. `observe` starts the SDK whenever `TRACEROOT_API_KEY` is in the
      // environment, so a surface that promised the guard alone kept the tests
      // quiet sent its reader's suite into their project.
      expect(text).toContain("TRACEROOT_ENABLED=false");
      expect(text).not.toMatch(/tests stop\s+exporting without touching them/);
      expect(text).not.toMatch(/each test would\s+otherwise export/);
      expect(text).not.toMatch(/loads no credential and starts no SDK/);
    });
  }

  // Not the hand instructions, which hand the whole of what to cover to the
  // skill rather than summarising it.
  for (const [name, text] of surfaces.slice(0, 2)) {
    it(`${name} — decides a tool span by who calls the function`, () => {
      // The other half of the same run: told to touch the fewest files, an
      // agent writes one span where the application's own tool loop needed
      // seven. The bar is what this repository's code calls, and the question
      // is answerable without running anything.
      // `\s+` because the agent task is wrapped prose and the question spans a
      // line break there.
      expect(text).toMatch(/does a line in this repository\s+call/i);
      // The instruction that produced the one-span run. Not "fewest files",
      // which the agent task keeps as a bound on how much of the repository is
      // rewritten, having said in the same breath that it bounds nothing about
      // what the trace covers.
      expect(text).not.toMatch(/minimi[sz]e changes/i);
    });
  }
});
