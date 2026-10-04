import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureIgnored, upsertEnvContent, upsertEnvFile } from "../../src/setup/envWrite.js";

/** Every root this file makes, so none is left behind in the system tmpdir. */
const roots: string[] = [];

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "traceroot-env-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("rewriting a key that appears more than once", () => {
  it("replaces every occurrence, because the reader takes the last", () => {
    // `config/envFile.ts` documents "on duplicate keys, the last occurrence
    // wins", as do dotenv and `node --env-file`. Rewriting only the first turned
    // a rotation into KEY=new followed by KEY=stale and reported success, while
    // the application went on using the old credential.
    const { content, written } = upsertEnvContent(
      "TRACEROOT_API_KEY=old\nOTHER=1\nTRACEROOT_API_KEY=older\n",
      { TRACEROOT_API_KEY: "fresh" },
    );

    expect(content).not.toContain("old");
    expect(content.match(/TRACEROOT_API_KEY=fresh/g)).toHaveLength(2);
    // Reported once, so the ordinary single-occurrence file is unchanged.
    expect(written).toEqual(["TRACEROOT_API_KEY"]);
  });

  it("replaces the existing line in a CRLF file rather than appending under it", () => {
    // `.` does not match `\r`, so a CRLF file matched no line at all: the new
    // value was appended beneath the old one, and the superseded credential
    // stayed on disk where `removeEnvKeys` could not reach it.
    const { content, written } = upsertEnvContent("TRACEROOT_API_KEY=old\r\n", {
      TRACEROOT_API_KEY: "fresh",
    });

    expect(written).toEqual(["TRACEROOT_API_KEY"]);
    expect(content).not.toContain("old");
    expect(content.match(/TRACEROOT_API_KEY=/g)).toHaveLength(1);
  });
});

describe("the file's permissions", () => {
  it("tightens a loose mode even when the value is already correct", () => {
    // Nothing to write is not nothing to fix: the file holds a live key, and the
    // mode is part of what this function promises.
    const root = dir();
    const path = join(root, ".env.traceroot");
    writeFileSync(path, "TRACEROOT_API_KEY=same\n", "utf8");
    chmodSync(path, 0o644);

    const result = upsertEnvFile(path, { TRACEROOT_API_KEY: "same" });

    expect(result.written).toEqual([]);
    // Hard-assert the mode on POSIX only, as the config and credential tests do:
    // `chmodSync` is best-effort on win32 and `upsertEnvFile` swallows its errors,
    // so the file's existence is all that can be claimed there.
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } else {
      expect(statSync(path).isFile()).toBe(true);
    }
  });
});

describe("deciding whether git already ignores the credential", () => {
  it("honours a later re-include instead of stopping at the first match", () => {
    // Last match wins, as git itself does. Returning true on the first positive
    // rule reported the file as ignored when a `!` line put it back — the one
    // error here that ends with a credential in a commit.
    const root = dir();
    writeFileSync(join(root, ".gitignore"), ".env.traceroot\n!.env.traceroot\n", "utf8");

    expect(ensureIgnored(root, "api/.env.traceroot")).toBe("appended");
  });

  it("still recognises a genuine ignore rule", () => {
    const root = dir();
    writeFileSync(join(root, ".gitignore"), ".env.traceroot\n", "utf8");

    expect(ensureIgnored(root, "api/.env.traceroot")).toBe("already");
  });
});
