import { describe, expect, it } from "vitest";
import { importCheck, installCommand } from "../../src/setup/sdk.js";
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

describe("the probe that proves the SDK is installed", () => {
  it("demands distribution metadata, which a service-local module cannot provide", () => {
    // `import X` alone is satisfied by an `X.py` or `X/` sitting in the
    // repository, because `python -c` puts the working directory first on
    // `sys.path` — so the probe passed on a repository that merely had a
    // directory of that name while the SDK was absent. Metadata exists only for
    // something a package manager installed, so it cannot be shadowed.
    const check = importCheck(SDK, service, null);

    expect(check?.args.at(-1)).toContain("importlib.metadata");
    expect(check?.args.at(-1)).toContain('m.version("traceroot-sdk")');
  });

  it("imports the module name but asks metadata for the distribution name", () => {
    // PyPI allows a `-` where Python requires `_`. `import traceroot-sdk` is a
    // syntax error, and `m.version("traceroot_sdk")` finds nothing — each half
    // of the probe needs the spelling that belongs to it.
    const check = importCheck(SDK, service, null);

    expect(check?.args.at(-1)).toBe(
      'import traceroot_sdk, importlib.metadata as m; m.version("traceroot-sdk")',
    );
    expect(check?.module).toBe("traceroot_sdk");
  });

  it("asks Poetry for its own environment rather than a bare interpreter", () => {
    const check = importCheck(SDK, { ...service, packageManager: "poetry" }, null);

    expect(check?.program).toBe("poetry");
    expect(check?.args.slice(0, 3)).toEqual(["run", "python", "-c"]);
    expect(check?.display).toBe("poetry run python");
  });
});
