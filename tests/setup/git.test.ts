import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IgnoreState } from "../../src/setup/git.js";
import { isPathIgnored, parsePorcelain, withoutOwnWrites } from "../../src/setup/git.js";

const NUL = String.fromCharCode(0);

describe("reading the worktree's changed files", () => {
  it("takes a rename's new path and skips the original", () => {
    // `-z` emits a rename as two records — new path, then old — instead of
    // joining them with a literal " -> " that a filename is allowed to contain.
    const out = `R  new.ts${NUL}old.ts${NUL} M other.ts${NUL}`;
    expect(parsePorcelain(out)).toEqual(["new.ts", "other.ts"]);
  });

  it("keeps a path that itself contains the old separator", () => {
    // The newline form separated a rename's two paths with " -> ", so this
    // filename was silently truncated to "b.ts".
    const out = `?? a -> b.ts${NUL}`;
    expect(parsePorcelain(out)).toEqual(["a -> b.ts"]);
  });

  it("keeps a non-ASCII path verbatim rather than C-quoted", () => {
    // The newline form reports `"caf\\303\\251.ts"` for this path; `-z` does not
    // quote at all, so the name that comes back is the name on disk.
    const out = `?? café.ts${NUL}`;
    expect(parsePorcelain(out)).toEqual(["café.ts"]);
  });

  it("keeps a path with a space, which the old trim would have kept too", () => {
    const out = ` M my file.ts${NUL}`;
    expect(parsePorcelain(out)).toEqual(["my file.ts"]);
  });
});

describe("asking git whether a path is ignored", () => {
  function probe(exitCode: number): Promise<IgnoreState> {
    return isPathIgnored({
      root: "/repo",
      path: "api/.env",
      runProcess: async () => ({
        exitCode,
        output: "",
        durationMs: 0,
        timedOut: false,
        spawnFailed: false,
      }),
      env: {},
    });
  }

  it("reads exit 0 as ignored and exit 1 as not ignored", async () => {
    await expect(probe(0)).resolves.toBe("ignored");
    await expect(probe(1)).resolves.toBe("not-ignored");
  });

  it("reads git's own failure as unknown rather than as not ignored", async () => {
    // 128 is what git exits with outside a repository or on a broken index. The
    // old hand-rolled matcher collapsed this into "not covered", and the caller
    // then dropped the result silently — so a file holding a live API key went
    // unremarked because nobody could tell.
    await expect(probe(128)).resolves.toBe("unknown");
  });

  it("reads a failure to spawn git at all as unknown", async () => {
    // `runProcess` reports 127 when the program could not be started, which is
    // not a statement about the file either.
    await expect(probe(127)).resolves.toBe("unknown");
  });

  it("asks about exactly one path, from the repository root", async () => {
    // `-q` exits 0 when *any* argument is ignored, so a batched call cannot say
    // which one — and `--` keeps a path that starts with a dash a path.
    let seen: { program: string; args: readonly string[]; cwd?: string } | undefined;
    await isPathIgnored({
      root: "/repo",
      path: "api/.env",
      runProcess: async (options) => {
        seen = { program: options.program, args: options.args, cwd: options.cwd };
        return { exitCode: 1, output: "", durationMs: 0, timedOut: false, spawnFailed: false };
      },
      env: {},
    });

    expect(seen?.program).toBe("git");
    expect(seen?.args).toEqual(["--no-optional-locks", "check-ignore", "-q", "--", "api/.env"]);
    expect(seen?.cwd).toBe("/repo");
  });
});

describe("leaving out what setup wrote itself", () => {
  let root: string;
  let skill: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tr-git-own-"));
    skill = join(root, ".claude", "skills", "traceroot-instrument-repo");
    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# skill\n");
    writeFileSync(join(skill, "references", "python-instrument.md"), "# recipe\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("drops a file setup wrote, and anything inside a directory it wrote", () => {
    const own = [skill, join(root, ".env"), join(root, ".traceroot")];
    const changed = [
      ".claude/skills/traceroot-instrument-repo/SKILL.md",
      ".env",
      ".traceroot/",
      "main.py",
    ];
    expect(withoutOwnWrites(root, changed, own)).toEqual(["main.py"]);
  });

  it("drops a new directory that holds nothing but setup's skill", () => {
    // `git status` reports a wholly untracked directory as the directory alone,
    // so a new `.claude/` arrives as one entry above the skill.
    expect(withoutOwnWrites(root, [".claude/"], [skill])).toEqual([]);
  });

  it("keeps that directory once anything else is in it", () => {
    // The agent wrote beside the skill, and `git status` cannot say so.
    writeFileSync(join(root, ".claude", "settings.local.json"), "{}\n");
    expect(withoutOwnWrites(root, [".claude/"], [skill])).toEqual([".claude/"]);
  });

  it("keeps a path that only shares a prefix with one of setup's", () => {
    const own = [join(root, ".env"), join(root, ".traceroot")];
    expect(withoutOwnWrites(root, [".env.local", ".traceroot-old/"], own)).toEqual([
      ".env.local",
      ".traceroot-old/",
    ]);
  });

  it("keeps a directory it cannot read", () => {
    // Nothing on disk to settle it, and a kept entry can only stop a run being
    // failed as having changed nothing.
    expect(withoutOwnWrites(root, ["gone/"], [join(root, "gone", "skill")])).toEqual(["gone/"]);
  });
});
