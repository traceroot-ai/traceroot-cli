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
  // `.env` and leaks credentials into otherwise-hermetic spawn tests. The
  // credentials file is pointed into the same empty directory, and the ambient
  // credential env vars are blanked, so a developer's real session login or
  // exported key/token can't leak in either (a leaked TRACEROOT_TOKEN would
  // mint a live JWT over the network mid-test).
  const cwd = mkdtempSync(join(tmpdir(), "traceroot-cli-"));
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      TRACEROOT_CREDENTIALS_PATH: join(cwd, "credentials.json"),
      TRACEROOT_TOKEN: "",
      TRACEROOT_API_KEY: "",
      TRACEROOT_HOST_URL: "",
      TRACEROOT_AUTH_URL: "",
      TRACEROOT_PROJECT_ID: "",
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
