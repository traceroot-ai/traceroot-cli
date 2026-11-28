import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LookupFailure,
  type LookupFailureKind,
  type LookupOptions,
  findEvalRunner,
} from "../../src/eval/lookup.js";
import type { RunProcess } from "../../src/setup/exec.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tr-eval-lookup-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A Python that answers the version probe with fixed versions, without starting a process. */
function probeAnswer(traceroot: string | null): RunProcess {
  const line = JSON.stringify({ executable: "/usr/bin/python3", python: "3.12.4", traceroot });
  return async () => ({
    exitCode: 0,
    output: `${line}\n`,
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  });
}

/** A Python that isn't there. */
const noPython: RunProcess = async () => ({
  exitCode: 127,
  output: "",
  durationMs: 1,
  timedOut: false,
  spawnFailed: true,
});

/**
 * A project in its own folder under the test's, with the SDK and tsx in its
 * `node_modules` at the given versions, either left out when null. Returns
 * the folder.
 */
function nodeProject(name: string, sdk: string | null, tsx: string | null): string {
  const base = join(dir, name);
  mkdirSync(base, { recursive: true });
  if (sdk !== null) {
    const root = join(base, "node_modules", "@traceroot-ai", "traceroot");
    write(
      join(root, "package.json"),
      JSON.stringify({
        name: "@traceroot-ai/traceroot",
        version: sdk,
        exports: { ".": "./dist/index.js" },
      }),
    );
    write(join(root, "dist", "index.js"), "");
  }
  if (tsx !== null) {
    const root = join(base, "node_modules", "tsx");
    write(
      join(root, "package.json"),
      JSON.stringify({ name: "tsx", version: tsx, exports: { ".": "./dist/loader.mjs" } }),
    );
    write(join(root, "dist", "loader.mjs"), "");
  }
  return base;
}

const NODE: LookupOptions = { execPath: "/usr/local/bin/node", nodeVersion: "22.12.0" };

describe("finding the runner by the file's extension", () => {
  it("refuses an extension no runner loads", async () => {
    for (const file of ["x_eval.txt", "x_eval.cjs", "x_eval.tsx", "x_eval"]) {
      const found = await findEvalRunner(file, { cwd: dir });

      expect(found).toEqual({
        ok: false,
        failure: {
          kind: "unsupported_extension",
          message: `${file} is not a Python, TypeScript or JavaScript evaluation file.`,
          fix: "Use a .py, .ts, .js or .mjs file.",
        },
      });
    }
  });

  it("runs a .py file with Python, resolved against the working directory", async () => {
    const found = await findEvalRunner(join("evals", "x_eval.py"), {
      cwd: dir,
      env: { PATH: "" },
      runProcess: probeAnswer("0.5.1"),
    });

    expect(found).toEqual({
      ok: true,
      runner: {
        language: "python",
        sdkVersion: "0.5.1",
        argv: ["/usr/bin/python3", "-m", "traceroot.eval.runner", join(dir, "evals", "x_eval.py")],
      },
    });
  });

  it("runs .ts as TypeScript and .js and .mjs as JavaScript, all through Node", async () => {
    const project = nodeProject("app", "0.8.1", "4.19.2");
    for (const [name, language] of [
      ["x_eval.ts", "typescript"],
      ["x_eval.js", "javascript"],
      ["x_eval.mjs", "javascript"],
    ] as const) {
      const found = await findEvalRunner(name, { cwd: project, ...NODE });

      expect(found.ok && found.runner.language).toBe(language);
      expect(found.ok && found.runner.argv.slice(0, 2)).toEqual([NODE.execPath, "--import"]);
      expect(found.ok && found.runner.argv.at(-1)).toBe(join(project, name));
    }
  });
});

describe("the shape of every failure", () => {
  /** Each failure the lookup can return, reached the way a user would reach it. */
  async function everyFailure(): Promise<LookupFailure[]> {
    const python = { cwd: dir, env: { PATH: "" } };
    const failures: LookupFailure[] = [];
    const collect = async (file: string, options: LookupOptions) => {
      const found = await findEvalRunner(file, options);
      if (!found.ok) failures.push(found.failure);
    };

    await collect("x_eval.rb", { cwd: dir });
    await collect("x_eval.py", { ...python, runProcess: noPython });
    await collect("x_eval.py", { ...python, runProcess: probeAnswer(null) });
    await collect("x_eval.py", { ...python, runProcess: probeAnswer("0.2.0") });
    await collect("x_eval.ts", { ...NODE, cwd: nodeProject("no-sdk", null, "4.19.2") });
    await collect("x_eval.ts", { ...NODE, cwd: nodeProject("old-sdk", "0.7.0", "4.19.2") });
    await collect("x_eval.ts", { ...NODE, cwd: nodeProject("no-tsx", "0.8.1", null) });
    await collect("x_eval.ts", { ...NODE, cwd: nodeProject("old-tsx", "0.8.1", "4.10.3") });
    await collect("x_eval.ts", {
      ...NODE,
      cwd: nodeProject("old-node", "0.8.1", "4.19.2"),
      nodeVersion: "20.5.1",
    });
    return failures;
  }

  it("is reached for every kind, each with a one-line message and fix", async () => {
    const failures = await everyFailure();

    const kinds: LookupFailureKind[] = [
      "unsupported_extension",
      "no_interpreter",
      "sdk_missing",
      "sdk_too_old",
      "sdk_missing",
      "sdk_too_old",
      "tsx_missing",
      "tsx_too_old",
      "node_too_old",
    ];
    expect(failures.map((failure) => failure.kind)).toEqual(kinds);
    for (const failure of failures) {
      expect(failure.message.trim()).not.toBe("");
      expect(failure.fix.trim()).not.toBe("");
      expect(failure.message).not.toContain("\n");
      expect(failure.fix).not.toContain("\n");
    }
  });
});
