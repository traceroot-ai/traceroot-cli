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

  it("registers the new skills, instrument, and doctor commands", () => {
    const program = buildProgram();
    const names = childNames(program);
    expect(names).toContain("skills");
    expect(names).toContain("instrument");
    expect(names).toContain("doctor");
  });

  it("registers the detectors command with list and get subcommands", () => {
    const program = buildProgram();
    expect(childNames(program)).toContain("detectors");
    const detectors = program.commands.find((c) => c.name() === "detectors");
    expect(detectors).toBeDefined();
    expect(childNames(detectors as Command)).toContain("list");
    expect(childNames(detectors as Command)).toContain("get");
  });

  it("registers the findings command with list and get subcommands", () => {
    const program = buildProgram();
    expect(childNames(program)).toContain("findings");
    const findings = program.commands.find((c) => c.name() === "findings");
    expect(findings).toBeDefined();
    const subNames = childNames(findings as Command);
    expect(subNames).toContain("list");
    expect(subNames).toContain("get");
  });

  it("registers list, get, and export under traces — filter-values is deferred", () => {
    const program = buildProgram();
    const traces = program.commands.find((c) => c.name() === "traces");
    expect(traces).toBeDefined();
    const subNames = childNames(traces as Command);
    expect(subNames).toContain("list");
    expect(subNames).toContain("get");
    expect(subNames).toContain("export");
    expect(subNames).not.toContain("filter-values");
  });

  it("traces list keeps only the basic filters (advanced filters deferred to SQL queries)", () => {
    const program = buildProgram();
    const traces = program.commands.find((c) => c.name() === "traces");
    const list = traces?.commands.find((c) => c.name() === "list");
    expect(list).toBeDefined();
    const longs = (list as Command).options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(["--limit", "--since", "--from", "--to"]));
    for (const gone of [
      "--name",
      "--user-id",
      "--search-query",
      "--include-evaluations",
      "--filters",
    ]) {
      expect(longs).not.toContain(gone);
    }
  });

  it("does not register a sessions command (deferred until the SQL query surface lands)", () => {
    const program = buildProgram();
    expect(childNames(program)).not.toContain("sessions");
  });

  it("registers top-level commands in the fixed help order", () => {
    const program = buildProgram();
    expect(childNames(program)).toEqual([
      "login",
      "logout",
      "status",
      "workspaces",
      "projects",
      "traces",
      "detectors",
      "findings",
      "skills",
      "instrument",
      "doctor",
    ]);
  });

  it("registers list and install under skills", () => {
    const program = buildProgram();
    const skills = program.commands.find((c) => c.name() === "skills");
    expect(skills).toBeDefined();
    const subNames = childNames(skills as Command);
    expect(subNames).toContain("list");
    expect(subNames).toContain("install");
  });
});
