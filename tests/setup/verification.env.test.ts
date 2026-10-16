import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunProcessResult } from "../../src/setup/exec.js";
import { makeSecret } from "../../src/setup/secret.js";
import { verifyApplication } from "../../src/setup/verify.js";

const KEY = "tr-a-long-enough-value";

const PROCESS_OK: RunProcessResult = {
  exitCode: 0,
  output: "",
  durationMs: 1,
  timedOut: false,
  spawnFailed: false,
};

/** Every root this file makes, so none is left in the system tmpdir. */
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

/** A project whose env file holds the credential among its own configuration. */
function projectEnv(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "traceroot-verify-env-"));
  roots.push(root);
  const file = join(root, ".env");
  writeFileSync(file, contents, "utf8");
  return file;
}

/**
 * A run that reports what the credential file looked like while it ran, which
 * is all the application can see of it.
 */
function watching(file: string): {
  run: () => Promise<RunProcessResult>;
  seen: string[];
} {
  const seen: string[] = [];
  const run = async (): Promise<RunProcessResult> => {
    seen.push(existsSync(file) ? readFileSync(file, "utf8") : "<the file was not there>");
    return PROCESS_OK;
  };
  return { run, seen };
}

/**
 * The mode the project's env file wears in the test below.
 *
 * Chosen to be a mode this machine's umask would strip from a freshly created
 * file, because that is what makes the assertion pin the `chmod` rather than
 * only the `writeFileSync`: the write's own `mode` is masked by the umask and
 * the `chmod` is not. The assertion itself is exact in every environment — the
 * stand-in wears the original's mode — and where no umask strips anything the
 * write would have been enough on its own, which is the one case the two are
 * the same thing.
 */
const PROJECT_MODE = 0o600 | (process.umask() & 0o077);

describe("what the credential-free run can still read", () => {
  it("takes out the credential and leaves the rest of the project's configuration", async () => {
    // The credential lives in the project's own `.env`, so that file is also
    // where the database URL lives. Moving the whole file aside ran the check
    // against an application with no configuration at all: it failed for
    // reasons that have nothing to do with TraceRoot, and the stage turned that
    // into "the application must keep working when TraceRoot is absent" and
    // stopped the run. Every project with a populated `.env` and a test command
    // is in that set.
    const file = projectEnv(
      `# project\nDATABASE_URL=postgres:///app\nTRACEROOT_API_KEY=${KEY}\nRETRIES=3\n`,
    );
    const { run, seen } = watching(file);

    const result = await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [file],
      interpreter: null,
      runProcess: run,
    });

    expect(result.verification.passed).toBe(true);
    // The run that is supposed to have the credential has it.
    expect(seen[0]).toContain(`TRACEROOT_API_KEY=${KEY}`);
    // The run that is supposed not to have it keeps everything else.
    expect(seen[1]).not.toContain("TRACEROOT_API_KEY");
    expect(seen[1]).toContain("DATABASE_URL=postgres:///app");
    expect(seen[1]).toContain("RETRIES=3");
    expect(seen[1]).toContain("# project");
    expect(result.withheld).toEqual([file]);
  });

  // Only the Windows skip is left: the mode no longer depends on the process
  // umask, because `park` follows its write with a `chmod`, which is not masked.
  it.skipIf(process.platform === "win32")(
    "stands in a file the project can read on the same terms as its own",
    async () => {
      // The file at that path has to look to the project like its own file minus
      // one line, permissions included: a check that reads the repository as
      // another uid can read a 0644 env file and cannot read a 0600 one, and
      // failing the credential-free run for that reason is the defect this
      // function exists to stop causing. Nothing is protected by tightening it
      // either — the copy that still holds the credential is the one the rename
      // moved aside, and a rename keeps the inode, so it sits at the user's own
      // mode for the whole window.
      const file = projectEnv(`DATABASE_URL=postgres:///app\nTRACEROOT_API_KEY=${KEY}\n`);
      chmodSync(file, PROJECT_MODE);
      const modes: number[] = [];
      const run = async (): Promise<RunProcessResult> => {
        modes.push(statSync(file).mode & 0o777);
        return PROCESS_OK;
      };

      await verifyApplication({
        command: "npm test",
        cwd: "/repo",
        parentEnv: {},
        credential: makeSecret(KEY),
        host: "https://api.example.test",
        credentialFiles: [file],
        interpreter: null,
        runProcess: run,
      });

      expect(modes).toEqual([PROJECT_MODE, PROJECT_MODE]);
      expect(statSync(file).mode & 0o777).toBe(PROJECT_MODE);
    },
  );

  it("puts the file back byte for byte, carriage returns and a missing final newline included", async () => {
    // The restore is a rename of a copy this code never parsed, which is the
    // only way to promise this: a file written back from what a reader
    // understood comes back normalised, and `envWrite.ts` already records that
    // a stripped carriage return in this file made a rerun append a second copy
    // of the key instead of replacing the first.
    const original = `# project\r\nDATABASE_URL=postgres:///app\r\nTRACEROOT_API_KEY=${KEY}\r\nRETRIES=3`;
    const file = projectEnv(original);
    const { run, seen } = watching(file);

    await verifyApplication({
      command: "npm test",
      cwd: "/repo",
      parentEnv: {},
      credential: makeSecret(KEY),
      host: "https://api.example.test",
      credentialFiles: [file],
      interpreter: null,
      runProcess: run,
    });

    expect(readFileSync(file, "utf8")).toBe(original);
    // And while the credential was out, the lines that stayed kept their own
    // endings — a dotenv parser reads `KEY=value\r` and not `KEY=value` with a
    // stray carriage return somewhere else.
    expect(seen[1]).toContain("DATABASE_URL=postgres:///app\r\n");
    expect(seen[1]).not.toContain("TRACEROOT_API_KEY");
  });
});
