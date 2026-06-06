/**
 * Writes a "not implemented" message for the given command to stderr and
 * exits the process with a non-zero status.
 *
 * Scaffold stub for the stdout/stderr contract (filled in by P2-2).
 */
export function notImplemented(command: string): never {
  process.stderr.write(`error: '${command}' is not implemented yet\n`);
  process.exit(1);
}
