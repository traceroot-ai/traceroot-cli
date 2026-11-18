import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TSX_FLOOR, TS_SDK_FLOOR, findNodeRunner } from "../../src/eval/node.js";

const NODE = "/usr/local/bin/node";
const SDK = "@traceroot-ai/traceroot";

let dir: string;

beforeEach(() => {
  // Real, because `require.resolve` answers with real paths: a temporary
  // folder behind a symlink (macOS's /var) would never compare equal.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tr-eval-node-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * The SDK as released: an exports map with only `.`, so its `package.json`
 * can't be resolved by name, and a nested `dist/package.json` with no name
 * that the search for the package root has to look past.
 */
function installSdk(nodeModules: string, version: string, runner = ""): string {
  const root = join(nodeModules, ...SDK.split("/"));
  write(
    join(root, "package.json"),
    JSON.stringify({
      name: SDK,
      version,
      main: "dist/index.js",
      exports: { ".": { require: "./dist/index.js", import: "./dist/index.js" } },
    }),
  );
  write(join(root, "dist", "package.json"), JSON.stringify({ type: "commonjs" }));
  write(join(root, "dist", "index.js"), "");
  write(join(root, "dist", "eval", "runner.js"), runner);
  return root;
}

/** tsx as released: `.` maps to its loader, which `--import` runs. */
function installTsx(nodeModules: string, version: string, loader = ""): string {
  const root = join(nodeModules, "tsx");
  write(
    join(root, "package.json"),
    JSON.stringify({
      name: "tsx",
      version,
      type: "module",
      exports: { ".": "./dist/loader.mjs", "./package.json": "./package.json" },
    }),
  );
  write(join(root, "dist", "loader.mjs"), loader);
  return root;
}

function evalFile(path: string): string {
  write(path, "");
  return path;
}

describe("finding the runner for a TypeScript or JavaScript evaluation file", () => {
  it("runs the SDK's runner through the tsx the file's folder resolves, with this Node", () => {
    const sdk = installSdk(join(dir, "node_modules"), "0.8.1");
    const tsx = installTsx(join(dir, "node_modules"), "4.19.2");
    const file = evalFile(join(dir, "evals", "x_eval.ts"));

    const found = findNodeRunner(file, "typescript", { execPath: NODE, nodeVersion: "22.12.0" });

    expect(found).toEqual({
      ok: true,
      runner: {
        language: "typescript",
        sdkVersion: "0.8.1",
        argv: [
          NODE,
          "--import",
          pathToFileURL(join(tsx, "dist", "loader.mjs")).href,
          join(sdk, "dist", "eval", "runner.js"),
          file,
        ],
      },
    });
  });

  it("resolves an SDK hoisted to a workspace's root node_modules to that package's root", () => {
    const sdk = installSdk(join(dir, "node_modules"), "0.8.0");
    installTsx(join(dir, "node_modules"), "4.19.2");
    write(join(dir, "packages", "app", "package.json"), JSON.stringify({ name: "app" }));
    const file = evalFile(join(dir, "packages", "app", "evals", "x_eval.mjs"));

    const found = findNodeRunner(file, "javascript", { nodeVersion: "22.12.0" });

    expect(found.ok && found.runner.argv[3]).toBe(join(sdk, "dist", "eval", "runner.js"));
    expect(found.ok && found.runner.sdkVersion).toBe("0.8.0");
  });

  it("runs from a monorepo root when tsx is installed only beside the evaluation", () => {
    // Node resolves a bare `--import tsx` from the working directory, so from
    // the root this tsx is not found; its file URL is found from anywhere. The
    // space in the folder name is there for the URL to encode.
    const root = join(dir, "mono repo");
    const app = join(root, "packages", "app");
    installSdk(
      join(app, "node_modules"),
      "0.8.1",
      "console.log(JSON.stringify({ loaded: globalThis.__tsxLoaded === true, file: process.argv[2] }));\n",
    );
    installTsx(join(app, "node_modules"), "4.19.2", "globalThis.__tsxLoaded = true;\n");
    const file = evalFile(join(app, "evals", "x_eval.ts"));

    const found = findNodeRunner(file, "typescript");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const [program, ...args] = found.runner.argv as [string, ...string[]];
    const env = { PATH: process.env.PATH ?? "" };

    const run = spawnSync(program, args, { cwd: root, env, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ loaded: true, file });

    const bare = spawnSync(program, ["--import", "tsx", ...args.slice(2)], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("ERR_MODULE_NOT_FOUND");
  });
});

describe("refusing what can't run the evaluation", () => {
  it("says how to install the SDK when the file's folder can't load it", () => {
    installTsx(join(dir, "node_modules"), "4.19.2");
    const file = evalFile(join(dir, "x_eval.ts"));

    const found = findNodeRunner(file, "typescript", { nodeVersion: "22.12.0" });

    expect(found).toEqual({
      ok: false,
      failure: {
        kind: "sdk_missing",
        message: `${SDK} is not installed where ${dir} can load it.`,
        fix: `npm i ${SDK}`,
      },
    });
  });

  it("refuses @traceroot-ai/traceroot 0.7.0, naming the installed version and the floor", () => {
    installSdk(join(dir, "node_modules"), "0.7.0");
    installTsx(join(dir, "node_modules"), "4.19.2");
    const file = evalFile(join(dir, "x_eval.ts"));

    const found = findNodeRunner(file, "typescript", { nodeVersion: "22.12.0" });

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.failure.kind).toBe("sdk_too_old");
    expect(found.failure.message).toContain(`${SDK} 0.7.0`);
    expect(found.failure.message).toContain(TS_SDK_FLOOR);
    expect(found.failure.fix).toBe(`npm i ${SDK}@latest`);
  });

  it("tells a project without tsx to install it, for JavaScript files too", () => {
    installSdk(join(dir, "node_modules"), "0.8.1");
    for (const [name, language] of [
      ["x_eval.ts", "typescript"],
      ["x_eval.mjs", "javascript"],
    ] as const) {
      const file = evalFile(join(dir, name));

      const found = findNodeRunner(file, language, { nodeVersion: "22.12.0" });

      expect(found.ok).toBe(false);
      if (found.ok) return;
      expect(found.failure.kind).toBe("tsx_missing");
      expect(found.failure.fix).toBe("npm i -D tsx");
    }
  });

  it("refuses a tsx below the floor with the upgrade fix, and accepts the floor itself", () => {
    installSdk(join(dir, "node_modules"), "0.8.1");
    const tsx = installTsx(join(dir, "node_modules"), "4.10.3");
    const file = evalFile(join(dir, "x_eval.ts"));

    const old = findNodeRunner(file, "typescript", { nodeVersion: "22.12.0" });

    expect(old.ok).toBe(false);
    if (old.ok) return;
    expect(old.failure.kind).toBe("tsx_too_old");
    expect(old.failure.message).toContain("tsx 4.10.3");
    expect(old.failure.message).toContain(TSX_FLOOR);
    expect(old.failure.fix).toBe("npm i -D tsx@latest");

    rmSync(tsx, { recursive: true });
    installTsx(join(dir, "node_modules"), TSX_FLOOR);
    expect(findNodeRunner(file, "typescript", { nodeVersion: "22.12.0" }).ok).toBe(true);
  });

  it("refuses Node 20.5, which the CLI starts on, and accepts 20.6", () => {
    installSdk(join(dir, "node_modules"), "0.8.1");
    installTsx(join(dir, "node_modules"), "4.19.2");
    const file = evalFile(join(dir, "x_eval.ts"));

    const old = findNodeRunner(file, "typescript", { nodeVersion: "20.5.1" });

    expect(old).toEqual({
      ok: false,
      failure: {
        kind: "node_too_old",
        message: "Node 20.5.1 can't register tsx's module hooks, which need Node 20.6.0 or later.",
        fix: "Use Node 20.6 or later.",
      },
    });
    expect(findNodeRunner(file, "typescript", { nodeVersion: "20.6.0" }).ok).toBe(true);
  });
});
