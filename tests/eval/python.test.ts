import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PYTHON_SDK_FLOOR, findPythonRunner } from "../../src/eval/python.js";
import {
  type RunProcess,
  type RunProcessOptions,
  resolveSpawnTarget,
} from "../../src/setup/exec.js";

/** The stub interpreters below are shell scripts. */
const WINDOWS = process.platform === "win32";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-eval-python-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * An interpreter that answers the version probe with fixed versions, reports
 * its own path as `sys.executable` does, and records how it was asked: its
 * working directory, what was in it, and the code it was given.
 */
function stubPython(path: string, python: string, traceroot: string | null): string {
  mkdirSync(dirname(path), { recursive: true });
  const fields = `"python": ${JSON.stringify(python)}, "traceroot": ${JSON.stringify(traceroot)}`;
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'pwd > "$0.cwd"',
      '/bin/ls -A > "$0.ls"',
      'printf %s "$2" > "$0.code"',
      `printf '{"executable": "%s", ${fields}}\\n' "$0"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

/** A virtual environment's interpreter, at the layout setup's search looks for. */
function venvIn(base: string, python = "3.12.4", traceroot: string | null = "0.5.1"): string {
  return stubPython(join(base, ".venv", "bin", "python"), python, traceroot);
}

/** An evaluation file inside `base`, which need not exist yet. */
function evalFile(base: string): string {
  mkdirSync(base, { recursive: true });
  const file = join(base, "x_eval.py");
  writeFileSync(file, "");
  return file;
}

/**
 * A `python3` that picks its interpreter the way a pyenv, asdf or mise shim
 * does: the nearest `.python-version` above the folder it runs in selects
 * `pinned`, and without one it runs `global`. A null `pinned` is a version
 * that isn't installed, which fails. Returns the folder to put on PATH.
 */
function versionShim(pinned: string | null, global: string): string {
  const shims = join(dir, "shims");
  mkdirSync(shims, { recursive: true });
  const runPinned =
    pinned === null
      ? `{ echo "python3: version 'pinned' is not installed" >&2; exit 1; }`
      : `exec '${pinned}' "$@"`;
  writeFileSync(
    join(shims, "python3"),
    [
      "#!/bin/sh",
      'd="$PWD"',
      'while [ -n "$d" ]; do',
      `  [ -f "$d/.python-version" ] && ${runPinned}`,
      '  d="${d%/*}"',
      "done",
      `exec '${global}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return shims;
}

/** A folder for PATH with nothing in it, so no real interpreter is found. */
function emptyPath(): string {
  const bin = join(dir, "empty-bin");
  mkdirSync(bin, { recursive: true });
  return bin;
}

describe.skipIf(WINDOWS)("finding the Python interpreter for an evaluation file", () => {
  it("prefers a virtual environment in the file's folder over one at the repository root", async () => {
    mkdirSync(join(dir, ".git"));
    venvIn(dir);
    const own = venvIn(join(dir, "evals"));
    const file = evalFile(join(dir, "evals"));

    const found = await findPythonRunner(file, { cwd: dir, env: { PATH: emptyPath() } });

    expect(found).toEqual({
      ok: true,
      runner: {
        language: "python",
        sdkVersion: "0.5.1",
        argv: [own, "-m", "traceroot.eval.runner", file],
        runtime: { name: "Python", version: "3.12.4", executable: own },
      },
    });
  });

  it("takes the repository root's virtual environment over $VIRTUAL_ENV", async () => {
    // A shell often has an unrelated venv active; the project's own is the one
    // its dependencies are installed into.
    mkdirSync(join(dir, ".git"));
    const project = venvIn(dir);
    const active = join(dir, "elsewhere");
    stubPython(join(active, "bin", "python"), "3.12.4", "0.5.1");
    const file = evalFile(join(dir, "app", "evals"));

    const found = await findPythonRunner(file, {
      cwd: dir,
      env: { PATH: emptyPath(), VIRTUAL_ENV: active },
    });

    expect(found.ok && found.runner.argv[0]).toBe(project);
  });

  it("takes $VIRTUAL_ENV over python3 on PATH", async () => {
    const active = join(dir, "active");
    const activated = stubPython(join(active, "bin", "python"), "3.12.4", "0.5.1");
    stubPython(join(dir, "bin", "python3"), "3.12.4", "0.5.1");
    const file = evalFile(join(dir, "project"));

    const found = await findPythonRunner(file, {
      cwd: join(dir, "project"),
      env: { PATH: join(dir, "bin"), VIRTUAL_ENV: active },
    });

    expect(found.ok && found.runner.argv[0]).toBe(activated);
  });

  it("falls back to python3 on PATH, named by the path it reports for itself", async () => {
    const onPath = stubPython(join(dir, "bin", "python3"), "3.12.4", "0.5.1");
    const file = evalFile(join(dir, "project"));

    const found = await findPythonRunner(file, {
      cwd: join(dir, "project"),
      env: { PATH: join(dir, "bin") },
    });

    expect(found.ok && found.runner.argv[0]).toBe(onPath);
  });

  it("runs the python3 a version manager picks for the file's folder, not the global one", async () => {
    const pinned = stubPython(join(dir, "versions", "pinned", "bin", "python3"), "3.12.4", "0.5.1");
    const global = stubPython(join(dir, "versions", "global", "bin", "python3"), "3.11.9", null);
    const file = evalFile(join(dir, "project", "evals"));
    writeFileSync(join(dir, "project", ".python-version"), "pinned\n");

    // Run from outside the project, so only the file's folder has the version file above it.
    const found = await findPythonRunner(file, {
      cwd: dir,
      env: { PATH: versionShim(pinned, global) },
    });

    expect(found).toEqual({
      ok: true,
      runner: {
        language: "python",
        sdkVersion: "0.5.1",
        argv: [pinned, "-m", "traceroot.eval.runner", file],
        runtime: { name: "Python", version: "3.12.4", executable: pinned },
      },
    });
  });

  it("says no interpreter was found when python3 fails in the file's folder, without trying another", async () => {
    // The global one has traceroot, so running it would look like success.
    const global = stubPython(join(dir, "versions", "global", "bin", "python3"), "3.11.9", "0.5.1");
    const file = evalFile(join(dir, "project"));
    writeFileSync(join(dir, "project", ".python-version"), "pinned\n");

    const found = await findPythonRunner(file, {
      cwd: dir,
      env: { PATH: versionShim(null, global) },
    });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.failure.kind).toBe("no_interpreter");
    expect(found.failure.message).toBe(
      "python3 did not report its path: python3: version 'pinned' is not installed",
    );
  });

  it("asks python3 on PATH which interpreter it is in a way a Windows batch shim can start", async () => {
    const calls: RunProcessOptions[] = [];
    const answer = JSON.stringify({
      executable: "/opt/py/bin/python3",
      python: "3.12.4",
      traceroot: "0.5.1",
    });
    const recording: RunProcess = async (call) => {
      calls.push(call);
      return {
        exitCode: 0,
        output: `${answer}\n`,
        durationMs: 1,
        timedOut: false,
        spawnFailed: false,
      };
    };
    const file = evalFile(join(dir, "project"));

    await findPythonRunner(file, { cwd: dir, env: { PATH: emptyPath() }, runProcess: recording });

    const first = calls[0] as RunProcessOptions;
    // A pyenv-win shim is a batch file, started through cmd.exe, which refuses
    // an argument carrying quotes, parentheses or line breaks.
    const target = resolveSpawnTarget("python", first.args, {
      platform: "win32",
      env: { PATH: "C:\\pyenv\\shims", PATHEXT: ".BAT" },
      isFile: (path) => path === "C:\\pyenv\\shims\\python.BAT",
    });
    // Only the cmd.exe form is verbatim; a refusal is null.
    expect(target?.windowsVerbatimArguments).toBe(true);
    // Isolated, from the file's folder, where the shim picks its version.
    expect(first.args[0]).toBe("-I");
    expect(first.cwd).toBe(dirname(file));
  });

  it("runs a relative $VIRTUAL_ENV from the working directory it is relative to", async () => {
    const active = join(dir, "active");
    const activated = stubPython(join(active, "bin", "python"), "3.12.4", "0.5.1");
    const file = evalFile(join(dir, "project"));

    const found = await findPythonRunner(file, {
      cwd: join(dir, "project"),
      // Relative to this process's own working directory, as a shell would pass it.
      env: { PATH: emptyPath(), VIRTUAL_ENV: relative(process.cwd(), active) },
    });

    expect(found.ok && found.runner.argv[0]).toBe(activated);
  });

  it("looks in the working directory when the file is in no repository", async () => {
    const work = venvIn(join(dir, "work"));
    const file = evalFile(join(dir, "scratch"));

    const found = await findPythonRunner(file, {
      cwd: join(dir, "work"),
      env: { PATH: emptyPath() },
    });

    expect(found.ok && found.runner.argv[0]).toBe(work);
  });

  it("says no interpreter was found when there is none to run", async () => {
    const file = evalFile(join(dir, "project"));

    const found = await findPythonRunner(file, {
      cwd: join(dir, "project"),
      env: { PATH: emptyPath() },
    });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.failure.kind).toBe("no_interpreter");
    expect(found.failure.message).toContain("No Python interpreter found");
    expect(found.failure.fix).toContain("virtual environment");
  });

  it("reports an interpreter that can't answer, with its last line of output", async () => {
    const broken = join(dir, ".venv", "bin", "python");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, "#!/bin/sh\necho 'ImportError: No module named metadata' >&2\nexit 1\n", {
      mode: 0o755,
    });
    const file = evalFile(dir);

    const found = await findPythonRunner(file, { cwd: dir, env: { PATH: emptyPath() } });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.failure.kind).toBe("no_interpreter");
    expect(found.failure.message).toContain(broken);
    expect(found.failure.message).toContain("ImportError: No module named metadata");
  });
});

describe.skipIf(WINDOWS)("checking the installed traceroot", () => {
  it("reads the version without importing it, from an empty folder that is then removed", async () => {
    const python = venvIn(dir);
    // Anything here could shadow the standard library if the probe ran here.
    writeFileSync(join(dir, "json.py"), "raise SystemExit('shadowed')\n");
    const file = evalFile(dir);

    await findPythonRunner(file, { cwd: dir, env: { PATH: emptyPath() } });

    const probedIn = readFileSync(`${python}.cwd`, "utf8").trim();
    expect(probedIn).not.toBe(dir);
    expect(readFileSync(`${python}.ls`, "utf8")).toBe("");
    expect(existsSync(probedIn)).toBe(false);
    const code = readFileSync(`${python}.code`, "utf8");
    expect(code).toContain("importlib.metadata");
    expect(code).not.toMatch(/import traceroot|from traceroot/);
  });

  it("refuses traceroot 0.2.0, naming the installed version and the floor", async () => {
    const python = venvIn(dir, "3.12.4", "0.2.0");
    const file = evalFile(dir);

    const found = await findPythonRunner(file, { cwd: dir, env: { PATH: emptyPath() } });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.failure.kind).toBe("sdk_too_old");
    expect(found.failure.message).toContain("traceroot 0.2.0");
    expect(found.failure.message).toContain(PYTHON_SDK_FLOOR);
    expect(found.failure.message).toContain(python);
    expect(found.failure.fix).toBe(`'${python}' -m pip install --upgrade traceroot`);
  });

  it("accepts the floor itself", async () => {
    venvIn(dir, "3.12.4", PYTHON_SDK_FLOOR);
    const file = evalFile(dir);

    const found = await findPythonRunner(file, { cwd: dir, env: { PATH: emptyPath() } });

    expect(found.ok && found.runner.sdkVersion).toBe(PYTHON_SDK_FLOOR);
  });

  it("names the interpreter and its Python version when traceroot is missing", async () => {
    const python = venvIn(dir, "3.11.9", null);
    const file = evalFile(dir);

    const found = await findPythonRunner(file, { cwd: dir, env: { PATH: emptyPath() } });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.failure.kind).toBe("sdk_missing");
    expect(found.failure.message).toBe(`traceroot is not installed for ${python} (Python 3.11.9).`);
    expect(found.failure.fix).toBe(`'${python}' -m pip install traceroot`);
  });
});

/** The real `python3` on PATH when it has `importlib.metadata`, else null. */
function realPython(): string | null {
  if (WINDOWS) return null;
  const result = spawnSync(
    "python3",
    ["-c", "import sys, importlib.metadata; print(sys.executable)"],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

const PYTHON3 = realPython();

/** An installed distribution as `importlib.metadata` sees one, with no code behind it. */
function distInfo(sitePackages: string, version: string): void {
  const info = join(sitePackages, `traceroot-${version}.dist-info`);
  mkdirSync(info, { recursive: true });
  writeFileSync(
    join(info, "METADATA"),
    `Metadata-Version: 2.1\nName: traceroot\nVersion: ${version}\n`,
  );
}

describe.runIf(PYTHON3 !== null)("checking traceroot with a real interpreter", () => {
  const python3 = PYTHON3 as string;

  it("finds traceroot reachable only through PYTHONPATH, without importing it", async () => {
    const site = join(dir, "site");
    distInfo(site, "0.5.1");
    // Importing the package would leave this file behind.
    const marker = join(dir, "imported");
    mkdirSync(join(site, "traceroot"));
    writeFileSync(
      join(site, "traceroot", "__init__.py"),
      `open(${JSON.stringify(marker)}, "w").close()\n`,
    );
    const file = evalFile(join(dir, "project"));

    const found = await findPythonRunner(file, {
      cwd: join(dir, "project"),
      env: { PATH: dirname(python3), PYTHONPATH: site },
    });

    expect(found.ok && found.runner.sdkVersion).toBe("0.5.1");
    expect(existsSync(marker)).toBe(false);
  });

  it("reads a relative PYTHONPATH entry against the working directory, as the runner does", async () => {
    const project = join(dir, "project");
    distInfo(join(project, "vendor"), "0.5.1");
    const file = evalFile(project);

    const found = await findPythonRunner(file, {
      cwd: project,
      env: { PATH: dirname(python3), PYTHONPATH: "vendor" },
    });

    expect(found.ok && found.runner.sdkVersion).toBe("0.5.1");
  });

  it("reads an empty PYTHONPATH entry as the working directory, as the runner does", async () => {
    const project = join(dir, "project");
    distInfo(project, "0.5.1");
    const file = evalFile(project);

    const found = await findPythonRunner(file, {
      cwd: project,
      env: { PATH: dirname(python3), PYTHONPATH: `${delimiter}${join(dir, "elsewhere")}` },
    });

    expect(found.ok && found.runner.sdkVersion).toBe("0.5.1");
  });

  it("finds traceroot installed with pip install --user", async () => {
    const userBase = join(dir, "userbase");
    const env = { PATH: dirname(python3), PYTHONUSERBASE: userBase };
    const site = spawnSync(
      python3,
      [
        "-c",
        "import json, site; print(json.dumps([site.ENABLE_USER_SITE, site.getusersitepackages()]))",
      ],
      { encoding: "utf8", env, cwd: dir },
    );
    const [enabled, userSite] = JSON.parse(site.stdout) as [boolean, string];
    // An interpreter inside a virtual environment has no user site to find.
    if (!enabled) return;
    distInfo(userSite, "0.4.0");
    const file = evalFile(join(dir, "project"));

    const found = await findPythonRunner(file, { cwd: join(dir, "project"), env });

    expect(found.ok && found.runner.sdkVersion).toBe("0.4.0");
  });
});
