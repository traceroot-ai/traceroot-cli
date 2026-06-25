import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectRepo } from "../../src/repo/detect.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tr-detect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(name: string, content = ""): void {
  writeFileSync(join(dir, name), content, "utf8");
}

describe("detectRepo", () => {
  it("detects a Node project from package.json (javascript)", () => {
    touch("package.json", "{}");
    const d = detectRepo(dir);
    expect(d.hasPackageJson).toBe(true);
    expect(d.likelyLanguages).toContain("javascript");
  });

  it("detects TypeScript from tsconfig.json", () => {
    touch("package.json", "{}");
    touch("tsconfig.json", "{}");
    const d = detectRepo(dir);
    expect(d.hasTsconfigJson).toBe(true);
    expect(d.likelyLanguages).toContain("typescript");
  });

  it("detects a Python project from pyproject.toml", () => {
    touch("pyproject.toml", "");
    const d = detectRepo(dir);
    expect(d.hasPyprojectToml).toBe(true);
    expect(d.likelyLanguages).toContain("python");
  });

  it("detects a Python project from requirements.txt", () => {
    touch("requirements.txt", "");
    const d = detectRepo(dir);
    expect(d.hasRequirementsTxt).toBe(true);
    expect(d.likelyLanguages).toContain("python");
  });

  it("detects the package manager from a lockfile (pnpm)", () => {
    touch("package.json", "{}");
    touch("pnpm-lock.yaml", "");
    expect(detectRepo(dir).packageManager).toBe("pnpm");
  });

  it("prefers a Node lockfile over a Python one in mixed repos", () => {
    touch("yarn.lock", "");
    touch("poetry.lock", "");
    expect(detectRepo(dir).packageManager).toBe("yarn");
  });

  it("falls back to pip when requirements.txt is the only Python signal", () => {
    touch("requirements.txt", "");
    expect(detectRepo(dir).packageManager).toBe("pip");
  });

  it("reports no language or manager for an empty directory", () => {
    const d = detectRepo(dir);
    expect(d.likelyLanguages).toHaveLength(0);
    expect(d.packageManager).toBeUndefined();
    expect(d.root).toBe(dir);
  });
});
