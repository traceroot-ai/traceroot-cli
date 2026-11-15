import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { EVALS_RUN_EXIT_CODES, INTERRUPTED_EXIT_CODES } from "../../src/eval/exit-codes.js";
import { ExitCode } from "../../src/output.js";
import { SETUP_EXIT_CODES } from "../../src/setup/errors.js";
import { runCli } from "../helpers/runCli.js";

const own = Object.values(EVALS_RUN_EXIT_CODES);

describe("evals run's exit codes", () => {
  it("are 17 for a harness failure and 18 for a regression", () => {
    expect(EVALS_RUN_EXIT_CODES).toEqual({ harness: 17, regressed: 18 });
  });

  it("stay clear of the codes every command shares, which own everything below 10", () => {
    for (const code of own) {
      expect(code).toBeGreaterThanOrEqual(10);
      expect(Object.values(ExitCode)).not.toContain(code);
    }
  });

  it("continue after setup's own codes rather than reusing one", () => {
    const setupOwn = Object.values(SETUP_EXIT_CODES).filter((code) => code >= 10 && code < 128);
    for (const code of own) {
      expect(setupOwn).not.toContain(code);
    }
    expect(Math.min(...own)).toBe(Math.max(...setupOwn) + 1);
  });

  it("give an interrupted run the shell's status for the signal that interrupted it", () => {
    for (const [signal, code] of Object.entries(INTERRUPTED_EXIT_CODES)) {
      expect(code).toBe(128 + constants.signals[signal as keyof typeof constants.signals]);
    }
    expect(INTERRUPTED_EXIT_CODES.SIGINT).toBe(130);
  });
});

describe("publishing evals run's exit codes", () => {
  it("gives each of them a row in the README", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const tabulated = [...readme.matchAll(/^\| `(\d+)` \|/gm)].map((row) => Number(row[1]));

    for (const code of [...own, INTERRUPTED_EXIT_CODES.SIGINT]) {
      expect(tabulated).toContain(code);
    }
  });

  it("names them, and the command that returns them, in `traceroot --help`", () => {
    const { stdout, status } = runCli("--help");
    const published = stdout.slice(stdout.indexOf("Exit codes:"));

    expect(status).toBe(0);
    expect(published).toMatch(/^ {2}17 +harness +evals run: /m);
    expect(published).toMatch(/^ {2}18 +regressed +evals run: /m);
  });

  it("lists them in `traceroot evals run --help`", () => {
    const { stdout, status } = runCli("evals", "run", "--help");
    const published = stdout.slice(stdout.indexOf("Exit codes:"));

    expect(status).toBe(0);
    for (const code of [0, 2, 4, ...own, INTERRUPTED_EXIT_CODES.SIGINT]) {
      expect(published).toMatch(new RegExp(`^ {2}${code} `, "m"));
    }
  });
});
