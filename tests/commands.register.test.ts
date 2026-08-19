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

  it("registers list, get, export, and filter-values under traces", () => {
    const program = buildProgram();
    const traces = program.commands.find((c) => c.name() === "traces");
    expect(traces).toBeDefined();
    const subNames = childNames(traces as Command);
    expect(subNames).toContain("list");
    expect(subNames).toContain("get");
    expect(subNames).toContain("export");
    expect(subNames).toContain("filter-values");
  });

  it("registers the sessions command with list and get subcommands", () => {
    const program = buildProgram();
    expect(childNames(program)).toContain("sessions");
    const sessions = program.commands.find((c) => c.name() === "sessions");
    expect(sessions).toBeDefined();
    const subNames = childNames(sessions as Command);
    expect(subNames).toContain("list");
    expect(subNames).toContain("get");
  });

  it("registers top-level commands in the fixed help order", () => {
    const program = buildProgram();
    expect(childNames(program)).toEqual([
      "login",
      "status",
      "traces",
      "detectors",
      "findings",
      "sessions",
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
