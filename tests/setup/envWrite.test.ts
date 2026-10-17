import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_FILE_HEADER,
  chooseCredentialEnvFile,
  upsertEnvContent,
  upsertEnvFile,
} from "../../src/setup/envWrite.js";

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
  // POSIX only, as the config and credential tests are: win32 has no mode bits
  // for these assertions to be about.
  const posix = process.platform !== "win32";

  /** Runs `body` under `mask`, so a mode that only a permissive umask lets through is caught. */
  function underUmask<T>(mask: number, body: () => T): T {
    const previous = process.umask(mask);
    try {
      return body();
    } finally {
      process.umask(previous);
    }
  }

  it.runIf(posix)("creates a new file 0600", () => {
    // Nothing else has a claim on a file this run invented, and it holds a live key.
    const path = join(dir(), ".env");

    const result = upsertEnvFile(path, { TRACEROOT_API_KEY: "fresh" });

    expect(result).toEqual({ written: ["TRACEROOT_API_KEY"], created: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)("keeps the mode of the project's own file when it writes the key", () => {
    // A Compose service running as another uid reads `./.env` because git
    // checked it out readable. Tightening it to 0600 took every variable in it
    // away from that container, not only the key. Under a umask that would
    // narrow the replacement as well, so the mode has to be carried, not asked for.
    const path = join(dir(), ".env");
    writeFileSync(path, "DATABASE_URL=postgres://db\n", "utf8");
    chmodSync(path, 0o640);

    const result = underUmask(0o077, () => upsertEnvFile(path, { TRACEROOT_API_KEY: "fresh" }));

    expect(result).toEqual({ written: ["TRACEROOT_API_KEY"], created: false });
    expect(readFileSync(path, "utf8")).toContain("DATABASE_URL=postgres://db");
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it.runIf(posix)("takes the mode through a symlink from the file it points at", () => {
    // A link's own mode (0777 on Linux, 0755 on macOS) says nothing about who
    // may read the file; carried onto the replacement, it would leave the key
    // readable by everyone.
    const root = dir();
    const shared = join(root, "shared.env");
    writeFileSync(shared, "APP=1\n", "utf8");
    chmodSync(shared, 0o640);
    const path = join(root, ".env");
    symlinkSync(shared, path);

    upsertEnvFile(path, { TRACEROOT_API_KEY: "fresh" });

    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it.runIf(posix)("leaves an existing file's mode alone when there is nothing to write", () => {
    const path = join(dir(), ".env");
    writeFileSync(path, "TRACEROOT_API_KEY=same\n", "utf8");
    chmodSync(path, 0o644);

    const result = upsertEnvFile(path, { TRACEROOT_API_KEY: "same" });

    expect(result.written).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});

describe("choosing which of the project's env files the credential goes in", () => {
  it("prefers an existing .env.local over an existing .env", () => {
    // Not because `.env.local` is read more widely — `.env` is — but because
    // `.env` is the file the ecosystems that define both document as
    // committable. Writing a live key there would be refused by the caller's
    // tracked-file check and leave the user with nothing.
    const root = dir();
    writeFileSync(join(root, ".env"), "APP=1\n", "utf8");
    writeFileSync(join(root, ".env.local"), "SECRET=1\n", "utf8");

    expect(chooseCredentialEnvFile(root)).toEqual({ name: ".env.local", existed: true });
  });

  it("uses an existing .env when that is the only one there", () => {
    const root = dir();
    writeFileSync(join(root, ".env"), "APP=1\n", "utf8");

    expect(chooseCredentialEnvFile(root)).toEqual({ name: ".env", existed: true });
  });

  it("creates .env, never .env.local, when the project has neither", () => {
    // A name we invent has to be one the project's loader finds by default.
    // `python-dotenv`'s `load_dotenv()` searches for `.env` and no other name,
    // so conjuring a `.env.local` into a Python project would put the key back
    // in a file nothing reads.
    const root = dir();

    expect(chooseCredentialEnvFile(root)).toEqual({ name: ".env", existed: false });
  });
});

describe("the header on a credential file this run created", () => {
  it("does not tell the user the file can be deleted", () => {
    // True of a `.env.traceroot` only this tool read. False of the project's own
    // `.env`: deleting it now takes the application's configuration with it.
    const joined = ENV_FILE_HEADER.join(" ");

    expect(joined).toContain("Do not commit it");
    expect(joined).not.toContain("deleted");
  });

  it("goes on a file this run created and never on one the project had", () => {
    const created = upsertEnvContent(null, { TRACEROOT_API_KEY: "k" });
    const existing = upsertEnvContent("APP=1\n", { TRACEROOT_API_KEY: "k" });

    expect(created.content.startsWith(`${ENV_FILE_HEADER.join("\n")}\n`)).toBe(true);
    expect(existing.content).not.toContain(ENV_FILE_HEADER[0] ?? "");
    // And the user's own line survives untouched above ours.
    expect(existing.content).toBe("APP=1\n\nTRACEROOT_API_KEY=k\n");
  });
});
