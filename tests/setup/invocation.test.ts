import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closingLine, runSetup } from "../../src/commands/setup/run.js";
import { buildDoctorReport } from "../../src/doctor/checks.js";
import { newCheckpoint } from "../../src/setup/checkpoint.js";
import { skippedTraceNotice } from "../../src/setup/ending.js";
import { cliCommand, setupCommand } from "../../src/setup/invocation.js";
import { getVersion } from "../../src/version.js";
import { plain } from "./colour.js";
import {
  authEmpty,
  authWithKey,
  defaultFlags,
  fakeRunProcess,
  makeContext,
  makeDeps,
  makeWriters,
} from "./helpers.js";

/** Where npx starts the CLI from: its own cache, through the `.bin` link. */
const NPX_SCRIPT = "/Users/u/.npm/_npx/6c3e1b2a9f0d4e17/node_modules/.bin/traceroot";
const NPX_SCRIPT_WINDOWS =
  "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\6c3e1b2a9f0d4e17\\node_modules\\traceroot-cli\\bin\\traceroot.mjs";
const GLOBAL_SCRIPT = "/usr/local/lib/node_modules/traceroot-cli/bin/traceroot.mjs";
const version = () => "0.6.1";

describe("the command a hint tells the user to run", () => {
  it("names the pinned package under npx, which puts no `traceroot` on PATH", () => {
    // The browser hands back `npx -y traceroot-cli@<version> setup`. A paused
    // run that then said `traceroot setup --resume` named a command the user's
    // shell did not have.
    for (const script of [NPX_SCRIPT, NPX_SCRIPT_WINDOWS]) {
      expect(setupCommand({ npm_command: "exec" }, ["node", script], version)).toBe(
        "npx -y traceroot-cli@0.6.1 setup",
      );
    }
  });

  it("keeps the bare command for a global install", () => {
    expect(setupCommand({}, ["node", GLOBAL_SCRIPT], version)).toBe("traceroot setup");
  });

  it("takes both of npx's marks to call a run npx's, not either one", () => {
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
      // `npm exec` from a project that depends on the CLI: its own copy.
      [{ npm_command: "exec" }, "/repo/node_modules/.bin/traceroot"],
      // A global install started by some other npx-run tool inherits the mark.
      [{ npm_command: "exec" }, GLOBAL_SCRIPT],
      // In the cache, but started some other way.
      [{}, NPX_SCRIPT],
      [{ npm_command: "run-script" }, NPX_SCRIPT],
      // A directory merely named like the cache.
      [{ npm_command: "exec" }, "/home/u/my_npx/traceroot"],
    ];
    for (const [env, script] of cases) {
      expect(setupCommand(env, ["node", script], version), script).toBe("traceroot setup");
    }
  });

  it("spells the other commands a hint names the same way", () => {
    // `login`, `traces list` and `skills install` were written out by hand as
    // `traceroot …`, which under npx is the same missing command.
    expect(
      cliCommand("traces list --limit 5", { npm_command: "exec" }, ["node", NPX_SCRIPT], version),
    ).toBe("npx -y traceroot-cli@0.6.1 traces list --limit 5");
    expect(cliCommand("login", {}, ["node", GLOBAL_SCRIPT], version)).toBe("traceroot login");
    expect(cliCommand("login", { npm_command: "exec" }, ["node", GLOBAL_SCRIPT], version)).toBe(
      "traceroot login",
    );
  });

  it("pins the version that is running", () => {
    // That version wrote the checkpoint `--resume` reads, so the hint must not
    // let npx fetch whichever one is latest.
    expect(setupCommand({ npm_command: "exec" }, ["node", NPX_SCRIPT])).toBe(
      `npx -y traceroot-cli@${getVersion()} setup`,
    );
  });
});

describe("the hints a run prints, for the way it was started", () => {
  let dir: string;
  let saved: { script: string | undefined; npmCommand: string | undefined };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tr-setup-invocation-"));
    saved = { script: process.argv[1], npmCommand: process.env.npm_command };
  });

  afterEach(() => {
    process.argv[1] = saved.script as string;
    if (saved.npmCommand === undefined) {
      // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
      delete process.env.npm_command;
    } else {
      process.env.npm_command = saved.npmCommand;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** This process, as though npm had started it the given way. */
  function startedAs(script: string, npmCommand: string | undefined): void {
    process.argv[1] = script;
    if (npmCommand === undefined) {
      // biome-ignore lint/performance/noDelete: an unset env var, not the string "undefined"
      delete process.env.npm_command;
    } else {
      process.env.npm_command = npmCommand;
    }
  }

  /** A run that stops before any network call: no credential, nobody to ask. */
  async function unauthenticatedRemedy(): Promise<string | null | undefined> {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    const result = await runSetup({
      ctx: { ...makeContext(), auth: authEmpty() },
      cwd: dir,
      flags: defaultFlags({ agent: "claude" }),
      writers: makeWriters().writers,
      canPrompt: false,
      setupDeps: makeDeps({ auth: authEmpty() }),
    });
    expect(result.error?.code).toBe("NOT_AUTHENTICATED");
    return result.error?.remedy;
  }

  const paused = {
    ok: true,
    trace: null,
    stagesRun: [],
    checkpoint: newCheckpoint(new Date()),
    error: null,
  };

  it("tell a run npx started to go on with npx", async () => {
    startedAs(NPX_SCRIPT, "exec");
    const npx = `npx -y traceroot-cli@${getVersion()} setup`;

    expect(closingLine(paused)).toBe(`Setup paused — rerun \`${npx} --resume\` to finish.`);
    expect(await unauthenticatedRemedy()).toContain(`\n  ${npx} --api-key <key>\n`);
  });

  it("send a run npx started to the other commands with npx as well", async () => {
    startedAs(NPX_SCRIPT, "exec");
    const npx = `npx -y traceroot-cli@${getVersion()}`;

    expect(await unauthenticatedRemedy()).toContain(`or run \`${npx} login\` first.`);
    // After a wait the user ended themselves.
    expect(skippedTraceNotice({ uiBaseUrl: null }).map(plain)).toContain(
      `  ${npx} traces list --limit 5`,
    );
  });

  it("offer the terminal check with npx when no trace arrived in time", async () => {
    startedAs(NPX_SCRIPT, "exec");
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["pytest"]\n');
    writeFileSync(join(dir, "main.py"), "print('hi')\n");
    const timedOut = await runSetup({
      ctx: makeContext(),
      cwd: dir,
      flags: defaultFlags({ agent: "claude", traceTimeoutSec: 1 }),
      writers: makeWriters().writers,
      canPrompt: false,
      setupDeps: makeDeps({
        auth: authWithKey(),
        traces: [],
        runProcess: fakeRunProcess({ gitStatus: ["", " M main.py"] }).run,
      }),
    });
    expect(timedOut.error?.code).toBe("TRACE_TIMEOUT");
    expect(timedOut.error?.remedy?.split("\n")).toContain(
      `  npx -y traceroot-cli@${getVersion()} traces list --limit 5`,
    );
  });

  it("give setup doctor's remedies with npx when npx started it", () => {
    startedAs(NPX_SCRIPT, "exec");
    const npx = `npx -y traceroot-cli@${getVersion()}`;
    // Hermetic: the skill check reads Codex's global skills directory.
    vi.stubEnv("CODEX_HOME", join(dir, "codex-home"));
    try {
      const report = buildDoctorReport({
        cwd: dir,
        auth: { ...authEmpty(), hostUrl: { value: undefined, source: "none" } },
        credentialsValid: null,
        configPath: join(dir, ".traceroot", "config.json"),
        detection: {
          root: dir,
          hasPackageJson: false,
          hasPyprojectToml: true,
          hasRequirementsTxt: false,
          hasTsconfigJson: false,
          likelyLanguages: ["python"],
        },
        env: {},
        includeSetup: true,
      });
      const message = (name: string) => report.checks.find((c) => c.name === name)?.message;

      expect(message("credentials_resolved")).toBe(`No credentials found. Run \`${npx} login\`.`);
      expect(message("host_resolved")).toBe(`Host not found. Run \`${npx} login\`.`);
      expect(message("skill_instrument")).toBe(
        `Instrumentation skill not installed. Run \`${npx} skills install traceroot-instrument-repo\``,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("are byte for byte what they were for a global install", async () => {
    startedAs(GLOBAL_SCRIPT, undefined);

    expect(closingLine(paused)).toBe("Setup paused — rerun `traceroot setup --resume` to finish.");
    expect(await unauthenticatedRemedy()).toBe(
      [
        "Provide a key non-interactively:",
        "  traceroot setup --api-key <key>",
        "or set TRACEROOT_API_KEY, or run `traceroot login` first.",
      ].join("\n"),
    );
  });
});
