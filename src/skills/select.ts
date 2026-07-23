import { CliError, ExitCode, type Writers, logInfo } from "../output.js";
import { type Prompt, dim, isInteractive, readLine } from "../prompt.js";
import { createStyler } from "../render/style.js";
import {
  BUILTIN_SKILLS,
  type BuiltinSkill,
  builtinSkillNames,
  requireBuiltinSkill,
} from "./registry.js";

/** The skill chosen when the user presses Enter at the prompt (primary path). */
const DEFAULT_SKILL = "traceroot-instrument-repo";

/** Inputs for {@link resolveSkillOrPrompt}. `prompt`/`isInteractive` are injectable for tests. */
export interface ResolveSkillInput {
  /** The `<skill>` argument, if the user supplied one. */
  skillName?: string;
  /** JSON mode never prompts — it fails fast instead. */
  json: boolean;
  writers: Writers;
  /** Defaults to "stdin and stdout are both TTYs". */
  isInteractive?: boolean;
  /** Reads one line from the user; defaults to a readline prompt on stdout. */
  prompt?: Prompt;
}

/**
 * Renders the built-in skills as an aligned, multi-line list (bold name +
 * description). Padding is computed from the raw (unstyled) name so the bold
 * ANSI codes never disturb column alignment.
 */
function availableSkillsList(writers: Writers): string {
  const styler = createStyler(writers.err);
  const width = Math.max(...BUILTIN_SKILLS.map((s) => s.name.length));
  const rows = BUILTIN_SKILLS.map(
    (s) => `  ${styler.bold(s.name)}${" ".repeat(width + 2 - s.name.length)}${s.description}`,
  );
  return ["Available skills:", ...rows].join("\n");
}

/**
 * Resolves the target skill. When `<skill>` was supplied it is validated exactly
 * as before (`requireBuiltinSkill`). When it is missing: in an interactive TTY
 * the available skills are listed and the user is asked for one (Enter accepts
 * the default, `traceroot-instrument-repo`); in non-interactive or `--json` mode
 * no prompt is shown and a {@link CliError} with the valid names is thrown.
 */
export async function resolveSkillOrPrompt(input: ResolveSkillInput): Promise<BuiltinSkill> {
  const { skillName, json, writers } = input;

  if (skillName !== undefined) {
    return requireBuiltinSkill(skillName);
  }

  const interactive = input.isInteractive ?? isInteractive();

  if (json || !interactive) {
    throw new CliError(
      `Missing required argument <skill>.\nChoose one of: ${builtinSkillNames()}.\nExample:\n  traceroot skills install traceroot-instrument-repo`,
      ExitCode.usage,
    );
  }

  // List the skills first, then a compact prompt (the options aren't repeated inline).
  logInfo(availableSkillsList(writers), writers);
  const prompt = input.prompt ?? readLine;
  const answer = (await prompt(`Skill ${dim(`(default: ${DEFAULT_SKILL})`)}: `)).trim();
  return requireBuiltinSkill(answer === "" ? DEFAULT_SKILL : answer);
}
