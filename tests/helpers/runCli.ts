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
  // Also isolate every non-cwd credential source (mirroring
  // tests/output.contract.test.ts): the project config override, the global
  // config fallback under XDG_CONFIG_HOME/homedir, and ambient env
  // credentials. Otherwise a real ~/.config/traceroot/config.json (or exported
  // TRACEROOT_* vars) would resolve credentials and turn these hermetic spawn
  // tests into live network calls. The rest of process.env (PATH etc.) is kept.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRACEROOT_CONFIG_PATH: join(cwd, "no-such-config", "config.json"),
    XDG_CONFIG_HOME: join(cwd, "no-such-config-home"),
    TRACEROOT_API_KEY: "",
    TRACEROOT_HOST_URL: "",
  };
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    cwd,
    env,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
