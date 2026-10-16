import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPythonEnvironment } from "../../src/setup/python.js";

let dir: string;

function venvAt(base: string): string {
  const bin = join(base, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "python"), "#!/bin/sh\n");
  return join(bin, "python");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-python-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("finding the Python a service actually runs on", () => {
  it("prefers a virtualenv beside the service over one at the root", () => {
    // A monorepo with one venv per service must not get the first one found
    // applied to all of them.
    venvAt(dir);
    mkdirSync(join(dir, "svc"), { recursive: true });
    const own = venvAt(join(dir, "svc"));

    expect(detectPythonEnvironment(dir, "svc", {}).interpreter).toBe(own);
  });

  it("falls back to the repository root", () => {
    const root = venvAt(dir);
    mkdirSync(join(dir, "svc"), { recursive: true });

    expect(detectPythonEnvironment(dir, "svc", {}).interpreter).toBe(root);
  });

  it("takes an activated virtualenv only when the repository has none", () => {
    // Running setup inside an unrelated activated venv must not put the SDK
    // there when the repository has one of its own.
    const owned = venvAt(dir);
    const elsewhere = mkdtempSync(join(tmpdir(), "tr-active-"));
    mkdirSync(join(elsewhere, "bin"), { recursive: true });
    writeFileSync(join(elsewhere, "bin", "python"), "#!/bin/sh\n");

    expect(detectPythonEnvironment(dir, ".", { VIRTUAL_ENV: elsewhere }).interpreter).toBe(owned);

    const bare = mkdtempSync(join(tmpdir(), "tr-bare-"));
    expect(detectPythonEnvironment(bare, ".", { VIRTUAL_ENV: elsewhere }).interpreter).toBe(
      join(elsewhere, "bin", "python"),
    );
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  it("says so plainly when there is nothing to find", () => {
    // Null is a real answer: the task tells the agent to create a venv rather
    // than to force past PEP 668.
    expect(detectPythonEnvironment(dir, ".", {}).interpreter).toBeNull();
  });
});
