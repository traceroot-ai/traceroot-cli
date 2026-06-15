import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const binPath = fileURLToPath(new URL("../../bin/traceroot.mjs", import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export function runCli(...args: string[]): CliResult {
  // Spawn in a fresh empty directory so the CLI's auto-discovered `.env`
  // (a lowest-precedence credential source) never picks up the repo's own
  // `.env` and leaks credentials into otherwise-hermetic spawn tests.
  const cwd = mkdtempSync(join(tmpdir(), "traceroot-cli-"));
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    cwd,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
