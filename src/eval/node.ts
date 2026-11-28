import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { meetsNodeFloor } from "../util/index.js";
import type { RunnerLookup } from "./lookup.js";

const SDK = "@traceroot-ai/traceroot";

/** The oldest release this command is tested against. */
export const TS_SDK_FLOOR = "0.8.0";

/**
 * The first tsx whose CommonJS hook resolves the `file://` URL both runner
 * releases pass to `require()` (traceroot-ai/traceroot-ts#187). With 4.10.3 or
 * older, no `.ts`, `.js` or `.mjs` evaluation file loads.
 */
export const TSX_FLOOR = "4.10.4";

/**
 * tsx registers its ESM hooks with `module.register()`, which Node added in
 * 20.6. Below it tsx skips them silently, so an `import()` of a TypeScript
 * module inside an evaluation fails mid-run. The CLI itself starts on 20.3.
 */
export const NODE_FLOOR = "20.6.0";

export interface NodeLookupOptions {
  /** The Node that runs the CLI, and so the runner. */
  execPath?: string;
  nodeVersion?: string;
}

interface InstalledPackage {
  /** What `require` resolves the package name to. */
  entry: string;
  /** The folder holding the package's own `package.json`. */
  root: string;
  version: string;
}

/**
 * Finds the runner for a `.ts`, `.js` or `.mjs` evaluation file and checks
 * the SDK, tsx and Node versions.
 *
 * Every file goes through tsx: the released runner compiles its `import()` of
 * the evaluation file to a `require()` of a `file://` URL, which plain `node`
 * rejects for every file type. tsx is passed by the file URL of the copy the
 * evaluation file's folder resolves, because Node resolves a bare
 * `--import tsx` from the working directory: from a monorepo root, a tsx
 * installed only under `packages/app` is not found at all.
 *
 * @param file absolute path of the evaluation file.
 */
export function findNodeRunner(
  file: string,
  language: "typescript" | "javascript",
  options: NodeLookupOptions = {},
): RunnerLookup {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!meetsNodeFloor(nodeVersion, NODE_FLOOR)) {
    return {
      ok: false,
      failure: {
        kind: "node_too_old",
        message: `Node ${nodeVersion} can't register tsx's module hooks, which need Node ${NODE_FLOOR} or later.`,
        fix: "Use Node 20.6 or later.",
      },
    };
  }

  const resolveFrom = createRequire(file);
  const dir = dirname(file);
  const sdk = findPackage(resolveFrom, SDK);
  if (sdk === null) {
    return {
      ok: false,
      failure: {
        kind: "sdk_missing",
        message: `${SDK} is not installed where ${dir} can load it.`,
        fix: `npm i ${SDK}`,
      },
    };
  }
  if (!meetsNodeFloor(sdk.version, TS_SDK_FLOOR)) {
    return {
      ok: false,
      failure: {
        kind: "sdk_too_old",
        message: `${SDK} ${sdk.version} is installed at ${sdk.root}; running an evaluation needs ${TS_SDK_FLOOR} or later.`,
        fix: `npm i ${SDK}@latest`,
      },
    };
  }

  const tsx = findPackage(resolveFrom, "tsx");
  if (tsx === null) {
    return {
      ok: false,
      failure: {
        kind: "tsx_missing",
        message: `tsx is not installed where ${dir} can load it; evaluation files are loaded through it.`,
        fix: "npm i -D tsx",
      },
    };
  }
  if (!meetsNodeFloor(tsx.version, TSX_FLOOR)) {
    return {
      ok: false,
      failure: {
        kind: "tsx_too_old",
        message: `tsx ${tsx.version} is installed at ${tsx.root}; loading evaluation files needs ${TSX_FLOOR} or later.`,
        fix: "npm i -D tsx@latest",
      },
    };
  }

  return {
    ok: true,
    runner: {
      language,
      sdkVersion: sdk.version,
      argv: [
        options.execPath ?? process.execPath,
        "--import",
        pathToFileURL(tsx.entry).href,
        join(sdk.root, "dist", "eval", "runner.js"),
        file,
      ],
    },
  };
}

/**
 * The package `name` as code in the evaluation file's folder would load it,
 * hoisted installs included.
 *
 * Found through its entry point rather than `<name>/package.json`: the SDK's
 * exports map has only `.`, so its manifest can't be resolved by name. The
 * root is the nearest folder above the entry whose `package.json` has this
 * name, which skips a nested one such as `dist/package.json` declaring a
 * module type.
 */
function findPackage(resolveFrom: NodeJS.Require, name: string): InstalledPackage | null {
  let entry: string;
  try {
    entry = resolveFrom.resolve(name);
  } catch {
    return null;
  }
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const manifest = readManifest(join(dir, "package.json"));
    if (manifest?.name === name) {
      return typeof manifest.version === "string"
        ? { entry, root: dir, version: manifest.version }
        : null;
    }
    if (dirname(dir) === dir) {
      return null;
    }
  }
}

function readManifest(path: string): { name?: unknown; version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}
