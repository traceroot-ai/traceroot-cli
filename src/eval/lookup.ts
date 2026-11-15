import { extname, resolve } from "node:path";
import type { RunProcess } from "../setup/exec.js";
import type { StackLanguage } from "../setup/types.js";
import { findNodeRunner } from "./node.js";
import { findPythonRunner } from "./python.js";

/**
 * What it takes to run one evaluation file: the interpreter that has the
 * user's SDK installed, the runner entry point inside that SDK, and a check
 * that the SDK is a release this supports.
 *
 * The lookup only finds. The only processes it starts are Python's, asked for
 * its path and its versions; it runs nothing it found and chooses no exit
 * code. Every way it can fail is a {@link LookupFailure} with a one-line fix,
 * never a thrown error, so the command decides what each one exits with.
 */
export interface EvalRunner {
  language: StackLanguage;
  /** The installed SDK's version, already checked against its floor. */
  sdkVersion: string;
  /** The runner command, program first, spawned as given and never through a shell. */
  argv: string[];
}

export type LookupFailureKind =
  | "unsupported_extension"
  | "no_interpreter"
  | "sdk_missing"
  | "sdk_too_old"
  | "tsx_missing"
  | "tsx_too_old"
  | "node_too_old";

export interface LookupFailure {
  kind: LookupFailureKind;
  /** What was found, naming the interpreter, the versions and the floor involved. */
  message: string;
  /** The one thing to do about it. */
  fix: string;
}

export type RunnerLookup = { ok: true; runner: EvalRunner } | { ok: false; failure: LookupFailure };

/** The extensions the runners load, and the language each is. */
const LANGUAGES: ReadonlyMap<string, StackLanguage> = new Map([
  [".py", "python"],
  [".ts", "typescript"],
  [".js", "javascript"],
  [".mjs", "javascript"],
]);

export interface LookupOptions {
  /** What a relative file is resolved against; outside a repository, also where a venv is looked for. */
  cwd?: string;
  /** The environment the runner will get. */
  env?: NodeJS.ProcessEnv;
  runProcess?: RunProcess;
  /** The Node running the CLI, which runs a TypeScript or JavaScript runner too. */
  execPath?: string;
  nodeVersion?: string;
}

/** Finds the runner for one evaluation file, by its extension. */
export async function findEvalRunner(
  file: string,
  options: LookupOptions = {},
): Promise<RunnerLookup> {
  const cwd = options.cwd ?? process.cwd();
  const path = resolve(cwd, file);
  const language = LANGUAGES.get(extname(path));
  if (language === undefined) {
    return {
      ok: false,
      failure: {
        kind: "unsupported_extension",
        message: `${file} is not a Python, TypeScript or JavaScript evaluation file.`,
        fix: "Use a .py, .ts, .js or .mjs file.",
      },
    };
  }
  if (language === "python") {
    return findPythonRunner(path, {
      cwd,
      env: options.env ?? process.env,
      runProcess: options.runProcess,
    });
  }
  return findNodeRunner(path, language, {
    execPath: options.execPath,
    nodeVersion: options.nodeVersion,
  });
}
