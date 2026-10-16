import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { MIN_SETUP_NODE, meetsNodeFloor, requireSetupNode } from "../src/commands/setup.js";
import { ExitCode, isCliError } from "../src/output.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The specifiers a source file still imports *at runtime*, read with
 * TypeScript's own parser rather than a regex — a string literal that happens
 * to contain an import statement (`setup/task.ts` writes several) is not an
 * import, and only the parser knows the difference.
 *
 * Two forms are left out, both deliberately:
 *
 * - a whole `import type … from "x"` statement, which `verbatimModuleSyntax`
 *   elides from the emitted JavaScript. `import { type X, y }` is *not* elided
 *   and is counted, which is why `setup/machine.ts` still reaches the prompts.
 * - `await import("x")`, which is an expression, not a declaration: it is
 *   loaded only when the code around it runs. That is the whole mechanism
 *   under test.
 */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly === true) continue;
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
    } else {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (specifier !== undefined && ts.isStringLiteral(specifier)) {
      specifiers.push(specifier.text);
    }
  }
  return specifiers;
}

/** The `.ts` file a relative, extensionless-at-runtime specifier resolves to. */
function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    if (existsFile(candidate)) return candidate;
  }
  throw new Error(`${relative(SRC, from)} imports ${specifier}, which resolves to no source file`);
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Breadth-first over the static graph from `entry`, returning the first path
 * that reaches a package matching `pred` — so a failure names the chain to fix
 * rather than only that one exists.
 */
function pathToPackage(entry: string, pred: (specifier: string) => boolean): string[] | null {
  const seen = new Set<string>();
  const queue: Array<[string, string[]]> = [[join(SRC, entry), [entry]]];
  for (let head = queue.shift(); head !== undefined; head = queue.shift()) {
    const [file, trail] = head;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(file)) {
      const local = resolveLocal(file, specifier);
      if (local === null) {
        if (pred(specifier)) return [...trail, specifier];
        continue;
      }
      queue.push([local, [...trail, relative(SRC, local)]]);
    }
  }
  return null;
}

const isPrompts = (specifier: string): boolean => specifier.startsWith("@clack/");

describe("the prompt library stays off the common command path", () => {
  // Every command's startup cost, and its Node floor: `@clack/core` opens with
  // `import { styleText } from "node:util"`, added in Node 20.12, so a static
  // import of the wizard anywhere in this graph took `traceroot traces`,
  // `login`, `status` and `doctor` down on Node 20.11 with a module-resolution
  // error that named none of them.
  for (const entry of ["cli.ts", "commands/index.ts", "commands/setup.ts"]) {
    it(`${entry} does not reach @clack`, () => {
      const trail = pathToPackage(entry, isPrompts);
      expect(trail?.join(" -> ") ?? null).toBeNull();
    });
  }

  it("still finds @clack where it genuinely is, so the walk is not vacuous", () => {
    // The guard on the guard: a walker that silently resolved nothing would
    // pass every assertion above while checking nothing at all.
    expect(pathToPackage("commands/setup/run.ts", isPrompts)).not.toBeNull();
  });

  it("setup's registration reaches the wizard only through a dynamic import", () => {
    const direct = runtimeImports(join(SRC, "commands/setup.ts"));
    expect(direct).not.toContain("./setup/run.js");
    expect(readFileSync(join(SRC, "commands/setup.ts"), "utf8")).toContain(
      'await import("./setup/run.js")',
    );
  });
});

describe("the Node floor setup checks for itself", () => {
  it("rejects the runtime that cannot load the prompts", () => {
    expect(meetsNodeFloor("20.11.1", MIN_SETUP_NODE)).toBe(false);
    expect(meetsNodeFloor("18.20.4", MIN_SETUP_NODE)).toBe(false);
    expect(meetsNodeFloor("20.9.0", MIN_SETUP_NODE)).toBe(false);
  });

  it("accepts the floor itself and anything above it", () => {
    expect(meetsNodeFloor(MIN_SETUP_NODE, MIN_SETUP_NODE)).toBe(true);
    expect(meetsNodeFloor("20.12.1", MIN_SETUP_NODE)).toBe(true);
    expect(meetsNodeFloor("20.13.0", MIN_SETUP_NODE)).toBe(true);
    expect(meetsNodeFloor("22.23.1", MIN_SETUP_NODE)).toBe(true);
    expect(meetsNodeFloor("24.0.0", MIN_SETUP_NODE)).toBe(true);
  });

  it("names the floor, the runtime and what still works, as a usage error", () => {
    let thrown: unknown;
    try {
      requireSetupNode("20.11.1");
    } catch (err) {
      thrown = err;
    }
    expect(isCliError(thrown)).toBe(true);
    const error = thrown as Error & { exitCode: number };
    expect(error.exitCode).toBe(ExitCode.usage);
    expect(error.message).toContain(MIN_SETUP_NODE);
    expect(error.message).toContain("20.11.1");
    expect(error.message).toContain("every other traceroot command");
  });

  it("passes on this runtime, which the rest of the suite depends on", () => {
    expect(() => requireSetupNode()).not.toThrow();
  });

  it("is at least the floor @clack declares for itself", () => {
    // If the prompts raise their floor, the message setup prints is wrong, and
    // this is where that is discovered rather than in a user's terminal.
    const require = createRequire(import.meta.url);
    const declared = JSON.parse(
      readFileSync(require.resolve("@clack/core/package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    const floor = (declared.engines?.node ?? "").replace(/[^\d.]/g, "");
    expect(floor).not.toBe("");
    expect(meetsNodeFloor(MIN_SETUP_NODE, floor)).toBe(true);
  });
});

describe("the package's own engines floor", () => {
  it("is the floor every command shares, not setup's", () => {
    // `engines` only makes npm warn, so it is a claim about the package, not a
    // check. Claiming setup's 20.12 for the whole CLI turned away installs that
    // work; the one real package-wide floor is the registry client's
    // `AbortSignal.any`, added in Node 20.3.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(">=20.3");
    expect(meetsNodeFloor(MIN_SETUP_NODE, pkg.engines.node.replace(/[^\d.]/g, ""))).toBe(true);
  });
});
