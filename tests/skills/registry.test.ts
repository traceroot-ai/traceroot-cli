import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../../src/output.js";
import {
  builtinSkills,
  isBuiltinSkillName,
  parseSkillManifest,
  requireBuiltinSkill,
} from "../../src/skills/registry.js";

/** An entry as the vendored assets/skills/manifest.json carries it. */
interface ManifestEntry {
  name: string;
  description: string;
  bestFor: string[];
  bundledWithCli: boolean;
}

const entry = (name: string, overrides: Partial<ManifestEntry> = {}): ManifestEntry => ({
  name,
  description: `prose for ${name}`,
  bestFor: [`tag for ${name}`],
  bundledWithCli: true,
  ...overrides,
});

const manifestOf = (...skills: unknown[]): string => JSON.stringify({ version: 1, skills });

const ALLOWLIST = manifestOf(entry("traceroot-instrument-repo"), entry("traceroot-quickstart"));

describe("skills registry", () => {
  it("lists both built-in skills with descriptions and bestFor tags", () => {
    const names = builtinSkills().map((s) => s.name);
    expect(names).toContain("traceroot-instrument-repo");
    expect(names).toContain("traceroot-quickstart");
    for (const skill of builtinSkills()) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.bestFor.length).toBeGreaterThan(0);
    }
  });

  it("recognizes known names and rejects unknown ones", () => {
    expect(isBuiltinSkillName("traceroot-quickstart")).toBe(true);
    expect(isBuiltinSkillName("nope")).toBe(false);
    // A traversal attempt is just an unknown name — never a path.
    expect(isBuiltinSkillName("../evil")).toBe(false);
  });

  it("requireBuiltinSkill returns the skill for a valid name", () => {
    expect(requireBuiltinSkill("traceroot-quickstart").name).toBe("traceroot-quickstart");
  });

  it("requireBuiltinSkill throws an actionable CliError for an unknown name", () => {
    try {
      requireBuiltinSkill("../../etc/passwd");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("Unknown skill");
      expect((err as CliError).message).toContain("traceroot-instrument-repo");
    }
  });
});

describe("skills registry prose", () => {
  it("takes description and bestFor verbatim from the vendored manifest", () => {
    const path = fileURLToPath(new URL("../../assets/skills/manifest.json", import.meta.url));
    const vendored = JSON.parse(readFileSync(path, "utf8")) as { skills: ManifestEntry[] };
    for (const skill of builtinSkills()) {
      const source = vendored.skills.find((s) => s.name === skill.name);
      expect(source).toBeDefined();
      expect(skill.description).toBe(source?.description);
      expect(skill.bestFor).toEqual(source?.bestFor);
    }
  });

  it("orders the registry by the hand-written list, not by manifest order", () => {
    expect(builtinSkills().map((s) => s.name)).toEqual([
      "traceroot-instrument-repo",
      "traceroot-quickstart",
    ]);
    // Manifest order does not reach the output: reversing it changes nothing.
    const reversed = manifestOf(entry("traceroot-quickstart"), entry("traceroot-instrument-repo"));
    expect(parseSkillManifest(reversed).map((s) => s.name)).toEqual([
      "traceroot-instrument-repo",
      "traceroot-quickstart",
    ]);
  });

  it("memoizes the registry across calls", () => {
    expect(builtinSkills()).toBe(builtinSkills());
  });
});

describe("parseSkillManifest", () => {
  it("accepts a manifest describing exactly the allowlist", () => {
    const skills = parseSkillManifest(ALLOWLIST);
    expect(skills.map((s) => s.name)).toEqual([
      "traceroot-instrument-repo",
      "traceroot-quickstart",
    ]);
    expect(skills[0]?.description).toBe("prose for traceroot-instrument-repo");
    expect(skills[0]?.bestFor).toEqual(["tag for traceroot-instrument-repo"]);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseSkillManifest("{ not json")).toThrow(CliError);
    expect(() => parseSkillManifest("{ not json")).toThrow(/unreadable/);
  });

  it("rejects a manifest with no skills array", () => {
    expect(() => parseSkillManifest('{"version":1}')).toThrow(/unreadable/);
    expect(() => parseSkillManifest('{"version":1,"skills":{}}')).toThrow(/unreadable/);
  });

  it("rejects an entry that is missing its prose", () => {
    const noDescription = manifestOf(
      { name: "traceroot-instrument-repo", bestFor: ["x"] },
      entry("traceroot-quickstart"),
    );
    expect(() => parseSkillManifest(noDescription)).toThrow(/unreadable/);

    const badBestFor = manifestOf(
      entry("traceroot-instrument-repo", { bestFor: ["ok", 7] as unknown as string[] }),
      entry("traceroot-quickstart"),
    );
    expect(() => parseSkillManifest(badBestFor)).toThrow(/unreadable/);
  });

  it("rejects a manifest that disagrees with the hand-written allowlist", () => {
    // One short.
    expect(() => parseSkillManifest(manifestOf(entry("traceroot-instrument-repo")))).toThrow(
      /does not match this build/,
    );
    // One too many.
    const extra = manifestOf(
      entry("traceroot-instrument-repo"),
      entry("traceroot-quickstart"),
      entry("traceroot-eval"),
    );
    expect(() => parseSkillManifest(extra)).toThrow(/does not match this build/);
    // Right count, wrong names — the case a length check alone would miss.
    const swapped = manifestOf(entry("traceroot-instrument-repo"), entry("traceroot-eval"));
    expect(() => parseSkillManifest(swapped)).toThrow(/does not match this build/);
  });

  it("rejects a duplicate entry rather than letting the later prose win", () => {
    // Three entries, two names: the prose map keys on the name, so unique-key
    // counting alone sees the expected size and finds every allowlisted name.
    // Only an explicit duplicate check rejects this, and without one the second
    // copy's description silently replaces the first.
    const twice = manifestOf(
      entry("traceroot-instrument-repo"),
      entry("traceroot-instrument-repo", { description: "second copy wins" }),
      entry("traceroot-quickstart"),
    );
    expect(() => parseSkillManifest(twice)).toThrow(CliError);
    expect(() => parseSkillManifest(twice)).toThrow(/does not match this build/);
  });
});

describe("builtinSkills caching", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  /**
   * The module memoises on a module-level binding, so each scenario needs a
   * fresh instance: `vi.resetModules()` plus a dynamic import gives one, and
   * mocking `readFileSync` drives the failure without touching
   * `assets/skills/manifest.json`, which other test files read concurrently.
   *
   * `output.js` comes back from the same fresh graph, because the reset gives
   * that module a new instance too — so its `CliError` is a different class
   * object from the one imported at the top of this file, and only the one
   * returned here can be asserted with `toThrow`.
   */
  const loadRegistry = async (readFileSync: () => string) => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs")>()),
      readFileSync,
    }));
    return {
      ...(await import("../../src/skills/registry.js")),
      CliError: (await import("../../src/output.js")).CliError,
    };
  };

  it("reports a missing manifest as an actionable CliError", async () => {
    const registry = await loadRegistry(() => {
      throw new Error("ENOENT");
    });
    expect(() => registry.builtinSkills()).toThrow(registry.CliError);
    expect(() => registry.builtinSkills()).toThrow(/missing from this install/);
  });

  it("does not cache a failure, so a later read recovers", async () => {
    let fail = true;
    const registry = await loadRegistry(() => {
      if (fail) {
        throw new Error("ENOENT");
      }
      return ALLOWLIST;
    });

    expect(() => registry.builtinSkills()).toThrow(/missing from this install/);

    // A reinstall puts the manifest back; the next call must retry rather than
    // serve a cached failure.
    fail = false;
    expect(registry.builtinSkills().map((s) => s.name)).toEqual([
      "traceroot-instrument-repo",
      "traceroot-quickstart",
    ]);
  });

  it("caches a success, so a later unreadable manifest does not break a live process", async () => {
    let raw = ALLOWLIST;
    const registry = await loadRegistry(() => raw);

    const first = registry.builtinSkills();
    raw = "{ not json";
    expect(registry.builtinSkills()).toBe(first);
  });
});
