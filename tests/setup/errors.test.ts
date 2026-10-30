import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../../src/output.js";
import { SETUP_EXIT_CODES, type SetupErrorCode, SetupError } from "../../src/setup/errors.js";
import { runCli } from "../helpers/runCli.js";

/** The numbers the rest of the CLI has already spent, and what they mean there. */
const SHARED: ReadonlyMap<number, string> = new Map([
  [ExitCode.usage, "usage"],
  [ExitCode.auth, "auth"],
  [ExitCode.notFound, "not_found"],
  [ExitCode.network, "network"],
  [ExitCode.conflict, "conflict"],
]);

/**
 * Setup's own outcomes: the ones no other command can produce and the shared
 * table therefore has no word for.
 */
const OWN: readonly SetupErrorCode[] = [
  "AMBIGUOUS",
  "UNSUPPORTED",
  "AGENT_FAILED",
  "TRACE_TIMEOUT",
  "BACKEND_UNSUPPORTED",
  "UNSAFE_OVERWRITE",
];

describe("setup's exit codes against the table the whole CLI publishes", () => {
  it("reuses a shared number only where it means the same thing", () => {
    // The numbers are a published contract and they are not setup's to spend.
    // Numbered from 2 up, setup said `usage` for a run that was not logged in
    // and `network` for an agent that crashed — including in the `--json`
    // envelope, which derives its `code` string from the number, so a caller
    // branching on either was told about a failure that never happened.
    expect(SETUP_EXIT_CODES.NOT_AUTHENTICATED).toBe(ExitCode.auth);
    expect(SETUP_EXIT_CODES.UNEXPECTED).toBe(ExitCode.internal);
    for (const code of OWN) {
      expect(SHARED.get(SETUP_EXIT_CODES[code])).toBeUndefined();
    }
  });

  it("numbers its own outcomes above everything the shared table could claim", () => {
    // Above rather than around: the shared table owns the numbers below 10
    // whether or not it has used them yet, so a class added there later cannot
    // land on one of these.
    for (const code of OWN) {
      expect(SETUP_EXIT_CODES[code]).toBeGreaterThanOrEqual(10);
    }
  });

  it("leaves 13 unassigned", () => {
    // It was the failure of setup's own run of the project's checks. That run is
    // gone, and its number stays reserved rather than moving to a new outcome.
    expect(Object.values(SETUP_EXIT_CODES)).not.toContain(13);
  });

  it("separates a question answered no from a question never answered", () => {
    // Declining is a decision and exits 0. An interrupt is not an answer, and a
    // shell reads 130 as "ended by SIGINT" — which is what stops
    // `traceroot setup && <next step>` from running the next step over an
    // abandoned run.
    expect(SETUP_EXIT_CODES.CANCELLED).toBe(0);
    expect(SETUP_EXIT_CODES.INTERRUPTED).toBe(130);
  });

  it("hands the mapped status to the error the central handler sees", () => {
    const failed = new SetupError({
      stage: "instrument",
      code: "AGENT_FAILED",
      message: "the agent exited non-zero",
    });

    expect(failed.exitCode).toBe(SETUP_EXIT_CODES.AGENT_FAILED);
    expect(failed.exitCode).not.toBe(ExitCode.network);
  });
});

describe("publishing the statuses a script is told it can rely on", () => {
  /** The leading code column of every markdown table row in a file. */
  const tabulated = (markdown: string): number[] =>
    [...markdown.matchAll(/^\| `(\d+)` \|/gm)].map((row) => Number(row[1]));

  const own = OWN.map((code) => SETUP_EXIT_CODES[code]);

  it("gives each of setup's own statuses a row in the README's table", () => {
    // The mapping above calls itself a stable, script-facing contract, while
    // the one table a script author can read published 1-5 as though they were
    // everything any command could hand back — so a caller that met 14, or a
    // 130 from an abandoned prompt, had nothing to look it up in.
    const documented = tabulated(readFileSync(new URL("../../README.md", import.meta.url), "utf8"));

    for (const code of [...own, SETUP_EXIT_CODES.INTERRUPTED]) {
      expect(documented).toContain(code);
    }
  });

  it("says in `traceroot --help` that the shared six are not all of them", () => {
    const { stdout, status } = runCli("--help");
    // Only the appendix: the band is a claim about exit codes, and the word
    // would also match a command summary that happened to mention setup.
    const published = stdout.slice(stdout.indexOf("Exit codes:"));

    expect(status).toBe(0);
    expect(published).toContain("setup");
    // Derived, so a status added above cannot quietly fall outside the band
    // this advertises.
    expect(published).toContain(`${Math.min(...own)}-${Math.max(...own)}`);
    expect(published).toContain(String(SETUP_EXIT_CODES.INTERRUPTED));
  });
});
