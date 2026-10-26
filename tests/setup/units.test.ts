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
import {
  clearCheckpoint,
  hasCompleted,
  markComplete,
  newCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from "../../src/setup/checkpoint.js";
import { removeEnvKeys, upsertEnvContent, upsertEnvFile } from "../../src/setup/envWrite.js";
import { SETUP_EXIT_CODES, SetupError } from "../../src/setup/errors.js";
import { changedSince, parsePorcelain } from "../../src/setup/git.js";
import { buildAgentEnv, buildInvocation } from "../../src/setup/launch.js";
import { renderSetupReport } from "../../src/setup/report.js";
import { installCommand, resolveSdkVersion, sdkPackageFor } from "../../src/setup/sdk.js";
import { makeSecret, redact, secretHint } from "../../src/setup/secret.js";
import { detectStack } from "../../src/setup/stack.js";
import { afterEchoedTask, buildSetupTask, parseCompletion } from "../../src/setup/task.js";
import type { DetectedService } from "../../src/setup/types.js";
import { TEST_SDK, codexCapture } from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-setup-unit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const target = join(dir, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

describe("Secret", () => {
  it("refuses to serialize", () => {
    const secret = makeSecret("tr-super-secret-value");
    expect(() => JSON.stringify({ secret })).toThrow(/refusing to serialize/);
  });

  it("exposes only a short hint", () => {
    const value = "tr-abcdefghijklmnop";
    const hint = secretHint(value);
    expect(hint).toBe("tr-…mnop");
    expect(value).not.toContain(hint);
  });

  it("masks short values entirely", () => {
    expect(secretHint("short")).toBe("…");
  });

  it("redacts a secret from arbitrary text", () => {
    const secret = makeSecret("tr-abcdefghijklmnop");
    expect(redact("key is tr-abcdefghijklmnop here", [secret])).toBe("key is <redacted> here");
  });
});

describe("checkpoint", () => {
  it("round-trips through disk", () => {
    const checkpoint = newCheckpoint(new Date("2026-07-26T12:00:00.000Z"));
    checkpoint.projectName = "demo";
    markComplete(checkpoint, "authenticate");
    writeCheckpoint(dir, checkpoint);

    const read = readCheckpoint(dir);
    expect(read?.projectName).toBe("demo");
    expect(read === null ? false : hasCompleted(read, "authenticate")).toBe(true);
  });

  it("returns null for corrupt JSON rather than throwing", () => {
    mkdirSync(join(dir, ".traceroot"), { recursive: true });
    writeFileSync(join(dir, ".traceroot", "setup.json"), "{ not json", "utf8");
    expect(readCheckpoint(dir)).toBeNull();
  });

  it("drops unknown stages and unknown fields", () => {
    mkdirSync(join(dir, ".traceroot"), { recursive: true });
    writeFileSync(
      join(dir, ".traceroot", "setup.json"),
      JSON.stringify({
        version: 1,
        startedAt: "2026-07-26T12:00:00.000Z",
        completedStages: ["authenticate", "teleport"],
        somethingNew: "ignored",
        apiKey: "tr-should-never-be-honoured",
      }),
      "utf8",
    );
    const read = readCheckpoint(dir);
    expect(read?.completedStages).toEqual(["authenticate"]);
    expect(JSON.stringify(read)).not.toContain("tr-should-never-be-honoured");
  });

  it("keeps stages in pipeline order regardless of insertion order", () => {
    const checkpoint = newCheckpoint();
    markComplete(checkpoint, "verify_trace");
    markComplete(checkpoint, "precheck");
    markComplete(checkpoint, "precheck");
    expect(checkpoint.completedStages).toEqual(["precheck", "verify_trace"]);
  });

  it("clears cleanly", () => {
    writeCheckpoint(dir, newCheckpoint());
    clearCheckpoint(dir);
    expect(readCheckpoint(dir)).toBeNull();
  });

  it("writes a gitignore beside itself so it can never be committed", () => {
    writeCheckpoint(dir, newCheckpoint());
    expect(readFileSync(join(dir, ".traceroot", ".gitignore"), "utf8")).toBe("*\n");
  });
});

describe("SetupError", () => {
  it("maps every code to its documented exit status", () => {
    // 14, not 7: setup's own statuses start above the shared table's, so that a
    // caller reading `$?` cannot mistake one of them for `usage` or `auth`. The
    // literal stays here, in the one place that pins the published number; the
    // assertion below only has to agree with it.
    expect(SETUP_EXIT_CODES.TRACE_TIMEOUT).toBe(14);
    const err = new SetupError({
      stage: "verify_trace",
      code: "TRACE_TIMEOUT",
      message: "no trace",
      remedy: "run the app",
    });
    expect(err.exitCode).toBe(SETUP_EXIT_CODES.TRACE_TIMEOUT);
    expect(err.message).toContain("no trace");
    expect(err.message).toContain("run the app");
  });
});

describe("env file writing", () => {
  it("preserves comments and ordering while replacing in place", () => {
    const existing = "# leading comment\nFOO=1\nTRACEROOT_API_KEY=old\nBAR=2\n";
    const { content, written } = upsertEnvContent(existing, { TRACEROOT_API_KEY: "new" });
    expect(written).toEqual(["TRACEROOT_API_KEY"]);
    expect(content).toBe("# leading comment\nFOO=1\nTRACEROOT_API_KEY=new\nBAR=2\n");
  });

  it("does not write when the value already matches", () => {
    const { written } = upsertEnvContent("TRACEROOT_API_KEY=same\n", {
      TRACEROOT_API_KEY: "same",
    });
    expect(written).toEqual([]);
  });

  it("treats a quoted existing value as equal to its unquoted form", () => {
    const { written } = upsertEnvContent('TRACEROOT_API_KEY="same"\n', {
      TRACEROOT_API_KEY: "same",
    });
    expect(written).toEqual([]);
  });

  it("appends missing keys after a blank line", () => {
    const { content } = upsertEnvContent("FOO=1\n", { TRACEROOT_API_KEY: "k" });
    expect(content).toBe("FOO=1\n\nTRACEROOT_API_KEY=k\n");
  });

  it("writes with 0600 permissions", () => {
    const path = join(dir, ".env");
    upsertEnvFile(path, { TRACEROOT_API_KEY: "k" });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path, "utf8")).toContain("TRACEROOT_API_KEY=k");
  });

  it("removes only the named keys", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "# keep\nFOO=1\nTRACEROOT_API_KEY=k\n", "utf8");
    expect(removeEnvKeys(path, ["TRACEROOT_API_KEY"])).toEqual(["TRACEROOT_API_KEY"]);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("# keep");
    expect(after).toContain("FOO=1");
    expect(after).not.toContain("TRACEROOT_API_KEY");
  });

  it("leaves the user's .gitignore alone", () => {
    // This module used to append a rule here. It no longer edits the file at
    // all: `git check-ignore` answers the question, and acting on the answer is
    // the user's. See `isPathIgnored` in `git.ts` and `warnIfNotIgnored` in
    // `machine.ts`.
    upsertEnvFile(join(dir, ".env"), { TRACEROOT_API_KEY: "k" });

    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});

describe("git helpers", () => {
  it("parses porcelain output including renames", () => {
    // `-z`: NUL-delimited, and a rename is two records (new path, then old)
    // rather than one joined with a " -> " that a filename may itself contain.
    const NUL = String.fromCharCode(0);
    expect(
      parsePorcelain(` M src/app.ts${NUL}?? new.txt${NUL}R  new.ts${NUL}old.ts${NUL}`),
    ).toEqual(["new.ts", "new.txt", "src/app.ts"]);
  });

  it("reports only files that appeared after the baseline", () => {
    expect(changedSince(["a.ts"], ["a.ts", "b.ts"])).toEqual(["b.ts"]);
  });
});

describe("stack detection", () => {
  it("finds a single Python service at the root", () => {
    write("pyproject.toml", '[project]\ndependencies = ["fastapi"]\n');
    write("main.py", "print('hi')\n");
    const stack = detectStack(dir);
    expect(stack.ambiguous).toBe(false);
    expect(stack.selected?.language).toBe("python");
    expect(stack.selected?.framework).toBe("fastapi");
    expect(stack.selected?.entryPoint).toBe("main.py");
  });

  it("accepts a directory the user named, once they also name the language", () => {
    // `--service` plus `--language` is the user answering both questions.
    // Without the language there is nothing to guess from, and guessing from
    // file extensions is exactly what detection refuses to do.
    write("error.py", "import openai\n");
    expect(detectStack(dir, { service: "." }).selected).toBeNull();

    const stack = detectStack(dir, { service: ".", language: "python" });
    expect(stack.selected?.path).toBe(".");
    expect(stack.selected?.language).toBe("python");
    // Flagged so the agent knows it must find the real service.
    expect(stack.selected?.agentMustIdentify).toBe(true);
  });

  it("will not settle the language on the user's behalf", () => {
    // The SDK, install command and init snippet all differ by language, so
    // this is a question, not a coin flip.
    write("a.py", "import openai\n");
    write("b.ts", "export const x = 1;\n");
    expect(detectStack(dir, { service: "." }).selected).toBeNull();
    expect(detectStack(dir, { service: ".", language: "python" }).selected?.language).toBe(
      "python",
    );
  });

  it("still finds nothing to select without an explicit --service", () => {
    // Loose scripts alone must not produce a service; that is exactly the
    // inference detection refuses to make.
    write("error.py", "import openai\n");
    expect(detectStack(dir).services).toEqual([]);
  });

  it("finds a single TypeScript service and its test command", () => {
    write(
      "package.json",
      JSON.stringify({ scripts: { test: "vitest" }, dependencies: { express: "^4" } }),
    );
    write("tsconfig.json", "{}");
    write("pnpm-lock.yaml", "");
    const stack = detectStack(dir);
    expect(stack.selected?.language).toBe("typescript");
    expect(stack.selected?.framework).toBe("express");
    expect(stack.selected?.testCommand).toBe("pnpm test");
  });

  it("refuses to guess in a polyglot repository", () => {
    write("apps/api/pyproject.toml", "[project]\n");
    write("apps/web/package.json", JSON.stringify({ dependencies: { next: "^14" } }));
    const stack = detectStack(dir);
    expect(stack.ambiguous).toBe(true);
    expect(stack.selected).toBeNull();
    expect(stack.services.map((s) => s.path).sort()).toEqual(["apps/api", "apps/web"]);
  });

  it("is disambiguated by --language", () => {
    write("apps/api/pyproject.toml", "[project]\n");
    write("apps/web/package.json", JSON.stringify({ dependencies: { next: "^14" } }));
    const stack = detectStack(dir, { language: "python" });
    expect(stack.ambiguous).toBe(false);
    expect(stack.selected?.path).toBe("apps/api");
  });

  it("is disambiguated by --service", () => {
    write("apps/api/pyproject.toml", "[project]\n");
    write("apps/web/package.json", JSON.stringify({ dependencies: { next: "^14" } }));
    expect(detectStack(dir, { service: "apps/web" }).selected?.path).toBe("apps/web");
  });

  it("does not treat an empty stub package.json as a service", () => {
    // Observed live: a repository root carrying `{}` was detected as a
    // JavaScript service, so setup instrumented the top of a monorepo.
    write("package.json", "{}");
    const stack = detectStack(dir);
    expect(stack.services).toEqual([]);
    expect(stack.selected).toBeNull();
  });

  it("does not treat a pure workspace-root manifest as a service", () => {
    write("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    expect(detectStack(dir).services).toEqual([]);
  });

  it("still detects a repo that is BOTH a workspace root and an app", () => {
    // A CLI that extracted sub-packages is a real application, not a container.
    write(
      "package.json",
      JSON.stringify({
        name: "cli",
        workspaces: ["packages/*"],
        bin: { thing: "bin/thing.mjs" },
        dependencies: { commander: "^12" },
      }),
    );
    expect(detectStack(dir).selected?.path).toBe(".");
  });

  it("finds sibling projects in top-level directories, not just apps/ and packages/", () => {
    // A real repository shape: projects sitting directly at the top of the
    // repo, under names no hardcoded list would guess.
    write("package.json", "{}");
    write("traceroot-cli/package.json", JSON.stringify({ dependencies: { commander: "^12" } }));
    write("traceroot-py/pyproject.toml", "[project]\n");
    const stack = detectStack(dir);
    expect(stack.ambiguous).toBe(true);
    expect(stack.services.map((s) => s.path).sort()).toEqual(["traceroot-cli", "traceroot-py"]);
  });

  it("still selects a genuine single root application", () => {
    write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    write("index.js", "module.exports = {};");
    expect(detectStack(dir).selected?.path).toBe(".");
  });

  it("reports an unsupported language instead of finding nothing", () => {
    write("go.mod", "module example.com/x\n");
    const stack = detectStack(dir);
    expect(stack.services).toEqual([]);
    expect(stack.unsupportedLanguages).toEqual(["Go"]);
  });

  it("never picks a build artifact as the entry point", () => {
    // Observed live: `"main": "dist/cli.js"` made the agent target compiled
    // output that the next build overwrites.
    write("package.json", JSON.stringify({ main: "dist/cli.js", scripts: { test: "vitest" } }));
    write("dist/cli.js", "// compiled");
    write("src/index.ts", "export const x = 1;");
    expect(detectStack(dir).selected?.entryPoint).toBe("src/index.ts");
  });

  it("keeps a published entry point that is real source", () => {
    write("package.json", JSON.stringify({ main: "server.js", dependencies: { express: "^4" } }));
    write("server.js", "// real");
    expect(detectStack(dir).selected?.entryPoint).toBe("server.js");
  });

  it("does not mine a compiled bundle for existing instrumentation", () => {
    // A bundle names everything it imported; in a repo called "traceroot" that
    // match is guaranteed and always wrong.
    write(
      "package.json",
      JSON.stringify({ main: "dist/cli.js", dependencies: { commander: "^12" } }),
    );
    write("dist/cli.js", "traceroot traceroot traceroot");
    const stack = detectStack(dir);
    expect(stack.existingInstrumentation.evidence.join(" ")).not.toContain("dist/cli.js");
  });

  it("does not call a declared dependency 'already instrumented'", () => {
    // This told the coding agent the work was done, and it wrote nothing —
    // which is what happens in any repository that depends on TraceRoot for
    // other reasons, or one named after it. The dependency is still reported
    // as context; it just is not proof.
    write("package.json", JSON.stringify({ dependencies: { "@traceroot-ai/traceroot": "^1" } }));
    write("index.js", "console.log('no tracing here');\n");
    const stack = detectStack(dir);

    expect(stack.existingInstrumentation.present).toBe(false);
    expect(stack.existingInstrumentation.evidence.join(" ")).toContain("declared in");
  });

  it("detects instrumentation when the SDK is actually started", () => {
    write("package.json", JSON.stringify({ dependencies: { "@traceroot-ai/traceroot": "^1" } }));
    write("index.js", "import traceroot from '@traceroot-ai/traceroot';\ntraceroot.init();\n");
    const stack = detectStack(dir);

    expect(stack.existingInstrumentation.present).toBe(true);
    expect(stack.existingInstrumentation.evidence.join(" ")).toContain("initialized in");
  });

  it("counts a Python initialize() call too", () => {
    write("requirements.txt", "traceroot==0.1.11\n");
    write("main.py", "import traceroot\n\ntraceroot.initialize()\n");
    const stack = detectStack(dir);
    expect(stack.existingInstrumentation.present).toBe(true);
  });

  it("prefers the Mastra package for a Mastra app", () => {
    write("package.json", JSON.stringify({ dependencies: { "@mastra/core": "^1" } }));
    const service = detectStack(dir).selected as DetectedService;
    expect(sdkPackageFor(service).name).toBe("@traceroot-ai/mastra");
  });
});

describe("SDK version resolution", () => {
  it("uses the registry version when it is reachable", async () => {
    const resolved = await resolveSdkVersion(
      { name: "@traceroot-ai/traceroot", registry: "npm" },
      {
        fetchImpl: async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
      },
    );
    expect(resolved).toEqual({
      package: "@traceroot-ai/traceroot",
      version: "9.9.9",
      source: "registry",
    });
  });

  it("falls back to the bundled pin when the registry is unreachable", async () => {
    const resolved = await resolveSdkVersion(
      { name: "traceroot", registry: "pypi" },
      {
        fetchImpl: async () => {
          throw new Error("offline");
        },
      },
    );
    expect(resolved.source).toBe("bundled");
    expect(resolved.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("falls back to a version each registry really has, for every package setup installs", async () => {
    // The bundled pins said 0.0.4, which npm never had for either TypeScript
    // package and which is alpha-era on PyPI, so a run that could not reach the
    // registry handed the agent an install that could not succeed. The floor is
    // what each registry served when the pins were last set; a bump passes, a
    // placeholder or a missing entry does not.
    const floor: Record<string, string> = {
      traceroot: "0.3.0",
      "@traceroot-ai/traceroot": "0.5.0",
      "@traceroot-ai/mastra": "0.1.1",
    };
    const service: DetectedService = {
      path: ".",
      language: "typescript",
      framework: null,
      entryPoint: null,
      packageManager: "npm",
      testCommand: null,
      evidence: [],
    };
    const packages = [
      sdkPackageFor({ ...service, language: "python", packageManager: "pip" }),
      sdkPackageFor(service),
      sdkPackageFor({ ...service, framework: "mastra" }),
    ];
    expect(packages.map((pkg) => pkg.name).sort()).toEqual(Object.keys(floor).sort());

    for (const pkg of packages) {
      const resolved = await resolveSdkVersion(pkg, {
        fetchImpl: async () => {
          throw new Error("offline");
        },
      });
      expect(resolved.source).toBe("bundled");
      // A release, not a pre-release and not "latest".
      expect(resolved.version).toMatch(/^\d+\.\d+\.\d+$/);
      const min = floor[pkg.name] ?? "";
      expect(
        resolved.version.localeCompare(min, undefined, { numeric: true }),
        `${pkg.name} falls back to ${resolved.version}, below ${min}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("pins the exact version in the install command", () => {
    const service: DetectedService = {
      path: ".",
      language: "python",
      framework: null,
      entryPoint: null,
      packageManager: "uv",
      testCommand: null,
      evidence: [],
    };
    expect(
      installCommand({ package: "traceroot", version: "1.2.3", source: "registry" }, service),
    ).toBe("uv add traceroot==1.2.3");
  });
});

describe("agent task", () => {
  const service: DetectedService = {
    path: "apps/api",
    language: "python",
    framework: "fastapi",
    entryPoint: "main.py",
    packageManager: "uv",
    testCommand: "pytest",
    evidence: ["pyproject.toml in apps/api"],
  };

  it("scopes to one service and pins the version", () => {
    const task = buildSetupTask({
      credentialFiles: [],
      service,
      root: "/repo",
      sdk: TEST_SDK,
      skillPath: ".claude/skills/traceroot-instrument-repo",
      verifyCommand: "pytest",
      interactive: true,
      existingInstrumentation: [],
    });
    expect(task).toContain("exactly one");
    expect(task).toContain("apps/api");
    expect(task).toContain("version `1.2.3`");
    // The two things the agent must NOT do, because doing them is what made a
    // run take five minutes: re-running the app with the key stripped, which
    // nothing reads, and querying the API for the trace, which the CLI does.
    expect(task).not.toContain("TRACEROOT_API_KEY` removed");
    expect(task).toContain("do not run the application with the key unset");
    // And no promise that setup makes the keyless pass instead: it does not.
    expect(task).not.toContain("makes that exact pass itself");
    expect(task).toContain("Do not query the API yourself");
    expect(task).toContain("`traceroot traces list`");
  });

  it("tells a background agent to abort rather than guess", () => {
    const task = buildSetupTask({
      credentialFiles: [],
      service,
      root: "/repo",
      sdk: TEST_SDK,
      skillPath: "p",
      verifyCommand: null,
      interactive: false,
      existingInstrumentation: [],
    });
    expect(task).toContain("cannot ask questions");
    expect(task).toContain("Do not guess");
  });

  it("tells the agent to extend, not duplicate, an existing install", () => {
    const task = buildSetupTask({
      credentialFiles: [],
      service,
      root: "/repo",
      sdk: TEST_SDK,
      skillPath: "p",
      verifyCommand: null,
      interactive: true,
      existingInstrumentation: ["traceroot in apps/api/pyproject.toml"],
    });
    expect(task).toContain("already partly present");
    expect(task).toContain("Do not add a second initialization");
  });

  it("never embeds a credential", () => {
    const task = buildSetupTask({
      credentialFiles: [],
      service,
      root: "/repo",
      sdk: TEST_SDK,
      skillPath: "p",
      verifyCommand: null,
      interactive: true,
      existingInstrumentation: [],
    });
    expect(task).not.toMatch(/tr[_-][A-Za-z0-9]{8,}/);
  });
});

describe("completion parsing", () => {
  it("extracts the fenced block", () => {
    const output = [
      "some prose",
      "```json traceroot-setup-result",
      '{"files_changed":["a.py"],"sdk_version":"1.2.3","trace_id":"t_1","notes":"ok"}',
      "```",
    ].join("\n");
    expect(parseCompletion(output)).toEqual({
      filesChanged: ["a.py"],
      sdkVersion: "1.2.3",
      traceId: "t_1",
      notes: "ok",
    });
  });

  it("takes the last block when the agent retried", () => {
    const block = (id: string) => `\`\`\`json traceroot-setup-result\n{"trace_id":"${id}"}\n\`\`\``;
    expect(parseCompletion(`${block("first")}\n${block("second")}`)?.traceId).toBe("second");
  });

  it("returns null for malformed output instead of throwing", () => {
    expect(parseCompletion("```json traceroot-setup-result\nnot json\n```")).toBeNull();
    expect(parseCompletion("no block at all")).toBeNull();
  });

  describe("after the task Codex echoes", () => {
    const task = buildSetupTask({
      credentialFiles: [],
      service: {
        path: ".",
        language: "python",
        framework: null,
        entryPoint: "main.py",
        packageManager: "pip",
        testCommand: null,
        evidence: ["requirements.txt"],
      },
      root: "/repo",
      sdk: TEST_SDK,
      skillPath: "p",
      verifyCommand: null,
      interactive: false,
      existingInstrumentation: [],
    });

    it("reads a reply with no block as no report, not as the task's template", () => {
      const output = codexCapture(task, "I added initialize() to main.py and ran the app once.");
      // The hazard: the template in the echoed task is a valid block.
      expect(parseCompletion(output)?.notes).toBe("anything the user should know");
      expect(parseCompletion(afterEchoedTask(output, task))).toBeNull();
    });

    it("still reads the block the reply carries", () => {
      const reply = [
        "Added initialize() to main.py.",
        "```json traceroot-setup-result",
        '{"files_changed":["main.py"],"sdk_version":"1.2.3","trace_id":null,"notes":"done"}',
        "```",
      ].join("\n");
      expect(parseCompletion(afterEchoedTask(codexCapture(task, reply), task))).toEqual({
        filesChanged: ["main.py"],
        sdkVersion: "1.2.3",
        traceId: null,
        notes: "done",
      });
    });

    it("leaves output that does not echo the task whole", () => {
      expect(afterEchoedTask("some output", task)).toBe("some output");
    });
  });
});

describe("agent invocation", () => {
  it("passes the credential through the environment, never argv", () => {
    const secret = makeSecret("tr-secret-key-value-here");
    const invocation = buildInvocation({ agentId: "claude", task: "TASK", interactive: false });
    const env = buildAgentEnv({
      parentEnv: { PATH: "/usr/bin" },
      credential: secret,
      host: "https://api.example.test",
      // No file holds the key, so the environment is the only channel — which
      // is the case this test is about.
      credentialFiles: [],
    });
    expect(invocation.args.join(" ")).not.toContain(secret.reveal());
    expect(env.TRACEROOT_API_KEY).toBe(secret.reveal());
    expect(env.TRACEROOT_HOST_URL).toBe("https://api.example.test");
  });

  it("never lets a variadic flag sit immediately before the prompt", () => {
    // Regression: `--disallowedTools` is variadic, so a positional prompt placed
    // straight after it was consumed as tool names — split on whitespace into
    // hundreds of bogus deny rules, leaving the agent with NO task. Observed in
    // a real run. Any variadic flag must be followed by a single-value flag.
    const VARIADIC = ["--disallowedTools", "--allowedTools"];
    for (const agentId of ["claude"] as const) {
      for (const interactive of [true, false]) {
        const inv = buildInvocation({ agentId, task: "t", interactive });
        if (inv.promptVia !== "argv") {
          continue;
        }
        const last = inv.args[inv.args.length - 2];
        expect(VARIADIC).not.toContain(last);
        // And the flag's own value must not be the final token either.
        for (const flag of VARIADIC) {
          const i = inv.args.indexOf(flag);
          if (i !== -1) {
            expect(i + 1).toBeLessThan(inv.args.length - 1);
          }
        }
      }
    }
  });

  it("disables plan mode so the agent cannot end without doing the work", () => {
    expect(buildInvocation({ agentId: "claude", task: "t", interactive: true }).args).toContain(
      "EnterPlanMode",
    );
  });

  it("never grants bypass-all permissions", () => {
    for (const interactive of [true, false]) {
      for (const agentId of ["claude"] as const) {
        const args = buildInvocation({ agentId, task: "t", interactive }).args.join(" ");
        expect(args).not.toContain("bypassPermissions");
        expect(args).not.toContain("dangerously");
        expect(args).not.toContain("--yolo");
      }
    }
  });

  it("pipes the task on stdin in background mode", () => {
    expect(buildInvocation({ agentId: "claude", task: "t", interactive: false })).toMatchObject({
      promptVia: "stdin",
      interactive: false,
    });
  });

  it("refuses to launch an agent setup does not drive", () => {
    for (const agentId of ["codex", "generic"] as const) {
      expect(() => buildInvocation({ agentId, task: "t", interactive: true })).toThrow();
    }
  });
});

describe("setup report", () => {
  const baseCtx = () =>
    ({
      root: dir,
      checkpoint: {
        version: 1 as const,
        startedAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:01:00.000Z",
        cliVersion: "0.2.0",
        completedStages: [],
        projectName: "checkout",
        projectId: "p_1",
        workspaceId: "w_1",
        host: "https://api.example.test",
        projectKeyHint: "tr-a439-a3dc",
        projectKeyId: "ak_1",
        sdkVersion: "0.1.11",
        service: { path: "apps/api", language: "python" as const, framework: "fastapi" },
      },
      trace: { traceId: "abc123", traceUrl: "https://ui.example.test/t/abc123" },
      method: "agent",
    }) as unknown as Parameters<typeof renderSetupReport>[0];

  it("records what was connected, instrumented and verified", () => {
    const md = renderSetupReport(baseCtx(), new Date("2026-07-30T00:02:00.000Z"), {
      kind: "environment",
    });

    expect(md).toContain("a trace has been received");
    expect(md).toContain("checkout");
    expect(md).toContain("apps/api");
    expect(md).toContain("0.1.11");
    expect(md).toContain("https://ui.example.test/t/abc123");
  });

  it("never contains a credential", () => {
    // This file is written to be pasted into pull requests, which is the last
    // place a key should be able to reach. Only the hint appears.
    const md = renderSetupReport(baseCtx(), new Date(), { kind: "environment" });
    expect(md).toContain("tr-a439-a3dc");
    expect(md).not.toMatch(/tr[_-][a-z0-9]{8,}/i);
  });

  it("makes no claim about the project's own tests, which setup never runs", () => {
    const md = renderSetupReport(baseCtx(), new Date(), { kind: "environment" });

    expect(md).not.toContain("Your checks");
    expect(md).not.toContain("TraceRoot switched off");
  });

  it("says what to do next when no trace arrived", () => {
    const ctx = baseCtx() as unknown as { trace?: unknown };
    ctx.trace = undefined;
    const md = renderSetupReport(ctx as Parameters<typeof renderSetupReport>[0], new Date(), {
      kind: "environment",
    });

    expect(md).toContain("no trace has been seen yet");
    expect(md).toContain("--resume");
  });
});

describe("waiting for a trace only when there is one to wait for", () => {
  it("tells the agent to run the application, not just instrument it", () => {
    // Instrumenting emits nothing; running does. Leaving this implicit is how
    // a run ends with working instrumentation and no trace.
    const task = buildSetupTask({
      credentialFiles: [],
      root: "/repo",
      service: {
        path: ".",
        language: "python",
        framework: null,
        entryPoint: "main.py",
        packageManager: "uv",
        testCommand: null,
        evidence: [],
      },
      sdk: { package: "traceroot", version: "0.1.11", source: "registry" },
      existingInstrumentation: [],
      skillPath: ".claude/skills/x",
      projectName: "demo",
      verifyCommand: null,
    } as unknown as Parameters<typeof buildSetupTask>[0]);

    expect(task).toContain("Run it once");
    expect(task).toContain("running** it does");
  });
});

describe("whose instrumentation counts", () => {
  it("asks about the chosen service, not the whole repository", () => {
    // One instrumented service made every other service look already done, so
    // the agent was told the work was finished and wrote nothing.
    write("done/requirements.txt", "traceroot==0.1.11\n");
    write("done/main.py", "import traceroot\n\ntraceroot.initialize()\n");
    write("todo/requirements.txt", "openai\n");
    write("todo/main.py", "import openai\n");

    expect(
      detectStack(dir, { service: "todo", language: "python" }).existingInstrumentation.present,
    ).toBe(false);
    expect(
      detectStack(dir, { service: "done", language: "python" }).existingInstrumentation.present,
    ).toBe(true);
  });
});

describe("installing into the interpreter the service runs on", () => {
  it("names the virtualenv rather than the system python", () => {
    // `python3 -m pip install` on a Homebrew or Debian Python fails outright
    // with `externally-managed-environment` (PEP 668). An agent handed that
    // has to discover the venv itself before it can write a line of code.
    const command = installCommand(
      { package: "traceroot", version: "0.1.11" } as never,
      { language: "python", packageManager: "pip" } as never,
      "python",
      "/repo/.venv/bin/python",
    );
    expect(command).toBe("'/repo/.venv/bin/python' -m pip install traceroot==0.1.11");
  });

  it("quotes it single, so a shell expands nothing inside the path", () => {
    const command = installCommand(
      { package: "traceroot", version: "0.1.11" } as never,
      { language: "python", packageManager: "pip" } as never,
      "python",
      "/My Repo/.venv/bin/python",
    );
    expect(command).toContain("'/My Repo/.venv/bin/python'");
  });
});

describe("everything the task settles so the agent does not have to", () => {
  const task = () =>
    buildSetupTask({
      credentialFiles: [],
      root: "/repo",
      service: {
        path: "svc",
        language: "python",
        framework: null,
        entryPoint: "main.py",
        packageManager: "pip",
        evidence: ["requirements.txt"],
      } as never,
      sdk: { package: "traceroot", version: "0.1.11" } as never,
      skillPath: "/root/.claude/skills/x/SKILL.md",
      verifyCommand: null,
      interactive: false,
      existingInstrumentation: [],
      pythonInterpreter: "/repo/.venv/bin/python",
      envFiles: ["../.env"],
    });

  it("spells out how to run the service, with no shell the sandbox will refuse", () => {
    // `set -a && . ../.env && ...` is rejected before it reaches a shell —
    // "changes shell option state ... defeats static env-var analysis". So are
    // `. file`, `$(...)` and multi-part pipelines. Every spelling of it is
    // blocked, in a different way each time.
    const rendered = task();
    expect(rendered).toContain("run it with: `../.venv/bin/python main.py`");
    // A literal placeholder is a hole in the one fact that exists to stop the
    // agent looking things up, and it fills that hole by reading the directory
    // and running the app once to check its guess.
    expect(rendered).not.toContain("<entry point>");
    // Named once, in the warning that says it will be refused — never as a
    // command to run.
    const runLine = rendered.split("\n").find((l) => l.includes("run it with:")) ?? "";
    expect(runLine).not.toContain("set -a");
  });

  it("routes the app's own credentials through the entry point instead", () => {
    // In-process loading is what the agent worked its own way to, and it is
    // the better answer regardless: it leaves the app runnable by a human.
    const rendered = task();
    expect(rendered).toContain("load_dotenv");
    expect(rendered).toContain("from inside the entry point");
  });

  it("forbids the four detours that ate a 400-second run", () => {
    // Each of these is a measured cost, not a hypothetical: 147s in a
    // subagent, ~34s re-running the app with the key stripped, plus the SDK
    // source hunt that spawned the subagent and the sibling service it read
    // instead once that failed.
    const rendered = task();
    expect(rendered).toContain("do not run the application with the key unset");
    expect(rendered).toContain("Do not delegate any of this to a subagent");
    expect(rendered).toContain("do not go looking for the SDK's source tree");
    expect(rendered).toContain("Do not read other services in this repository");
  });

  it("tells the agent the skill's first three steps are already done", () => {
    expect(task()).toContain("Read it for **step 4 onward**");
  });

  it("keeps every stated fact recoverable if it turns out wrong", () => {
    // None of the anti-re-verification wording may strand the agent: each
    // asserted fact names the failure that means it was wrong.
    const rendered = task();
    expect(rendered).toContain("If it fails, read the error and adapt");
    expect(rendered).toContain("If the SDK reports at runtime that it is missing");
    expect(rendered).toContain("If a command is genuinely refused");
  });

  it("promises no line the SDK does not print, and still keeps the agent off the API", () => {
    // This asserted that the task contained `[traceroot] trace` — output no
    // SDK produces. Pinning it held the agent to a stop condition that could
    // never be met, so it re-ran the application to look for the line again.
    const rendered = task();
    expect(rendered).not.toContain("[traceroot] trace");
    expect(rendered).toContain("There is no confirmation line to wait for");
    expect(rendered).toContain("`traceroot traces list`");
  });
});

describe("leaving nothing for the agent to look up", () => {
  const task = (language: "python" | "typescript" = "python") =>
    buildSetupTask({
      credentialFiles: [],
      root: "/repo",
      service: {
        path: "svc",
        language,
        framework: null,
        entryPoint: "main.py",
        packageManager: "pip",
        evidence: ["requirements.txt"],
      } as never,
      sdk: { package: "traceroot", version: "0.1.11" } as never,
      skillPath: "/root/.claude/skills/x/SKILL.md",
      verifyCommand: null,
      interactive: false,
      existingInstrumentation: [],
      pythonInterpreter: "/repo/.venv/bin/python",
      envFiles: ["../.env"],
    });

  it("writes the initialization out instead of describing it", () => {
    // An agent handed a description runs consecutive introspection calls before
    // writing a line. Telling it to introspect *once* does not help — telling
    // someone how to look a thing up does not stop them looking it up.
    const rendered = task();
    expect(rendered).toContain("traceroot.initialize(integrations=[Integration.ANTHROPIC])");
    expect(rendered).toContain(
      "import anthropic   # the provider library, imported wherever it already was",
    );
    expect(rendered).toContain("Do not introspect the package");
  });

  it("names the integration members the SDK actually has", () => {
    // Verified against traceroot==0.1.11. `AMAZON_BEDROCK` was asserted here
    // from memory and does not exist — the member is `BEDROCK`, and shipping
    // the wrong one would have had the agent write code that cannot import.
    const rendered = task();
    expect(rendered).toContain("BEDROCK");
    expect(rendered).not.toContain("AMAZON_BEDROCK");
    for (const member of ["OPENAI", "ANTHROPIC", "LANGCHAIN", "GOOGLE_GENAI", "MISTRAL"]) {
      expect(rendered).toContain(member);
    }
  });

  it("threads the env file into the snippet it hands over", () => {
    // Anchored on the entry point, not on the directory the app is launched
    // from: `detectEnvFiles` names the file relative to the service, and the
    // snippet is a line of the application's own source.
    expect(task()).toContain('load_dotenv(Path(__file__).resolve().parent / "../.env")');
  });

  it("gives TypeScript its own shape rather than Python's", () => {
    const rendered = task("typescript");
    // The package `sdkPackageFor` actually installs. The snippet named
    // `traceroot-sdk-ts`, which the run never installs, so the paste failed.
    expect(rendered).toContain("@traceroot-ai/traceroot");
    expect(rendered).not.toContain("load_dotenv");
  });
});

describe("getting the credential setup wrote into the application", () => {
  const task = (input: {
    language?: "python" | "typescript";
    entryPoint?: string;
    envFiles?: string[];
    credentialEnvFile?: string | null;
  }) =>
    buildSetupTask({
      credentialFiles: [],
      root: "/repo",
      service: {
        path: "svc",
        language: input.language ?? "python",
        framework: null,
        entryPoint: input.entryPoint ?? "main.py",
        packageManager: "pip",
        evidence: ["requirements.txt"],
      } as never,
      sdk: { package: "traceroot", version: "0.1.11" } as never,
      skillPath: "/root/.claude/skills/x/SKILL.md",
      verifyCommand: null,
      interactive: false,
      existingInstrumentation: [],
      pythonInterpreter: "/repo/.venv/bin/python",
      envFiles: input.envFiles ?? [],
      credentialEnvFile: input.credentialEnvFile ?? null,
    });

  it("loads the credential's file once, not twice", () => {
    // It was twice: one `load_dotenv` for the app's own file and a second for
    // the `.env.traceroot` setup had written. The credential is in the project's
    // own env file now, so the two loads are one file and one line.
    const rendered = task({ envFiles: ["./.env"], credentialEnvFile: "./.env" });
    const snippet = rendered.slice(rendered.indexOf("### 3."), rendered.indexOf("### 4."));
    const lines = snippet
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("load_dotenv("));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('load_dotenv(Path(__file__).resolve().parent / ".env")');
    expect(lines[0]).toContain("the app's own credentials");
  });

  it("says that the one load is what keeps tracing working after the run", () => {
    // The hard rules tell the agent `TRACEROOT_API_KEY` is already in its
    // environment and not to confirm, print or grep for it. An agent holding
    // that and no explanation treats the load as redundant — and the key is in
    // *its* environment only for the length of this run. One sentence now,
    // where the old filename needed a paragraph per language.
    const rendered = task({ envFiles: ["./.env"], credentialEnvFile: "./.env" });

    expect(rendered).toContain("wrote `TRACEROOT_API_KEY` into `./.env`");
    expect(rendered).toContain("keeps tracing working once this run ends");
  });

  it("no longer teaches a loader for a filename of our own", () => {
    // All of this existed because `.env.traceroot` was a name no runtime reads:
    // a start-script flag, an environment variable naming the path, and a Node
    // version floor for the only flag that tolerates the file being absent. The
    // project's own `.env` is read by whatever the project already uses.
    for (const language of ["python", "typescript"] as const) {
      const rendered = task({ language, envFiles: ["./.env"], credentialEnvFile: "./.env" });
      expect(rendered).not.toContain(".env.traceroot");
      expect(rendered).not.toContain("--env-file");
      expect(rendered).not.toContain("DOTENV_CONFIG_PATH");
      expect(rendered).not.toContain("Node 22.9");
    }
  });

  it("puts TypeScript's env load before the call that reads the key", () => {
    // `import "dotenv/config"` reads `.env` and only `.env`, resolved against
    // `process.cwd()` — so a service whose credential went into `.env.local`,
    // or whose entry point is not at the service root, started with no
    // TraceRoot key and nothing printed. `initialize()` reads `process.env`
    // when it is called, so the explicit load has to sit above that call.
    const rendered = task({ language: "typescript", envFiles: ["./.env"] });
    const snippet = rendered.slice(rendered.indexOf("### 3."), rendered.indexOf("### 4."));

    expect(snippet).not.toContain('import "dotenv/config"');
    expect(snippet).toContain('config({ path: new URL(".env", import.meta.url) })');
    expect(snippet.indexOf("config({ path:")).toBeLessThan(
      snippet.indexOf("TraceRoot.initialize("),
    );
    expect(rendered).not.toContain("load_dotenv");
  });

  it("puts a TypeScript service's load and initialize inside the function it runs", () => {
    // The same defect as the Python snippet's, in the one place a Node service
    // was still shown the old placement. Module scope runs on import, so a test
    // suite that imports the entry point loads the credential and starts the
    // SDK, and every test reaching an instrumented function exports a trace of
    // its own. `observe(options, fn, ...args)` invokes rather than wraps, so
    // there is no module-scope wrapper to arm either: the load sitting inside
    // the function is what keeps an imported module silent.
    const rendered = task({ language: "typescript", envFiles: ["./.env"] });
    const snippet = rendered.slice(rendered.indexOf("### 3."), rendered.indexOf("### 4."));

    expect(snippet).toContain("async function main() {");
    expect(snippet).toContain("\n  TraceRoot.initialize({ instrumentModules:");
    expect(snippet).toContain('\n  config({ path: new URL(".env", import.meta.url) })');
    // Neither at the left margin, which is where both used to sit.
    expect(snippet).not.toMatch(/\nTraceRoot\.initialize\(/);
    expect(snippet).not.toMatch(/\nconfig\(\{ path:/);
  });

  it("drops the import-order claim from the TypeScript snippet too", () => {
    // The instrumentors patch the provider's class methods through `wrapt`,
    // which works whether or not the provider was imported first, so
    // initialization never had to precede that import — and the comment saying
    // it did is why the pair sat at module scope.
    const rendered = task({ language: "typescript", envFiles: ["./.env"] });
    expect(rendered).not.toContain("Before importing the SDK you are instrumenting");
  });

  it("names the credential's own file in a TypeScript load, not `.env`", () => {
    const rendered = task({
      language: "typescript",
      entryPoint: "src/index.ts",
      envFiles: ["./.env.local", "./.env"],
      credentialEnvFile: "./.env.local",
    });

    expect(rendered).toContain('config({ path: new URL("../.env.local", import.meta.url) })');
    expect(rendered).not.toContain('import "dotenv/config"');
  });

  it("still tells the agent to declare the dependency it imports", () => {
    expect(task({ envFiles: ["./.env"], credentialEnvFile: "./.env" })).toContain(
      "Add the dotenv package to the manifest if you import it",
    );
  });

  it("names no credential file when the run did not write one", () => {
    // A tracked env file is refused, and a key that already resolved from the
    // user's own environment is never written to one. The app's own file is a
    // separate question and still answered.
    const rendered = task({ envFiles: ["../.env"], credentialEnvFile: null });

    expect(rendered).not.toContain("wrote `TRACEROOT_API_KEY` into");
    expect(rendered).toContain('load_dotenv(Path(__file__).resolve().parent / "../.env")');
  });

  it("still resolves the load against the entry point, not the launch directory", () => {
    // Unchanged by the move, and still the thing that silently breaks: the path
    // is named from where the agent stands, but the load is a line of the
    // application's own source, and `python svc/main.py` from the repository
    // root would resolve `"./.env"` against the root and find nothing.
    const rendered = task({ entryPoint: "src/main.py", envFiles: ["./.env"] });

    expect(rendered).toContain('load_dotenv(Path(__file__).resolve().parent / "../.env")');
    expect(rendered).not.toContain('load_dotenv("./.env")');
  });
});

describe("the task renders whole", () => {
  const render = () =>
    buildSetupTask({
      credentialFiles: [],
      root: "/repo",
      service: {
        path: "svc",
        language: "python",
        framework: null,
        entryPoint: "main.py",
        packageManager: "pip",
        evidence: ["requirements.txt"],
      } as never,
      sdk: { package: "traceroot", version: "0.1.11" } as never,
      skillPath: "/root/.claude/skills/x/SKILL.md",
      verifyCommand: null,
      interactive: false,
      existingInstrumentation: [],
      pythonInterpreter: "/repo/.venv/bin/python",
      envFiles: ["../.env"],
    });

  it("contains every numbered step", () => {
    // An unescaped backtick inside the template literal closes it early and
    // truncates the prompt mid-sentence. The build still succeeds and the tests
    // still pass, so nothing catches it except reading the output — this does.
    const task = render();
    for (let step = 1; step <= 8; step += 1) {
      expect(task).toContain(`### ${step}.`);
    }
    expect(task.trimEnd().endsWith("`")).toBe(false);
  });

  it("names the interpreter relatively, so quoting cannot bite", () => {
    // An absolute path containing spaces and parentheses made the agent try
    // four spellings before one ran: quoted, backslash-escaped, a `pwd` to
    // orient, then the relative form. `../.venv/bin/python` has no hazard.
    expect(render()).toContain("run it with: `../.venv/bin/python main.py`");
  });

  it("tells the agent the install reports its own success", () => {
    const task = render();
    expect(task).toContain("Its own output is the confirmation");
    expect(task).toContain("do not follow it with `pip show`");
  });
});

describe("reading a checkpoint that cannot be trusted", () => {
  it("refuses one whose start time does not parse", async () => {
    // `startedAt` is the poll's lower bound in `verify_trace`, where an
    // unparseable value throws `Invalid time value` on every attempt.
    const { readCheckpoint } = await import("../../src/setup/checkpoint.js");
    // The shared `dir`, which `afterEach` removes — a private `mkdtempSync` here
    // leaked a directory into the system tmpdir on every run.
    const root = dir;
    mkdirSync(join(root, ".traceroot"), { recursive: true });
    writeFileSync(
      join(root, ".traceroot", "setup.json"),
      JSON.stringify({ version: 1, startedAt: "not a date" }),
      "utf8",
    );

    expect(readCheckpoint(root)).toBeNull();
  });

  it("reads a trace written before its attribution was recorded, as unknown", async () => {
    // Missing is "not known", never "someone else's": the resumed report must
    // not start doubting a trace the first run had no reason to doubt.
    const { readCheckpoint } = await import("../../src/setup/checkpoint.js");
    const root = dir;
    mkdirSync(join(root, ".traceroot"), { recursive: true });
    writeFileSync(
      join(root, ".traceroot", "setup.json"),
      JSON.stringify({
        version: 1,
        startedAt: "2026-07-26T12:00:00.000Z",
        completedStages: ["verify_trace"],
        trace: {
          traceId: "t_1",
          traceUrl: "https://app.example.test/trace/t_1",
          observedAt: "2026-07-26T12:00:30.000Z",
          waitedMs: 4000,
          spanCount: 7,
        },
      }),
      "utf8",
    );

    const checkpoint = readCheckpoint(root);
    expect(checkpoint?.trace?.traceId).toBe("t_1");
    expect(checkpoint?.trace?.attributed).toBeUndefined();
    const md = renderSetupReport(
      { root, checkpoint, trace: checkpoint?.trace } as unknown as Parameters<
        typeof renderSetupReport
      >[0],
      new Date("2026-07-26T12:01:00.000Z"),
      { kind: "environment" },
    );
    expect(md).toContain("**First trace.** `t_1` — 7 spans\n");
    expect(md).not.toContain("Not confirmed");
  });

  it("drops a stage and fields it does not know rather than the whole checkpoint", async () => {
    // A stage name this version has no stage for is filtered, and a field it
    // has no reader for is left behind, so a checkpoint from a build with a
    // different pipeline still resumes from the stages both of them share.
    const { readCheckpoint } = await import("../../src/setup/checkpoint.js");
    const root = dir;
    mkdirSync(join(root, ".traceroot"), { recursive: true });
    writeFileSync(
      join(root, ".traceroot", "setup.json"),
      JSON.stringify({
        version: 1,
        startedAt: "2026-07-26T12:00:00.000Z",
        completedStages: ["instrument", "verify_application"],
        application: { command: "pytest", passed: true },
      }),
      "utf8",
    );

    const checkpoint = readCheckpoint(root);
    expect(checkpoint?.completedStages).toEqual(["instrument"]);
    expect(checkpoint).not.toHaveProperty("application");
  });
});
