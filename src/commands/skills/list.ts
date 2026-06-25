import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { ALL_AGENTS, displaySkillPath } from "../../agents/index.js";
import { type Writers, defaultWriters, writeJson } from "../../output.js";
import { statusSymbol } from "../../render/status.js";
import { createStyler } from "../../render/style.js";
import { BUILTIN_SKILLS } from "../../skills/registry.js";

/** Dependencies for the testable core of `skills list`. */
export interface RunSkillsListDeps {
  cwd: string;
  json: boolean;
  writers: Writers;
}

/** Per-agent install status for a skill, in the stable `claude, codex, generic` order. */
interface AgentStatus {
  agent: string;
  displayName: string;
  installed: boolean;
  path: string;
}

/** Evaluates a skill's install status across every supported agent. */
function evaluateAgents(cwd: string, skillName: string): AgentStatus[] {
  return ALL_AGENTS.map((agent) => {
    const targetDir = agent.getSkillInstallPath(cwd, skillName);
    return {
      agent: agent.id,
      displayName: agent.displayName,
      installed: existsSync(join(targetDir, "SKILL.md")),
      path: displaySkillPath(cwd, targetDir),
    };
  });
}

/**
 * Lists the built-in TraceRoot skills and, for each, whether it is installed for
 * any supported agent (Claude Code, Codex, generic). Human output is compact —
 * the top marker is ✓ when installed for at least one agent, and only the agents
 * where it is actually installed are listed. `--json` includes the full per-agent
 * state regardless. No network access.
 */
export function runSkillsList(deps: RunSkillsListDeps): void {
  const { cwd, json, writers } = deps;

  const rows = BUILTIN_SKILLS.map((skill) => {
    const agents = evaluateAgents(cwd, skill.name);
    return { skill, agents, installed: agents.some((a) => a.installed) };
  });

  if (json) {
    writeJson(
      {
        data: rows.map(({ skill, agents, installed }) => ({
          name: skill.name,
          description: skill.description,
          bestFor: skill.bestFor,
          installed,
          agents,
        })),
      },
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);

  const blocks = rows.map(({ skill, agents, installed }) => {
    const lines = [
      `${statusSymbol(installed ? "pass" : "warn", writers.out)} ${label(skill.name)}`,
      `  ${skill.description}`,
      `  ${label("Best for:")} ${skill.bestFor.join(", ")}`,
    ];

    const installedAgents = agents.filter((a) => a.installed);
    if (installedAgents.length > 0) {
      // Pad display names (raw, before color) so the dimmed paths align.
      const width = Math.max(...installedAgents.map((a) => a.displayName.length));
      lines.push(`  ${label("Installed:")}`);
      for (const a of installedAgents) {
        const name = a.displayName.padEnd(width);
        lines.push(`    ${statusSymbol("pass", writers.out)} ${name}  ${styler.dim(a.path)}`);
      }
    } else {
      lines.push(`  ${label("Install:")} traceroot skills install ${skill.name}`);
    }

    return lines.join("\n");
  });

  // No standalone title — like `status`/`traces get`, output starts with content.
  writers.out.write(`${blocks.join("\n\n")}\n`);
}

export function registerSkillsList(skills: Command): void {
  skills
    .command("list")
    .description("List available TraceRoot skills and their install status")
    .action((_opts, command: Command) => {
      const opts = command.optsWithGlobals();
      runSkillsList({
        cwd: process.cwd(),
        json: opts.json === true,
        writers: defaultWriters,
      });
    });
}
