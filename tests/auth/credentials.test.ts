import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialsPath,
  deleteCredential,
  readCredential,
  writeCredential,
} from "../../src/auth/credentials.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-creds-"));
  file = join(dir, "credentials.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("credentialsPath", () => {
  it("prefers TRACEROOT_CREDENTIALS_PATH", () => {
    expect(credentialsPath({ TRACEROOT_CREDENTIALS_PATH: "/x/creds.json" })).toBe("/x/creds.json");
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "traceroot", "credentials.json"),
    );
  });

  it("falls back to ~/.config", () => {
    expect(credentialsPath({})).toBe(join(homedir(), ".config", "traceroot", "credentials.json"));
  });
});

describe("write/read/delete round-trip", () => {
  it("stores entries keyed by host and reads them back", () => {
    writeCredential("https://a", { session_token: "tok-a" }, file);
    writeCredential("https://b", { session_token: "tok-b", auth_host: "https://ui" }, file);

    expect(readCredential("https://a", file)).toEqual({ session_token: "tok-a" });
    expect(readCredential("https://b", file)).toEqual({
      session_token: "tok-b",
      auth_host: "https://ui",
    });
    expect(readCredential("https://c", file)).toBeNull();
  });

  it("normalizes trailing slashes in the host key", () => {
    writeCredential("https://a///", { session_token: "tok-a" }, file);
    expect(readCredential("https://a", file)).toEqual({ session_token: "tok-a" });
    expect(readCredential("https://a/", file)).toEqual({ session_token: "tok-a" });
  });

  it("writes the file with 0600 permissions", () => {
    writeCredential("https://a", { session_token: "tok-a" }, file);
    // POSIX permission bits are best-effort on win32 (writeFileSecure swallows
    // the chmod there), so only assert the exact mode where it's enforceable.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } else {
      expect(statSync(file).isFile()).toBe(true);
    }
  });

  it("preserves an incompatible store (future version) instead of rewriting it as v1", () => {
    const incompatible = JSON.stringify({ version: 2, hosts: { "https://x": { opaque: true } } });
    writeFileSync(file, incompatible);
    // Unreadable by this version → absent...
    expect(readCredential("https://x", file)).toBeNull();
    // ...and a write sidelines it as .corrupt rather than dropping its content.
    writeCredential("https://a", { session_token: "tok-a" }, file);
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(incompatible);
    expect(readCredential("https://a", file)).toEqual({ session_token: "tok-a" });
  });

  it("treats an array hosts field as corrupt, not as an empty store", () => {
    writeFileSync(file, JSON.stringify({ version: 1, hosts: [] }));
    expect(readCredential("https://a", file)).toBeNull();
    writeCredential("https://a", { session_token: "tok-a" }, file);
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(JSON.stringify({ version: 1, hosts: [] }));
  });

  it("treats a corrupt file as absent and recovers on write", () => {
    writeFileSync(file, "{ not json");
    expect(readCredential("https://a", file)).toBeNull();

    writeCredential("https://a", { session_token: "tok-a" }, file);
    expect(readCredential("https://a", file)).toEqual({ session_token: "tok-a" });
  });

  it("rejects an entry whose optional fields are not strings", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hosts: { "https://a": { session_token: "tok", auth_host: 42 } },
      }),
    );
    expect(readCredential("https://a", file)).toBeNull();
  });

  it("treats a store with one malformed entry as corrupt — a rewrite must not silently drop it", () => {
    const mixed = JSON.stringify({
      version: 1,
      hosts: {
        "https://good": { session_token: "tok-good" },
        "https://bad": { session_token: "tok-bad", auth_host: 42 },
      },
    });
    writeFileSync(file, mixed);
    // Unreadable as a whole (never "just the good entries")...
    expect(readCredential("https://good", file)).toBeNull();
    // ...delete has nothing to rewrite...
    expect(deleteCredential("https://good", file)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(mixed);
    // ...and a write preserves the whole original as the sidecar.
    writeCredential("https://c", { session_token: "tok-c" }, file);
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(mixed);
  });

  it("sidelines an unreadable-but-existing store instead of replacing it", () => {
    // chmod 000 has no effect on win32 or when running as root.
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }
    const original = JSON.stringify({
      version: 1,
      hosts: { "https://x": { session_token: "keep" } },
    });
    writeFileSync(file, original);
    chmodSync(file, 0o000);
    try {
      writeCredential("https://a", { session_token: "tok-a" }, file);
    } finally {
      // Restore for cleanup regardless of outcome.
      for (const p of [file, `${file}.corrupt`]) {
        try {
          chmodSync(p, 0o600);
        } catch {}
      }
    }
    // The unreadable file was preserved as the sidecar, not erased.
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(original);
    expect(readCredential("https://a", file)).toEqual({ session_token: "tok-a" });
  });

  it("preserves a corrupt store as a .corrupt sidecar instead of silently wiping it", () => {
    // A corrupt file could hold other hosts' credentials; a write must not
    // destroy them outright.
    writeFileSync(file, '{ "hosts": OOPS not json');
    writeCredential("https://a", { session_token: "tok-a" }, file);
    expect(readFileSync(`${file}.corrupt`, "utf8")).toContain("OOPS");
    expect(readCredential("https://a", file)).toEqual({ session_token: "tok-a" });
  });

  it("treats a wrong-shape file as absent", () => {
    writeFileSync(file, JSON.stringify({ hosts: "nope" }));
    expect(readCredential("https://a", file)).toBeNull();
  });

  it("deletes only the requested host entry", () => {
    writeCredential("https://a", { session_token: "tok-a" }, file);
    writeCredential("https://b", { session_token: "tok-b" }, file);

    expect(deleteCredential("https://a", file)).toBe(true);
    expect(readCredential("https://a", file)).toBeNull();
    expect(readCredential("https://b", file)).toEqual({ session_token: "tok-b" });
  });

  it("delete returns false when nothing is stored", () => {
    expect(deleteCredential("https://a", file)).toBe(false);
  });

  it("never embeds the token in a write failure", () => {
    // Target path whose parent is a regular file → mkdir/rename must fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const bad = join(blocker, "credentials.json");
    let thrown: unknown;
    try {
      writeCredential("https://a", { session_token: "tok-SECRET" }, bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).not.toContain("tok-SECRET");
  });
});
