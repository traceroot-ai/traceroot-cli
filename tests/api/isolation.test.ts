import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Collects all files matching `exts` under `dir` (recursively). */
function collect(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((rel) => join(dir, rel))
    .filter((p) => exts.some((e) => p.endsWith(e)));
}

/** Extracts import/export specifiers (the quoted module path) from source. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^'"]*?from\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    if (m[1]) specs.push(m[1]);
  }
  // Also bare `import "x"` side-effect imports.
  for (const m of source.matchAll(/import\s*["']([^"']+)["']/g)) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

const FORBIDDEN = ["traceroot/backend", "backend/rest", "../traceroot", "/traceroot/backend"];

describe("no backend monorepo imports", () => {
  const srcFiles = collect(join(root, "src"), [".ts"]);
  const distFiles = collect(join(root, "dist"), [".js"]);
  const files = [...srcFiles, ...distFiles];

  it("scans at least the src tree", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} has no forbidden backend import specifier`, () => {
      const specs = importSpecifiers(readFileSync(file, "utf8"));
      for (const spec of specs) {
        for (const bad of FORBIDDEN) {
          expect(spec.includes(bad)).toBe(false);
        }
      }
    });
  }
});

describe("generated import boundary", () => {
  it("only src/api/client.ts imports from api/generated", () => {
    const srcFiles = collect(join(root, "src"), [".ts"]);
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const specs = importSpecifiers(readFileSync(file, "utf8"));
      const importsGenerated = specs.some((s) => s.includes("api/generated"));
      if (importsGenerated && !file.replace(/\\/g, "/").endsWith("src/api/client.ts")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
