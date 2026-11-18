import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { type RunProcess, type RunProcessResult, runProcess } from "../setup/exec.js";
import { findGitRoot } from "../setup/git.js";
import { detectPythonEnvironment } from "../setup/python.js";
import { meetsNodeFloor } from "../util/index.js";
import type { RunnerLookup } from "./lookup.js";

/**
 * The oldest traceroot this runs: from 0.3.0, a local run drops every span it
 * starts, even in an app that already called `initialize()`.
 */
export const PYTHON_SDK_FLOOR = "0.3.0";

/** The interpreter tried last, by the name each platform installs it under. */
const PATH_PYTHON = process.platform === "win32" ? "python" : "python3";

const PROBE_TIMEOUT_MS = 30_000;

/** Asks an interpreter for its own path, as one JSON line. */
const WHERE = "import json, sys\nprint(json.dumps({'executable': sys.executable}))\n";

/**
 * Asks the interpreter for its version and the installed traceroot version,
 * as one JSON line.
 *
 * The version comes from distribution metadata, so neither the SDK nor any
 * user code is imported: a slow or failing import can't pass for "not
 * installed", and nothing of the project runs before the runner does.
 */
const PROBE = [
  "import importlib.metadata as m, json, sys",
  "try:",
  "    v = m.version('traceroot')",
  "except m.PackageNotFoundError:",
  "    v = None",
  "print(json.dumps({'python': '%d.%d.%d' % sys.version_info[:3], 'traceroot': v}))",
].join("\n");

interface ProbeAnswer {
  python: string;
  /** Null when traceroot isn't installed for this interpreter. */
  traceroot: string | null;
}

/** An interpreter that didn't answer: which one, what it was asked, and what came back. */
interface Unanswered {
  ok: false;
  program: string;
  /** Completes "<program> did not …". */
  asked: string;
  result: RunProcessResult;
}

type Probed = { ok: true; interpreter: string; answer: ProbeAnswer } | Unanswered;

export interface PythonLookupOptions {
  /**
   * The working directory the runner starts in: where to look for a virtual environment when the
   * file is in no repository, and what a relative `PYTHONPATH` entry is read against.
   */
  cwd: string;
  /** The environment the runner gets, so the probe sees the packages it will. */
  env: NodeJS.ProcessEnv;
  runProcess?: RunProcess;
}

/**
 * Finds the interpreter for a `.py` evaluation file and checks its traceroot.
 *
 * First match wins: a `.venv`, `venv` or `env` in the file's folder, then at
 * the repository root (the working directory outside a repository), then
 * `$VIRTUAL_ENV`, then the interpreter `python3` on PATH starts in the file's
 * folder. The first three are setup's own search, so `setup` and this pick
 * the same interpreter.
 *
 * @param file absolute path of the evaluation file.
 */
export async function findPythonRunner(
  file: string,
  options: PythonLookupOptions,
): Promise<RunnerLookup> {
  const dir = dirname(file);
  const root = findGitRoot(dir) ?? options.cwd;
  const found = detectPythonEnvironment(root, relative(root, dir) || ".", options.env).interpreter;
  // Made absolute against the working directory, where the search found it: a
  // relative $VIRTUAL_ENV names another path from the folder the probe runs in.
  const venv = found === null ? null : resolve(found);

  const probed = await probe(venv, dir, options);
  if (!probed.ok) {
    return {
      ok: false,
      failure: {
        kind: "no_interpreter",
        message: noInterpreterMessage(probed, dir, root),
        fix: "Create a virtual environment beside the evaluation file (python3 -m venv .venv) and install traceroot into it, or activate the one that has it.",
      },
    };
  }

  const { interpreter, answer } = probed;
  const named = `${interpreter} (Python ${answer.python})`;
  if (answer.traceroot === null) {
    return {
      ok: false,
      failure: {
        kind: "sdk_missing",
        message: `traceroot is not installed for ${named}.`,
        fix: `${shellWord(interpreter)} -m pip install traceroot`,
      },
    };
  }
  if (!meetsNodeFloor(answer.traceroot, PYTHON_SDK_FLOOR)) {
    return {
      ok: false,
      failure: {
        kind: "sdk_too_old",
        message: `traceroot ${answer.traceroot} is installed for ${named}; running an evaluation needs ${PYTHON_SDK_FLOOR} or later.`,
        fix: `${shellWord(interpreter)} -m pip install --upgrade traceroot`,
      },
    };
  }
  return {
    ok: true,
    runner: {
      language: "python",
      sdkVersion: answer.traceroot,
      argv: [interpreter, "-m", "traceroot.eval.runner", file],
    },
  };
}

/**
 * Settles which interpreter runs and reads its versions with {@link PROBE},
 * in a new temporary folder that is removed afterwards.
 *
 * A virtual environment's interpreter is the one that runs. Otherwise
 * `python3` on PATH is first asked for its own path ({@link WHERE}) from the
 * evaluation file's folder, because a pyenv, asdf or mise shim picks its
 * Python from the folder it starts in, and from any other folder that is the
 * global one. That question runs with `-I`, so nothing in the project's
 * folder is imported, and from a file rather than `-c`, so a Windows batch
 * shim isn't refused for the quotes and line breaks in the code. When it
 * gets no path, the lookup reports no interpreter rather than ask `python3`
 * from another folder, where it may start another Python. The runner is then
 * the interpreter whose packages the probe checked.
 *
 * The probe itself runs from an empty folder, not with `-I`: isolated mode
 * also drops user site-packages and `PYTHONPATH`, so it misses a traceroot the
 * runner can import, installed with `pip install --user` or reachable only
 * through `PYTHONPATH`. The empty folder keeps what `-I` would be for:
 * `python -c` puts the working directory first on `sys.path`, and nothing in
 * an empty folder can shadow the standard library or the installed metadata.
 * Python reads a relative `PYTHONPATH` entry against the folder it starts in,
 * so the probe gets each one made absolute against the runner's working
 * directory first ({@link pythonPathFrom}), and finds what the runner will.
 */
async function probe(
  venv: string | null,
  dir: string,
  options: PythonLookupOptions,
): Promise<Probed> {
  const temp = await mkdtemp(join(tmpdir(), "traceroot-python-probe-"));
  try {
    let interpreter = venv;
    if (interpreter === null) {
      const where = join(temp, "where.py");
      await writeFile(where, WHERE);
      const result = await ask(PATH_PYTHON, ["-I", where], dir, options);
      const path = lastAnswer(result, "executable")?.executable;
      if (typeof path !== "string" || path === "") {
        return { ok: false, program: PATH_PYTHON, asked: "report its path", result };
      }
      interpreter = path;
    }

    const empty = join(temp, "empty");
    await mkdir(empty);
    const env = pythonPathFrom(options.cwd, options.env);
    const result = await ask(interpreter, ["-c", PROBE], empty, { ...options, env });
    const answer = lastAnswer(result, "python");
    if (answer === null) {
      return {
        ok: false,
        program: interpreter,
        asked: "report its Python and traceroot versions",
        result,
      };
    }
    return {
      ok: true,
      interpreter,
      answer: {
        python: answer.python as string,
        traceroot: typeof answer.traceroot === "string" ? answer.traceroot : null,
      },
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * `env` with each `PYTHONPATH` entry made absolute against `cwd`, as Python makes it when it starts
 * there: an empty entry is `cwd` itself. A process started from another folder then reads the same
 * folders as one started from `cwd`.
 */
function pythonPathFrom(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const value = env.PYTHONPATH;
  if (value === undefined || value === "") {
    return env;
  }
  const entries = value.split(delimiter).map((entry) => resolve(cwd, entry));
  return { ...env, PYTHONPATH: entries.join(delimiter) };
}

/** Runs one question to an interpreter, in the environment the runner gets. */
function ask(
  program: string,
  args: string[],
  cwd: string,
  options: PythonLookupOptions,
): Promise<RunProcessResult> {
  return (options.runProcess ?? runProcess)({
    program,
    args,
    cwd,
    env: options.env,
    stdio: "capture",
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

/**
 * The last line of output that is a JSON object with a string `key`, or null.
 *
 * The output is stdout and stderr together, and a `.pth` file or
 * `sitecustomize` may print on either, so no other line is assumed absent.
 */
function lastAnswer(result: RunProcessResult, key: string): Record<string, unknown> | null {
  if (result.spawnFailed) return null;
  for (const line of result.output.split(/\r?\n/).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value[key] === "string") return value;
    } catch {
      // Not the answer's line.
    }
  }
  return null;
}

function noInterpreterMessage(unanswered: Unanswered, dir: string, root: string): string {
  const { program, asked, result } = unanswered;
  if (result.spawnFailed) {
    if (program !== PATH_PYTHON) {
      return `${program} could not be started.`;
    }
    const searched = dir === root ? dir : `${dir} or ${root}`;
    return `No Python interpreter found: no .venv, venv or env in ${searched}, no usable $VIRTUAL_ENV, and no ${program} on PATH.`;
  }
  if (result.timedOut) {
    return `${program} did not ${asked} within ${PROBE_TIMEOUT_MS / 1000} seconds.`;
  }
  const lastLine = result.output.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  return `${program} did not ${asked}${lastLine === "" ? "." : `: ${lastLine}`}`;
}

/** A path as one POSIX shell word, quoted the way setup quotes the interpreter in its install command. */
function shellWord(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
