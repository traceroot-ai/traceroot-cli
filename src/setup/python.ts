import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ENV_FILES } from "./envWrite.js";

/**
 * Finds the Python the service is actually run with.
 *
 * This exists because of PEP 668. A Homebrew, Debian or pyenv-shim Python
 * marks itself externally managed, and `python3 -m pip install` on it fails
 * outright:
 *
 *     error: externally-managed-environment
 *
 * An agent that hits that has to work out on its own that a virtualenv exists
 * somewhere and which one is the right one — listing candidate directories,
 * reading `lib/python3.x/site-packages`, comparing two venvs of different
 * Python versions — before it writes a single line of code. Naming the
 * interpreter up front removes all of it.
 *
 * The search is deliberately shallow and ordered by specificity: a venv beside
 * the service beats one at the repository root, because a monorepo with one
 * venv per service must not have the first one found applied to all of them.
 */

/** Relative locations of an interpreter inside a virtualenv, by platform. */
const BIN_PATHS = ["bin/python", "Scripts/python.exe"] as const;
const VENV_DIRS = [".venv", "venv", "env"] as const;

/** The interpreter inside one virtualenv, whichever platform's layout it has. */
function interpreterAt(venvDir: string): string | null {
  for (const bin of BIN_PATHS) {
    const candidate = join(venvDir, ...bin.split("/"));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function interpreterIn(dir: string): string | null {
  for (const venv of VENV_DIRS) {
    const found = interpreterAt(join(dir, venv));
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export interface PythonEnvironment {
  /**
   * Absolute path to a virtualenv interpreter, or null when there is none to
   * find. Null is a real answer and the task says something different for it.
   */
  interpreter: string | null;
}

/**
 * Looks beside the service, then at the repository root, then at whatever
 * virtualenv the user already has active.
 *
 * `VIRTUAL_ENV` comes last rather than first: a user who ran `traceroot setup`
 * inside an unrelated activated venv should not have the SDK installed there
 * when the repository has one of its own.
 */
export function detectPythonEnvironment(
  root: string,
  servicePath: string,
  env: NodeJS.ProcessEnv = process.env,
): PythonEnvironment {
  const serviceDir = servicePath === "." ? root : join(root, servicePath);
  const found = interpreterIn(serviceDir) ?? interpreterIn(root);
  if (found !== null) {
    return { interpreter: found };
  }

  const active = env.VIRTUAL_ENV;
  return { interpreter: active === undefined || active === "" ? null : interpreterAt(active) };
}

/**
 * Env files the service could be getting its own credentials from.
 *
 * Not read, only named — the contents are the user's secrets and setup has no
 * business opening them. Naming them is enough: an agent that has to *run* the
 * application needs whatever key the application itself requires (an
 * `ANTHROPIC_API_KEY`, a database URL), and that is never something setup
 * provides. An agent left to find them itself burns the start of the run on
 * `pwd`, `cd`, `export`, a hand-written dotenv parser and failed invocations
 * before it finds the one at the repository root.
 *
 * Returned relative to the agent's working directory, which is the service, so
 * the path can be pasted straight into a command.
 *
 * One of them now holds the TraceRoot key as well: `configure_repository` runs
 * before the stage that builds the agent's task and writes into a file from
 * {@link PROJECT_ENV_FILES}, so a file it created is found here like any other.
 * That is the point of writing there — the credential is not a separate thing
 * the agent has to load separately.
 */
export function detectEnvFiles(root: string, servicePath: string): string[] {
  const serviceDir = servicePath === "." ? root : join(root, servicePath);
  const found: string[] = [];
  for (const dir of serviceDir === root ? [root] : [serviceDir, root]) {
    for (const name of PROJECT_ENV_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        found.push(dir === serviceDir ? `./${name}` : relative(serviceDir, candidate));
      }
    }
  }
  return found;
}
