import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPythonEnvironment, withVenvOnPath } from "../../src/setup/python.js";

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

/**
 * Runs `fn` with the platform reported as Windows.
 *
 * The case-folding branch is Windows-only and CI runs on Linux, so without
 * this the half of the behaviour that exists for Windows is never executed.
 */
/**
 * Runs `fn` with the platform reported as POSIX.
 *
 * The counterpart to `onWindows`. `withVenvOnPath` branches on the platform, so
 * a test that asserts the POSIX rule while reading the host's own platform
 * asserts nothing on a Windows runner — it would take the collapse branch,
 * delete the other spelling, and fail.
 */
function onPosix<T>(fn: () => T): T {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
}

function onWindows<T>(fn: () => T): T {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
}

describe("running a project's own commands in its virtualenv", () => {
  it("puts the interpreter's directory first, so a venv script wins over a global one", () => {
    // The failure this prevents: `detect_stack` names `pytest`, which exists
    // only inside the virtualenv, and the spawn fails with ENOENT before a
    // single test has run.
    const env = withVenvOnPath({ PATH: "/usr/bin" }, "/repo/.venv/bin/python");

    expect(env.PATH).toBe(`/repo/.venv/bin${delimiter}/usr/bin`);
  });

  it("leaves the environment alone when there is no virtualenv", () => {
    // A service that is not Python, or one run on a system interpreter: there
    // is nothing to add and PATH must not be rewritten for it.
    const parent = { PATH: "/usr/bin" };

    expect(withVenvOnPath(parent, null)).toBe(parent);
  });

  it("leaves another spelling of PATH alone on POSIX, where it is another variable", () => {
    // `Path` is not an alias here: a child spawned with only `Path` set cannot
    // find a program in the directory it names, which is why POSIX lookup is
    // `PATH` or nothing. Deleting the others throws away variables this
    // function was never asked about.
    const env = onPosix(() =>
      withVenvOnPath({ PATH: "/usr/bin", Path: "/opt/vendor/Path" }, "/repo/.venv/bin/python"),
    );

    expect(env.PATH).toBe(`/repo/.venv/bin${delimiter}/usr/bin`);
    expect(env.Path).toBe("/opt/vendor/Path");
  });

  it("never prepends the venv to another spelling's value on POSIX", () => {
    // The order matters: picking the first spelling that happens to carry a
    // value puts `Path` ahead of `PATH` here, and the child is left with a
    // search path assembled out of a variable that was never one — the real
    // `/usr/bin` gone, so nothing but the venv resolves.
    const env = onPosix(() =>
      withVenvOnPath({ Path: "/opt/vendor/Path", PATH: "/usr/bin" }, "/repo/.venv/bin/python"),
    );

    expect(env.PATH).toBe(`/repo/.venv/bin${delimiter}/usr/bin`);
    expect(env.Path).toBe("/opt/vendor/Path");
  });

  it("collapses every spelling of PATH into one key on Windows", () => {
    // There they really are one variable, and a spread copy of process.env is
    // a plain object with no case folding, so the child could be handed both
    // `Path` and `PATH`. Which one wins is the host's business; writing one and
    // leaving the other is a bet on that answer, and losing it means the
    // virtualenv never reaches the child — exactly the ENOENT this function
    // exists to prevent. One key, no bet.
    const env = onWindows(() => withVenvOnPath({ Path: "C:\\Windows" }, "/repo/.venv/bin/python"));

    expect(env.PATH).toBe(`/repo/.venv/bin${delimiter}C:\\Windows`);
    expect("Path" in env).toBe(false);
  });

  it("keeps the inherited value when two Windows spellings disagree", () => {
    const env = onWindows(() =>
      withVenvOnPath({ PATH: "/usr/bin", Path: "" }, "/repo/.venv/bin/python"),
    );

    expect(env.PATH).toBe(`/repo/.venv/bin${delimiter}/usr/bin`);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });

  it("ignores an interpreter that is not an absolute path", () => {
    // `dirname("python3")` is ".", and prepending that puts the service
    // directory first on the child's PATH, where a repository file named
    // `pytest` would run in preference to the real one.
    const parent = { PATH: "/usr/bin" };

    expect(withVenvOnPath(parent, "python3")).toBe(parent);
    expect(withVenvOnPath(parent, "./.venv/bin/python")).toBe(parent);
  });

  it("stands on its own when the parent has no PATH at all", () => {
    expect(withVenvOnPath({}, "/repo/.venv/bin/python").PATH).toBe("/repo/.venv/bin");
  });
});
