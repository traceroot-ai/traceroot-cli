import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceArtifactDir } from "../../src/setup/artifacts.js";
import { newCheckpoint } from "../../src/setup/checkpoint.js";
import { runSetupMachine } from "../../src/setup/machine.js";
import type { SetupContext } from "../../src/setup/types.js";
import { plain } from "./colour.js";
import {
  authWithKey,
  defaultFlags,
  fakeApiClient,
  fakeRunProcess,
  makeDeps,
  makeWriters,
  traceRow,
} from "./helpers.js";

/**
 * The writer, made to keep the mode of a file the project already had.
 *
 * What mode the writer leaves is its own decision and not the stage's, and the
 * line under test has to report whichever it was. Pinning the writer to the one
 * that leaves an existing file alone is what lets a test see the line disagree
 * with a constant; a file this run creates is 0600 either way.
 */
vi.mock("../../src/setup/envWrite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/setup/envWrite.js")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    upsertEnvFile: (path: string, updates: Record<string, string>) => {
      const before = fs.existsSync(path) ? fs.statSync(path).mode & 0o777 : null;
      const result = actual.upsertEnvFile(path, updates);
      if (before !== null) {
        fs.chmodSync(path, before);
      }
      return result;
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-setup-env-mode-"));
  writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi","pytest"]\n');
  writeFileSync(join(dir, "main.py"), "print('hi')\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One run on a configured key, which writes the key into the project's env file. */
async function run(): Promise<string> {
  const deps = makeDeps({
    auth: authWithKey(),
    client: fakeApiClient({ traces: [traceRow()] }),
    runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
  });
  const { writers, err } = makeWriters();
  const ctx: SetupContext = {
    cwd: dir,
    root: dir,
    artifactDir: serviceArtifactDir({ root: dir, cwd: dir, service: undefined }),
    json: false,
    canPrompt: false,
    flags: defaultFlags({ agent: "claude" }),
    writers,
    checkpoint: newCheckpoint(new Date("2026-07-26T12:00:00.000Z")),
    emit: () => undefined,
    signal: new AbortController().signal,
    inGitRepo: false,
  };
  const result = await runSetupMachine(ctx, deps);
  expect(result.error).toBeNull();
  return plain(err.data);
}

describe("the line that reports writing the env file", () => {
  it("says 0600 for a file this run creates", async () => {
    const said = await run();

    expect(said).toContain("Created .env with TRACEROOT_API_KEY, TRACEROOT_HOST_URL (0600).");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("names the mode a project's own file kept, rather than claiming 0600", async () => {
    // It said 0600 whatever the file was, which is a protection a project's own
    // `.env` does not get when the writer leaves its mode alone.
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://x\n");
    chmodSync(join(dir, ".env"), 0o644);

    const said = await run();

    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o644);
    expect(said).toContain("Wrote TRACEROOT_API_KEY, TRACEROOT_HOST_URL to .env (0644).");
    expect(said).not.toContain("(0600)");
  });
});
