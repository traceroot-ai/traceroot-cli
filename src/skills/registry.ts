import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliError, ExitCode } from "../output.js";

/** The first-party skills the CLI knows how to install. This is the allowlist. */
export type BuiltinSkillName = "traceroot-instrument-repo" | "traceroot-quickstart";

/**
 * The built-in skill names, ordered for stable `skills list` output. Stays
 * hand-written alongside {@link BuiltinSkillName}: together they are the install
 * allowlist and a security boundary — what stops a skill name driving path
 * traversal before a path is ever constructed — so they remain a reviewed,
 * compile-time closed set. Only the prose is read from the vendored manifest,
 * because only the prose was duplicated.
 */
const BUILTIN_SKILL_NAMES = [
  "traceroot-instrument-repo",
  "traceroot-quickstart",
] as const satisfies readonly BuiltinSkillName[];

/**
 * Compile-time proof that the list above covers the whole union. `satisfies`
 * above gives one direction — no entry may be a name the union rejects — and
 * this gives the other: a name added to {@link BuiltinSkillName} without an
 * entry survives the `Exclude`, breaks the `extends never` constraint, and fails
 * `npm run typecheck`. Worth asserting because the union and the list are two
 * declarations that nothing else here compares: a union member missing from the
 * list still compiles and is then simply unreachable — {@link isBuiltinSkillName}
 * answers from the list, so `skills install` rejects the name as unknown and
 * `skills list` never shows it.
 */
type AssertNever<T extends never> = T;
type BuiltinSkillNamesCoverUnion = AssertNever<
  Exclude<BuiltinSkillName, (typeof BUILTIN_SKILL_NAMES)[number]>
>;

/** A first-party TraceRoot skill bundled with the CLI. */
export interface BuiltinSkill {
  name: BuiltinSkillName;
  /** One-line summary shown by `skills list`. */
  description: string;
  /** Short "best for" tags shown by `skills list`. */
  bestFor: string[];
}

const MANIFEST_MISSING =
  "Bundled skill manifest is missing from this install. Reinstall traceroot-cli.";
const MANIFEST_UNREADABLE =
  "Bundled skill manifest is unreadable in this install. Reinstall traceroot-cli.";
const MANIFEST_MISMATCH =
  "Bundled skill manifest does not match this build of traceroot-cli. Reinstall traceroot-cli.";

/** The prose fields this module reads out of a manifest entry. */
interface SkillProse {
  description: string;
  bestFor: string[];
}

/**
 * Narrows one raw manifest entry, returning `undefined` for anything that is not
 * a named entry carrying both prose fields.
 */
function readEntry(value: unknown): { name: string; prose: SkillProse } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const { name, description, bestFor } = entry;
  if (typeof name !== "string" || typeof description !== "string") {
    return undefined;
  }
  if (!Array.isArray(bestFor) || !bestFor.every((tag) => typeof tag === "string")) {
    return undefined;
  }
  return { name, prose: { description, bestFor: bestFor as string[] } };
}

/**
 * Validates one vendored manifest's text and pairs it with the allowlist above.
 * Split out from {@link loadBuiltinSkills} so every rejection below is reachable
 * from a test without doctoring an installed package.
 */
export function parseSkillManifest(raw: string): readonly BuiltinSkill[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(MANIFEST_UNREADABLE);
  }

  const skills = (parsed as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) {
    throw new CliError(MANIFEST_UNREADABLE);
  }

  const prose = new Map<string, SkillProse>();
  for (const value of skills) {
    const entry = readEntry(value);
    if (entry === undefined) {
      throw new CliError(MANIFEST_UNREADABLE);
    }
    // Before inserting: a second entry for a name would replace the first one's
    // prose, and the size check below counts unique keys, so a duplicate paired
    // with a missing entry would balance out and pass.
    if (prose.has(entry.name)) {
      throw new CliError(MANIFEST_MISMATCH);
    }
    prose.set(entry.name, entry.prose);
  }

  // The manifest must describe exactly the allowlist above, in both directions:
  // a missing entry would leave a skill with no prose, and an extra one means
  // the vendored assets and this build disagree about what the CLI ships.
  if (prose.size !== BUILTIN_SKILL_NAMES.length) {
    throw new CliError(MANIFEST_MISMATCH);
  }
  return BUILTIN_SKILL_NAMES.map((name) => {
    const entry = prose.get(name);
    if (entry === undefined) {
      throw new CliError(MANIFEST_MISMATCH);
    }
    return { name, description: entry.description, bestFor: entry.bestFor };
  });
}

/**
 * Reads the prose for every built-in skill from the manifest vendored beside
 * the skill assets, which the skills repository authors and
 * `npm run skills:refresh` copies in. Like {@link bundledSkillDir}, this is
 * filesystem work done at call time, so a package installed without its assets
 * raises a {@link CliError} rather than a raw fs or syntax error.
 */
function loadBuiltinSkills(): readonly BuiltinSkill[] {
  const path = fileURLToPath(new URL("../../assets/skills/manifest.json", import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CliError(MANIFEST_MISSING);
  }
  return parseSkillManifest(raw);
}

let cached: readonly BuiltinSkill[] | undefined;

/**
 * The built-in skill registry, ordered for stable `skills list` output. Memoised
 * after the first successful read; a failure is not cached, so a reinstall takes
 * effect without restarting.
 */
export function builtinSkills(): readonly BuiltinSkill[] {
  cached ??= loadBuiltinSkills();
  return cached;
}

/**
 * True when `name` is one of the built-in skills. Answered from the hand-written
 * allowlist alone — it never reads the manifest, so a rejected name stays
 * rejected even in an install missing its assets.
 */
export function isBuiltinSkillName(name: string): name is BuiltinSkillName {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name);
}

/**
 * Looks up a built-in skill by name, throwing a {@link CliError} with an
 * actionable list of valid names when it is unknown. Used by every command that
 * accepts a skill argument so an unknown name can never reach the filesystem.
 */
export function requireBuiltinSkill(name: string): BuiltinSkill {
  if (!isBuiltinSkillName(name)) {
    throw new CliError(
      `Unknown skill '${name}'. Choose one of: ${builtinSkillNames()}.`,
      ExitCode.usage,
    );
  }
  const skill = builtinSkills().find((s) => s.name === name);
  if (skill === undefined) {
    throw new CliError(MANIFEST_MISMATCH);
  }
  return skill;
}

/** Comma-joined list of the built-in skill names, for actionable messages. */
export function builtinSkillNames(): string {
  return BUILTIN_SKILL_NAMES.join(", ");
}
