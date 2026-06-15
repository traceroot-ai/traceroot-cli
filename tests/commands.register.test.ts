import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

function childNames(program: Command): string[] {
  return program.commands.map((c) => c.name());
}

describe("buildProgram", () => {
  it("returns a commander Command named traceroot", () => {
    const program = buildProgram();
    expect(program.name()).toBe("traceroot");
  });

  it("registers login, status, and traces subcommands", () => {
    const program = buildProgram();
    const names = childNames(program);
    expect(names).toContain("login");
    expect(names).toContain("status");
    expect(names).toContain("traces");
  });

  it("registers list, get, and export under traces", () => {
    const program = buildProgram();
    const traces = program.commands.find((c) => c.name() === "traces");
    expect(traces).toBeDefined();
    const subNames = childNames(traces as Command);
    expect(subNames).toContain("list");
    expect(subNames).toContain("get");
    expect(subNames).toContain("export");
  });
});
