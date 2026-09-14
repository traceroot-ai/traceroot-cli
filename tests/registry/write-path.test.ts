import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "../../src/output.js";
import { assertEnums, assertRequiredArgs, readBodyFile } from "../../src/registry/factory.js";

const createAlert = REGISTRY.find((e) => e.name === "create_alert");
if (createAlert === undefined) throw new Error("registry fixture missing");

describe("assertRequiredArgs", () => {
  it("rejects a missing required field as a usage error", () => {
    let thrown: unknown;
    try {
      assertRequiredArgs(createAlert, { project_id: "p-1", name: "n" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("view");
  });

  it("accepts a complete set of required fields", () => {
    const args: Record<string, unknown> = {
      project_id: "p-1",
      name: "n",
      view: "SPANS",
      measure: "duration_ms",
      aggregation: "p95",
      window: "5m",
      threshold_operator: ">",
      threshold: 1500,
      renotify: { mode: "OFF" },
    };
    expect(() => assertRequiredArgs(createAlert, args)).not.toThrow();
  });
});

describe("assertEnums", () => {
  it("rejects a value outside the schema enum", () => {
    let thrown: unknown;
    try {
      assertEnums(createAlert, { aggregation: "p95x" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("p95");
  });

  it("accepts a valid enum value", () => {
    expect(() => assertEnums(createAlert, { aggregation: "p95" })).not.toThrow();
  });
});

describe("readBodyFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "tr-body-"));

  it("reads a JSON object from a path", () => {
    const p = join(dir, "rule.json");
    writeFileSync(p, JSON.stringify({ name: "n", threshold: 1500 }));
    expect(readBodyFile(p)).toEqual({ name: "n", threshold: 1500 });
  });

  it("rejects invalid JSON as a usage error", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    let thrown: unknown;
    try {
      readBodyFile(p);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
  });

  it("rejects a non-object JSON document", () => {
    const p = join(dir, "arr.json");
    writeFileSync(p, "[1,2]");
    expect(() => readBodyFile(p)).toThrow(CliError);
  });

  it("rejects an unreadable path without leaking errno noise", () => {
    let thrown: unknown;
    try {
      readBodyFile(join(dir, "missing.json"));
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("--from-file");
  });
});
