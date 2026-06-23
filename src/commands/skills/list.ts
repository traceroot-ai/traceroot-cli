import type { Command } from "commander";
import { type Writers, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { BUILTIN_SKILLS } from "../../skills/registry.js";

/** Dependencies for the testable core of `skills list`. */
export interface RunSkillsListDeps {
  json: boolean;
  writers: Writers;
}

/**
 * Lists the built-in TraceRoot skills. In `--json` mode writes a single
 * `{ data: [...] }` document to stdout; otherwise writes a readable block. No
 * network or filesystem access.
 */
export function runSkillsList(deps: RunSkillsListDeps): void {
  const { json, writers } = deps;

  if (json) {
    writeJson(
      {
        data: BUILTIN_SKILLS.map((skill) => ({
          name: skill.name,
          description: skill.description,
          bestFor: skill.bestFor,
        })),
      },
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  const blocks = BUILTIN_SKILLS.map((skill) =>
    [
      styler.bold(skill.name),
      `  ${skill.description}`,
      `  ${styler.dim(`Best for: ${skill.bestFor.join(", ")}.`)}`,
    ].join("\n"),
  );
  writers.out.write(`${styler.bold("Available TraceRoot skills")}\n\n${blocks.join("\n\n")}\n`);
}

export function registerSkillsList(skills: Command): void {
  skills
    .command("list")
    .description("List available TraceRoot skills")
    .action((_opts, command: Command) => {
      const json = command.optsWithGlobals().json === true;
      runSkillsList({ json, writers: defaultWriters });
    });
}
