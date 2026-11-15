import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

/**
 * Asks the interpreter for its own path, its version and the installed
 * traceroot version, as one JSON line.
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
  "print(json.dumps({'executable': sys.executable, 'python': '%d.%d.%d' % sys.version_info[:3], 'traceroot': v}))",
].join("\n");

interface ProbeAnswer {
  /** `sys.executable`; empty when the interpreter can't say. */
  executable: string;
  python: string;
  /** Null when traceroot isn't installed for this interpreter. */
  traceroot: string | null;
}

export interface PythonLookupOptions {
  /** Where to look for a virtual environment when the file is in no repository. */
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
 * `$VIRTUAL_ENV`, then `python3` on PATH. The first three are setup's own
 * search, so `setup` and this pick the same interpreter.
 *
 * @param file absolute path of the evaluation file.
 */
export async function findPythonRunner(
  file: string,
  options: PythonLookupOptions,
): Promise<RunnerLookup> {
  const dir = dirname(file);
  const root = findGitRoot(dir) ?? options.cwd;
  const venv = detectPythonEnvironment(root, relative(root, dir) || ".", options.env).interpreter;
  const program = venv ?? PATH_PYTHON;

  const { answer, result } = await probe(program, options);
  if (answer === null) {
    return {
      ok: false,
      failure: {
        kind: "no_interpreter",
        message: noInterpreterMessage(program, venv !== null, result, dir, root),
        fix: "Create a virtual environment beside the evaluation file (python3 -m venv .venv) and install traceroot into it, or activate the one that has it.",
      },
    };
  }

  // A PATH name is replaced by the path the interpreter reports for itself, so
  // the runner is the interpreter whose packages were just checked.
  const interpreter = venv ?? (answer.executable === "" ? program : answer.executable);
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
 * Runs {@link PROBE} from a new, empty folder.
 *
 * Not `-I`: isolated mode also drops user site-packages and `PYTHONPATH`, so
 * it misses a traceroot the runner can import, installed with `pip install
 * --user` or reachable only through `PYTHONPATH`. The empty folder keeps what
 * `-I` would be for: `python -c` puts the working directory first on
 * `sys.path`, and nothing in an empty folder can shadow the standard library
 * or the installed metadata.
 */
async function probe(
  program: string,
  options: PythonLookupOptions,
): Promise<{ answer: ProbeAnswer | null; result: RunProcessResult }> {
  const cwd = await mkdtemp(join(tmpdir(), "traceroot-python-probe-"));
  try {
    const result = await (options.runProcess ?? runProcess)({
      program,
      args: ["-c", PROBE],
      cwd,
      env: options.env,
      stdio: "capture",
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { answer: result.spawnFailed ? null : parseProbe(result.output), result };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * The probe's answer, read from the last line that is one.
 *
 * The output is stdout and stderr together, and a `.pth` file or
 * `sitecustomize` may print on either, so no other line is assumed absent.
 */
function parseProbe(output: string): ProbeAnswer | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.python === "string") {
        return {
          executable: typeof value.executable === "string" ? value.executable : "",
          python: value.python,
          traceroot: typeof value.traceroot === "string" ? value.traceroot : null,
        };
      }
    } catch {
      // Not the probe's line.
    }
  }
  return null;
}

function noInterpreterMessage(
  program: string,
  fromVenv: boolean,
  result: RunProcessResult,
  dir: string,
  root: string,
): string {
  if (result.spawnFailed) {
    if (fromVenv) {
      return `${program} could not be started.`;
    }
    const searched = dir === root ? dir : `${dir} or ${root}`;
    return `No Python interpreter found: no .venv, venv or env in ${searched}, no usable $VIRTUAL_ENV, and no ${program} on PATH.`;
  }
  if (result.timedOut) {
    return `${program} did not report its Python and traceroot versions within ${PROBE_TIMEOUT_MS / 1000} seconds.`;
  }
  const lastLine = result.output.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  return `${program} did not report its Python and traceroot versions${lastLine === "" ? "." : `: ${lastLine}`}`;
}

/** A path as one POSIX shell word, quoted the way setup quotes the interpreter in its install command. */
function shellWord(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
