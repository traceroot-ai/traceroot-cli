import { CliError } from "../output.js";

/** The first-party skills the CLI knows how to install. This is the allowlist. */
export type BuiltinSkillName = "traceroot-instrument-repo" | "traceroot-quickstart";

/** A first-party TraceRoot skill bundled with the CLI. */
export interface BuiltinSkill {
  name: BuiltinSkillName;
  /** One-line summary shown by `skills list`. */
  description: string;
  /** Short "best for" tags shown by `skills list`. */
  bestFor: string[];
}

/**
 * The built-in skill registry. Ordered for stable `skills list` output. This
 * doubles as the install allowlist: any name not present here is rejected before
 * a path is ever constructed, so a skill name can never drive path traversal.
 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "traceroot-instrument-repo",
    description: "Add TraceRoot tracing to an existing Python or TypeScript/Node.js app.",
    bestFor: ["production apps", "agents", "tools", "LLM calls", "retrieval", "external APIs"],
  },
  {
    name: "traceroot-quickstart",
    description: "Minimal runnable demo that produces one TraceRoot trace.",
    bestFor: ["verifying API keys", "seeing TraceRoot quickly"],
  },
] as const;

/** True when `name` is one of the built-in skills. */
export function isBuiltinSkillName(name: string): name is BuiltinSkillName {
  return BUILTIN_SKILLS.some((skill) => skill.name === name);
}

/**
 * Looks up a built-in skill by name, throwing a {@link CliError} with an
 * actionable list of valid names when it is unknown. Used by every command that
 * accepts a skill argument so an unknown name can never reach the filesystem.
 */
export function requireBuiltinSkill(name: string): BuiltinSkill {
  const skill = BUILTIN_SKILLS.find((s) => s.name === name);
  if (skill === undefined) {
    const known = BUILTIN_SKILLS.map((s) => s.name).join(", ");
    throw new CliError(`Unknown skill '${name}'. Available skills: ${known}.`);
  }
  return skill;
}
