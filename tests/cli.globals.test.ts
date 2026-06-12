import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

function longFlags(program: ReturnType<typeof buildProgram>): string[] {
  return program.options.map((o) => o.long).filter((l): l is string => typeof l === "string");
}

describe("buildProgram global options", () => {
  it("exposes the --api-key, --host, --env-file and --json long flags", () => {
    const flags = longFlags(buildProgram());
    expect(flags).toContain("--api-key");
    expect(flags).toContain("--host");
    expect(flags).toContain("--env-file");
    expect(flags).toContain("--json");
  });

  it("parses the global flags into opts", () => {
    const program = buildProgram();
    // With no subcommand the root action prints help and exits; override that so
    // the test stays in-process. Options are parsed before the action fires, so
    // they are still readable after the (suppressed) help throws.
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    expect(() =>
      program.parse(["--api-key", "SECRET", "--host", "https://api.example", "--json"], {
        from: "user",
      }),
    ).toThrow();
    const opts = program.opts();
    expect(opts.apiKey).toBe("SECRET");
    expect(opts.host).toBe("https://api.example");
    expect(opts.json).toBe(true);
  });
});
