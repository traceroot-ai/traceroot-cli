import { getVersion } from "../version.js";

/** Where npx unpacks a package it runs, as a path segment on either platform. */
const NPX_CACHE_SEGMENT = /[\\/]_npx[\\/]/;

/**
 * The command that starts setup again, spelled the way this run was started.
 *
 * Every remedy and every "rerun with --resume" hands the user a command to type.
 * The browser's hand-back is `npx -y traceroot-cli@<version> setup`, and npx
 * runs the package out of its own cache: nothing named `traceroot` lands on
 * PATH. So a run started from the browser that paused — no trace yet, an agent
 * missing, a check to fix — told the user to run a command their shell did not
 * have. Under npx the hint names the same package at the version that is
 * running, because that is what wrote the checkpoint `--resume` will read.
 *
 * npx is recognised by two things it does together: npm marks the environment
 * `npm_command=exec`, and the script it starts sits in its `_npx` cache.
 * Neither alone is enough. `npm exec` from a project that depends on the CLI
 * sets the first and runs the project's own copy, and a global `traceroot`
 * started by some other npx-run tool inherits it too. Anything that is not both
 * keeps the bare command, byte for byte.
 */
export function setupCommand(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  version: () => string = getVersion,
): string {
  if (env.npm_command === "exec" && NPX_CACHE_SEGMENT.test(argv[1] ?? "")) {
    return `npx -y traceroot-cli@${version()} setup`;
  }
  return "traceroot setup";
}
