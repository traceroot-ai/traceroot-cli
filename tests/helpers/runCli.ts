import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const binPath = fileURLToPath(new URL("../../bin/traceroot.mjs", import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export function runCli(...args: string[]): CliResult {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
