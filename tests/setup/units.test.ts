import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import {
  ensureIgnored,
  removeEnvKeys,
  upsertEnvContent,
  upsertEnvFile,
} from "../../src/setup/envWrite.js";
import { SETUP_EXIT_CODES, SetupError } from "../../src/setup/errors.js";
import { splitCommand } from "../../src/setup/exec.js";
import { changedSince, parsePorcelain } from "../../src/setup/git.js";
import { buildAgentEnv, buildInvocation } from "../../src/setup/launch.js";
import { renderSetupReport } from "../../src/setup/report.js";
import { installCommand, resolveSdkVersion, sdkPackageFor } from "../../src/setup/sdk.js";
import { makeSecret, redact, secretHint } from "../../src/setup/secret.js";
import { detectStack } from "../../src/setup/stack.js";
import { buildSetupTask, parseCompletion } from "../../src/setup/task.js";
import type { DetectedService } from "../../src/setup/types.js";
import { TEST_SDK } from "./helpers.js";

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
    expect(SETUP_EXIT_CODES.TRACE_TIMEOUT).toBe(7);
    const err = new SetupError({
      stage: "verify_trace",
      code: "TRACE_TIMEOUT",
      message: "no trace",
      remedy: "run the app",
    });
    expect(err.exitCode).toBe(7);
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
    const path = join(dir, ".env.traceroot");
    upsertEnvFile(path, { TRACEROOT_API_KEY: "k" });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path, "utf8")).toContain("TRACEROOT_API_KEY=k");
  });

  it("removes only the named keys", () => {
    const path = join(dir, ".env.traceroot");
    writeFileSync(path, "# keep\nFOO=1\nTRACEROOT_API_KEY=k\n", "utf8");
    expect(removeEnvKeys(path, ["TRACEROOT_API_KEY"])).toEqual(["TRACEROOT_API_KEY"]);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("# keep");
    expect(after).toContain("FOO=1");
    expect(after).not.toContain("TRACEROOT_API_KEY");
  });

  it("appends a gitignore rule only when one is missing", () => {
    expect(ensureIgnored(dir, ".env.traceroot")).toBe("appended");
    expect(ensureIgnored(dir, ".env.traceroot")).toBe("already");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".env.traceroot\n");
  });

  it("recognizes a broad .env* rule as already covering the file", () => {
    writeFileSync(join(dir, ".gitignore"), ".env*\n", "utf8");
    expect(ensureIgnored(dir, ".env.traceroot")).toBe("already");
  });
});

describe("splitCommand", () => {
  it("splits without invoking a shell", () => {
    expect(splitCommand("npm test")).toEqual({ program: "npm", args: ["test"] });
  });

  it("respects quoted segments", () => {
    expect(splitCommand('pytest -k "my test"')).toEqual({
      program: "pytest",
      args: ["-k", "my test"],
    });
  });

  it("does not interpret shell metacharacters", () => {
    // A metacharacter becomes a literal argument rather than a second command.
    expect(splitCommand("npm test && rm -rf /")).toEqual({
      program: "npm",
      args: ["test", "&&", "rm", "-rf", "/"],
    });
  });

  it("returns null for an empty command", () => {
    expect(splitCommand("   ")).toBeNull();
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
    // The two things the agent must NOT do, because the CLI does both itself
    // and doing them twice is what made a run take five minutes: re-running the
    // app with the key stripped, and querying the API for the trace.
    expect(task).not.toContain("TRACEROOT_API_KEY` removed");
    expect(task).toContain("do not run the application with the key unset");
    expect(task).toContain("Do not run `traceroot traces list`");
  });

  it("tells a background agent to abort rather than guess", () => {
    const task = buildSetupTask({
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
});

describe("agent invocation", () => {
  it("passes the credential through the environment, never argv", () => {
    const secret = makeSecret("tr-secret-key-value-here");
    const invocation = buildInvocation({ agentId: "claude", task: "TASK", interactive: false });
    const env = buildAgentEnv({
      parentEnv: { PATH: "/usr/bin" },
      credential: secret,
      host: "https://api.example.test",
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
    for (const agentId of ["claude", "codex"] as const) {
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
      for (const agentId of ["claude", "codex"] as const) {
        const args = buildInvocation({ agentId, task: "t", interactive }).args.join(" ");
        expect(args).not.toContain("bypassPermissions");
        expect(args).not.toContain("dangerously");
        expect(args).not.toContain("--yolo");
      }
    }
  });

  it("pipes the task on stdin in background mode", () => {
    expect(buildInvocation({ agentId: "codex", task: "t", interactive: false })).toMatchObject({
      program: "codex",
      args: ["exec", "-"],
      promptVia: "stdin",
    });
  });

  it("refuses to launch the tool-neutral adapter", () => {
    expect(() => buildInvocation({ agentId: "generic", task: "t", interactive: true })).toThrow();
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
      application: {
        command: "pytest",
        withCredentials: { passed: true },
        withoutCredentials: { passed: true },
        passed: true,
      },
      trace: { traceId: "abc123", traceUrl: "https://ui.example.test/t/abc123" },
      method: "agent",
    }) as unknown as Parameters<typeof renderSetupReport>[0];

  it("records what was connected, instrumented and verified", () => {
    const md = renderSetupReport(baseCtx(), new Date("2026-07-30T00:02:00.000Z"));

    expect(md).toContain("a trace has been received");
    expect(md).toContain("checkout");
    expect(md).toContain("apps/api");
    expect(md).toContain("0.1.11");
    expect(md).toContain("https://ui.example.test/t/abc123");
    expect(md).toContain("with and without");
  });

  it("never contains a credential", () => {
    // This file is written to be pasted into pull requests, which is the last
    // place a key should be able to reach. Only the hint appears.
    const md = renderSetupReport(baseCtx(), new Date());
    expect(md).toContain("tr-a439-a3dc");
    expect(md).not.toMatch(/tr[_-][a-z0-9]{8,}/i);
  });

  it("does not claim checks passed when they never ran", () => {
    const ctx = baseCtx() as unknown as { application?: unknown };
    ctx.application = undefined;
    const md = renderSetupReport(ctx as Parameters<typeof renderSetupReport>[0], new Date());

    expect(md).toContain("Not run.");
    expect(md).not.toContain("with and without");
  });

  it("says what to do next when no trace arrived", () => {
    const ctx = baseCtx() as unknown as { trace?: unknown };
    ctx.trace = undefined;
    const md = renderSetupReport(ctx as Parameters<typeof renderSetupReport>[0], new Date());

    expect(md).toContain("no trace has been seen yet");
    expect(md).toContain("--resume");
  });
});

describe("waiting for a trace only when there is one to wait for", () => {
  it("tells the agent to run the application, not just instrument it", () => {
    // Instrumenting emits nothing; running does. Leaving this implicit is how
    // a run ends with working instrumentation and no trace.
    const task = buildSetupTask({
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

  it("points at the line the SDK prints instead of at the API", () => {
    expect(task()).toContain("[traceroot] trace");
    expect(task()).toContain("Do not run `traceroot traces list`");
  });
});

describe("leaving nothing for the agent to look up", () => {
  const task = (language: "python" | "typescript" = "python") =>
    buildSetupTask({
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
    expect(rendered).toContain("import anthropic   # must come after initialize()");
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
    expect(task()).toContain('load_dotenv("../.env")');
  });

  it("gives TypeScript its own shape rather than Python's", () => {
    const rendered = task("typescript");
    // The package `sdkPackageFor` actually installs. The snippet named
    // `traceroot-sdk-ts`, which the run never installs, so the paste failed.
    expect(rendered).toContain("@traceroot-ai/traceroot");
    expect(rendered).not.toContain("load_dotenv");
  });
});

describe("the task renders whole", () => {
  const render = () =>
    buildSetupTask({
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

  it("drops a stage result whose shape is wrong rather than adopting it", async () => {
    // `{passed: true}` with `verify_application` already completed would satisfy
    // the stage on a resumed run without the verification ever having happened.
    const { readCheckpoint } = await import("../../src/setup/checkpoint.js");
    // The shared `dir`, which `afterEach` removes — a private `mkdtempSync` here
    // leaked a directory into the system tmpdir on every run.
    const root = dir;
    mkdirSync(join(root, ".traceroot"), { recursive: true });
    writeFileSync(
      join(root, ".traceroot", "setup.json"),
      JSON.stringify({
        version: 1,
        startedAt: "2026-07-26T12:00:00.000Z",
        completedStages: ["verify_application"],
        application: { passed: true },
      }),
      "utf8",
    );

    const checkpoint = readCheckpoint(root);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.application).toBeUndefined();
  });
});
