import { describe, expect, it } from "vitest";
import { parsePorcelain } from "../../src/setup/git.js";

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
