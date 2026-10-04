import { describe, expect, it } from "vitest";
import { installCommand } from "../../src/setup/sdk.js";
import type { DetectedService } from "../../src/setup/types.js";

const SDK = { package: "traceroot-sdk", version: "1.2.3", source: "registry" as const };

const service: DetectedService = {
  path: ".",
  language: "python",
  framework: null,
  entryPoint: "main.py",
  packageManager: "pip",
  testCommand: null,
  evidence: [],
  assertedByUser: false,
} as unknown as DetectedService;

describe("the install command handed to an agent", () => {
  it("quotes an interpreter path so the shell cannot expand it", () => {
    // This string is pasted into a shell by an agent. Inside double quotes a `$`
    // or a backtick in a directory name is expanded, so the command installs into
    // the wrong interpreter — or a different one entirely.
    const command = installCommand(SDK, service, "python", "/repo/$HOME/`id`/bin/python");

    expect(command).toContain("'/repo/$HOME/`id`/bin/python'");
    expect(command).not.toContain('"/repo/$HOME');
  });

  it("keeps a path containing a single quote intact", () => {
    const command = installCommand(SDK, service, "python", "/repo/o'brien/bin/python");

    expect(command).toContain(`'/repo/o'\\''brien/bin/python'`);
  });
});
