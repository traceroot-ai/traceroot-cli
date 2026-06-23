import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/output.js";
import { bundledSkillDir } from "../../src/skills/bundled.js";
import { installBundledSkill } from "../../src/skills/install.js";

let root: string;
const source = bundledSkillDir("traceroot-quickstart");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tr-install-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("installBundledSkill", () => {
  it("creates parent directories and copies SKILL.md and references", () => {
    const target = join(root, ".claude", "skills", "traceroot-quickstart");
    const result = installBundledSkill({
      sourceDir: source,
      targetDir: target,
      force: false,
      dryRun: false,
    });

    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    expect(result.files).toContain("SKILL.md");
    expect(result.files.some((f) => f.startsWith("references/"))).toBe(true);
    expect(result.overwritten).toBe(false);
  });

  it("does not overwrite an existing directory without force", () => {
    const target = join(root, "skill");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel.txt"), "keep", "utf8");

    expect(() =>
      installBundledSkill({ sourceDir: source, targetDir: target, force: false, dryRun: false }),
    ).toThrow(CliError);
    // The existing content is left untouched.
    expect(readFileSync(join(target, "sentinel.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(target, "SKILL.md"))).toBe(false);
  });

  it("overwrites an existing directory with force and reports overwritten", () => {
    const target = join(root, "skill");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale.txt"), "old", "utf8");

    const result = installBundledSkill({
      sourceDir: source,
      targetDir: target,
      force: true,
      dryRun: false,
    });
    expect(result.overwritten).toBe(true);
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    // The stale file is gone — the directory was replaced, not merged.
    expect(existsSync(join(target, "stale.txt"))).toBe(false);
  });

  it("writes nothing in dry-run mode but still reports the file plan", () => {
    const target = join(root, ".claude", "skills", "traceroot-quickstart");
    const result = installBundledSkill({
      sourceDir: source,
      targetDir: target,
      force: false,
      dryRun: true,
    });

    expect(existsSync(target)).toBe(false);
    expect(result.files).toContain("SKILL.md");
  });

  it("leaves no temp directory behind after a successful install", () => {
    const target = join(root, "skill");
    installBundledSkill({ sourceDir: source, targetDir: target, force: false, dryRun: false });
    const leftovers = readdirSync(root).filter((n) => n.includes(".tmp"));
    expect(leftovers).toHaveLength(0);
  });

  it("refuses to install a bundle containing a symlink", () => {
    const evilSource = join(root, "evil");
    mkdirSync(evilSource, { recursive: true });
    writeFileSync(join(evilSource, "SKILL.md"), "# ok", "utf8");
    symlinkSync("/etc/passwd", join(evilSource, "leak.md"));

    expect(() =>
      installBundledSkill({
        sourceDir: evilSource,
        targetDir: join(root, "out"),
        force: false,
        dryRun: false,
      }),
    ).toThrow(/symlink/i);
  });
});
