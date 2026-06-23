import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { displaySkillPath, requireAgent } from "../../agents/index.js";
import { type Writers, defaultWriters, writeJson } from "../../output.js";
import { statusSymbol } from "../../render/status.js";
import { createStyler } from "../../render/style.js";
import { BUILTIN_SKILLS } from "../../skills/registry.js";
import { JSON_OPTION_DESC } from "../shared.js";

/** Dependencies for the testable core of `skills list`. */
export interface RunSkillsListDeps {
  /** Agent whose install status is reported (defaults to `claude` at the CLI layer). */
  agentId: string;
  cwd: string;
  json: boolean;
  writers: Writers;
}

/**
 * Lists the built-in TraceRoot skills and whether each is installed for the
 * chosen agent. In `--json` mode writes a single `{ data: [...] }` document;
 * otherwise writes a readable block matching the CLI's label/value style. No
 * network access.
 */
export function runSkillsList(deps: RunSkillsListDeps): void {
  const { agentId, cwd, json, writers } = deps;
  const agent = requireAgent(agentId);

  const rows = BUILTIN_SKILLS.map((skill) => {
    const targetDir = agent.getSkillInstallPath(cwd, skill.name);
    const installed = existsSync(join(targetDir, "SKILL.md"));
    return { skill, installed, path: displaySkillPath(cwd, targetDir) };
  });

  if (json) {
    writeJson(
      {
        data: rows.map(({ skill, installed, path }) => ({
          name: skill.name,
          description: skill.description,
          bestFor: skill.bestFor,
          agent: agent.id,
          installed,
          path,
        })),
      },
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);

  const blocks = rows.map(({ skill, installed, path }) => {
    const lines = [
      `${statusSymbol(installed ? "pass" : "warn", writers.out)} ${label(skill.name)}`,
      `  ${skill.description}`,
      `  ${label("Best for:")} ${skill.bestFor.join(", ")}`,
      installed
        ? `  ${label(`Installed for ${agent.displayName}:`)} ${path}`
        : `  ${label("Install:")} traceroot skills install ${skill.name} --agent ${agent.id}`,
    ];
    return lines.join("\n");
  });

  // No standalone title — like `status`/`traces get`, output starts with content.
  writers.out.write(`${blocks.join("\n\n")}\n`);
}

export function registerSkillsList(skills: Command): void {
  skills
    .command("list")
    .description("List available TraceRoot skills and their install status")
    .option(
      "--agent <id>",
      "agent to check install status for: claude, codex, or generic",
      "claude",
    )
    .option("--json", JSON_OPTION_DESC)
    .action((_opts, command: Command) => {
      const opts = command.optsWithGlobals();
      runSkillsList({
        agentId: opts.agent as string,
        cwd: process.cwd(),
        json: opts.json === true,
        writers: defaultWriters,
      });
    });
}
