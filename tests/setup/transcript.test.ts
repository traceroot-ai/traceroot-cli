import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSecret } from "../../src/setup/secret.js";
import { AGENT_OUTPUT_PATH, writeAgentOutput } from "../../src/setup/transcript.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tr-transcript-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function written(): string | null {
  const path = join(root, AGENT_OUTPUT_PATH);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("writeAgentOutput", () => {
  it("writes the output and reports the path the remedy should name", () => {
    const path = writeAgentOutput({ root, output: "line one\nline two\n", secrets: [] });

    expect(path).toBe(AGENT_OUTPUT_PATH);
    expect(written()).toBe("line one\nline two\n");
  });

  it("creates the `.gitignore` that keeps it out of a commit", () => {
    // The transcript is the one setup artefact that quotes whatever the agent
    // happened to read out of the repository, so it must never be committable —
    // including on the run where nothing has written the checkpoint yet.
    writeAgentOutput({ root, output: "something\n", secrets: [] });

    expect(readFileSync(join(root, ".traceroot", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("leaves an existing `.gitignore` alone", () => {
    mkdirSync(join(root, ".traceroot"), { recursive: true });
    writeFileSync(join(root, ".traceroot", ".gitignore"), "# mine\n");

    writeAgentOutput({ root, output: "something\n", secrets: [] });

    expect(readFileSync(join(root, ".traceroot", ".gitignore"), "utf8")).toBe("# mine\n");
  });

  it("writes it unreadable to anyone else", () => {
    // Same discipline as the credential and the checkpoint next to it: a 0600
    // file in a 0700 directory.
    writeAgentOutput({ root, output: "something\n", secrets: [] });

    expect(statSync(join(root, AGENT_OUTPUT_PATH)).mode & 0o777).toBe(0o600);
  });

  it("redacts every secret it is given", () => {
    const key = "tr-secret-key-abcdef";

    writeAgentOutput({
      root,
      output: `exporting TRACEROOT_API_KEY=${key} for the suite\n`,
      secrets: [makeSecret(key)],
    });

    const content = written() ?? "";
    expect(content).not.toContain(key);
    expect(content).toContain("<redacted>");
  });

  it("writes nothing when the agent printed nothing", () => {
    // An agent that emitted no output has no evidence to offer, and a remedy
    // pointing at an empty file sends the reader somewhere worse than nowhere.
    expect(writeAgentOutput({ root, output: "   \n\n", secrets: [] })).toBeNull();
    expect(written()).toBeNull();
    expect(existsSync(join(root, ".traceroot"))).toBe(false);
  });

  it("ends the file with exactly one newline", () => {
    writeAgentOutput({ root, output: "no trailing newline", secrets: [] });

    expect(written()).toBe("no trailing newline\n");
  });

  it("overwrites the previous run's transcript", () => {
    // One stable path, because the remedy has to be able to name it and the
    // failure anyone is debugging is the one that just happened.
    writeAgentOutput({ root, output: "the first run\n", secrets: [] });
    writeAgentOutput({ root, output: "the second run\n", secrets: [] });

    expect(written()).toBe("the second run\n");
  });

  it("reports null rather than throwing when it cannot write", () => {
    // The caller is already throwing the failure this evidence belongs to, and
    // replacing that with a filesystem error would bury the cause.
    writeFileSync(join(root, ".traceroot"), "not a directory\n");

    expect(writeAgentOutput({ root, output: "something\n", secrets: [] })).toBeNull();
  });
});
