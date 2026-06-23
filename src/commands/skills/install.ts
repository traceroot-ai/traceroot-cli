import type { Command } from "commander";
import { displaySkillPath, requireAgent } from "../../agents/index.js";
import type { AgentAdapter } from "../../agents/types.js";
import { type Writers, defaultWriters, logInfo, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { bundledSkillDir } from "../../skills/bundled.js";
import { installBundledSkill } from "../../skills/install.js";
import { type BuiltinSkill, requireBuiltinSkill } from "../../skills/registry.js";
import { withGlobalJsonHelp } from "../shared.js";

/** Dependencies for the testable core of `skills install`. */
export interface RunSkillsInstallDeps {
  skillName: string;
  agentId: string;
  cwd: string;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  writers: Writers;
}

/** The recommended follow-up command after installing a skill. */
function nextStep(skill: BuiltinSkill, agent: AgentAdapter): string {
  if (skill.name === "traceroot-instrument-repo") {
    return `traceroot instrument --agent ${agent.id} --print`;
  }
  return agent.getUsageHint(skill.name);
}

/**
 * Installs a built-in skill into an agent's project-local skill directory.
 * Validates the skill and agent names against their allowlists before touching
 * the filesystem, never overwrites without `--force`, and writes nothing in
 * `--dry-run` mode. Emits `{ data: {...} }` in `--json` mode.
 */
export function runSkillsInstall(deps: RunSkillsInstallDeps): void {
  const { skillName, agentId, cwd, force, dryRun, json, writers } = deps;

  const skill = requireBuiltinSkill(skillName);
  const agent = requireAgent(agentId);
  const sourceDir = bundledSkillDir(skill.name);
  const targetDir = agent.getSkillInstallPath(cwd, skill.name);

  const result = installBundledSkill({ sourceDir, targetDir, force, dryRun });
  const displayPath = displaySkillPath(cwd, targetDir);

  if (json) {
    if (dryRun) {
      writeJson(
        {
          data: {
            skill: skill.name,
            agent: agent.id,
            path: displayPath,
            installed: false,
            overwritten: result.overwritten,
            dryRun: true,
            files: result.files,
          },
        },
        writers,
      );
    } else {
      writeJson(
        {
          data: {
            skill: skill.name,
            agent: agent.id,
            path: displayPath,
            installed: true,
            overwritten: result.overwritten,
          },
        },
        writers,
      );
    }
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);

  // Label/value block matching `status`/`get`/`login`: bold labels, values on
  // the same line, aligned. Next-step hint goes to stderr like `login`.
  if (dryRun) {
    const lines = [
      "Dry run: would install TraceRoot skill",
      "",
      `${label("Skill:")}  ${skill.name}`,
      `${label("Agent:")}  ${agent.displayName}`,
      `${label("Path:")}   ${displayPath}${result.overwritten ? " (exists; --force required)" : ""}`,
      "",
      label("Files:"),
      ...result.files.map((f) => `  ${f}`),
    ];
    writers.out.write(`${lines.join("\n")}\n`);
    return;
  }

  const lines = [
    "Installed TraceRoot skill",
    "",
    `${label("Skill:")}  ${skill.name}`,
    `${label("Agent:")}  ${agent.displayName}`,
    `${label("Path:")}   ${displayPath}`,
  ];
  writers.out.write(`${lines.join("\n")}\n`);
  if (result.overwritten) {
    logInfo("Overwrote an existing skill directory.", writers);
  }
  logInfo(`\nNext: ${nextStep(skill, agent)}`, writers);
}

export function registerSkillsInstall(skills: Command): void {
  withGlobalJsonHelp(
    skills
      .command("install")
      .argument("<skill>", "skill name (see `traceroot skills list`)")
      .requiredOption("--agent <id>", "target agent: claude, codex, or generic")
      .option("--force", "overwrite an existing skill directory")
      .option("--dry-run", "show what would happen without writing files")
      .description("Install a TraceRoot skill into an agent's skill directory")
      .action((skillName: string, _opts, command: Command) => {
        const opts = command.optsWithGlobals();
        runSkillsInstall({
          skillName,
          agentId: opts.agent as string,
          cwd: process.cwd(),
          force: opts.force === true,
          dryRun: opts.dryRun === true,
          json: opts.json === true,
          writers: defaultWriters,
        });
      }),
  );
}
