import { describe, expect, it } from "vitest";
import { buildSetupTask } from "../../src/setup/task.js";
import type { DetectedService } from "../../src/setup/types.js";

const SDK = { package: "@traceroot-ai/traceroot", version: "1.2.3", source: "registry" as const };

function service(overrides: Partial<DetectedService> = {}): DetectedService {
  return {
    path: ".",
    language: "python",
    framework: null,
    entryPoint: "main.py",
    packageManager: "pip",
    testCommand: null,
    evidence: [],
    ...overrides,
  } as unknown as DetectedService;
}

function task(overrides: Record<string, unknown> = {}): string {
  return buildSetupTask({
    service: service(),
    root: "/repo",
    sdk: SDK,
    skillPath: ".claude/skills/traceroot-instrument-repo",
    verifyCommand: null,
    interactive: false,
    existingInstrumentation: [],
    ...overrides,
  });
}

describe("naming the interpreter the service runs on", () => {
  it("names a service-local virtualenv from the service's own directory", () => {
    const text = task({
      service: service({ path: "api" }),
      pythonInterpreter: "/repo/api/.venv/bin/python",
    });
    expect(text).toContain("./.venv/bin/python main.py");
    // Explicitly: not the parent's. `"../.venv/…"` contains `"./.venv/…"`, so the
    // assertion above passes on the wrong answer without this one.
    expect(text).not.toContain("../.venv/bin/python");
  });

  it("climbs exactly once for a root virtualenv from a nested service", () => {
    // The old version repeated `../` per path segment against a string it had
    // already stripped to a tail, so the depth and the path disagreed.
    const text = task({
      service: service({ path: "api" }),
      pythonInterpreter: "/repo/.venv/bin/python",
    });
    expect(text).toContain("../.venv/bin/python main.py");
    expect(text).not.toContain("../../.venv/bin/python");
  });

  it("keeps an interpreter outside the repository absolute", () => {
    const text = task({
      service: service({ path: "api" }),
      pythonInterpreter: "/opt/homebrew/bin/python3",
    });
    expect(text).toContain("/opt/homebrew/bin/python3 main.py");
  });
});

describe("the run line for a service that is not Python", () => {
  it("runs a TypeScript entry point with tsx, not a Python interpreter", () => {
    const text = task({
      service: service({ language: "typescript", entryPoint: "src/index.ts" }),
    });
    expect(text).toContain("npx tsx src/index.ts");
    expect(text).not.toContain("python3 src/index.ts");
  });

  it("runs a JavaScript entry point with node", () => {
    const text = task({ service: service({ language: "javascript", entryPoint: "index.js" }) });
    expect(text).toContain("node index.js");
  });

  it("does not offer a Python virtualenv recovery to a Node service", () => {
    // The PEP 668 paragraph was gated on "no virtualenv was found", which is
    // always true for a Node service — so it was told to build one.
    const text = task({ service: service({ language: "typescript", entryPoint: "src/index.ts" }) });
    expect(text).not.toContain("externally-managed-environment");
    expect(text).not.toContain("python3 -m venv");
  });
});

describe("the snippet the agent is told to paste", () => {
  it("imports the package the installer actually installs", () => {
    const text = task({ service: service({ language: "typescript", entryPoint: "src/index.ts" }) });
    expect(text).toContain('from "@traceroot-ai/traceroot"');
    expect(text).not.toContain("traceroot-sdk-ts");
  });
});
