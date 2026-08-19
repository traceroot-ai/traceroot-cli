import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("treats a corrupt file as absent and recovers on write", () => {
    writeFileSync(file, "{ not json");
    expect(readCredential("https://a", file)).toBeNull();

    writeCredential("https://a", { session_token: "tok-a" }, file);
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
