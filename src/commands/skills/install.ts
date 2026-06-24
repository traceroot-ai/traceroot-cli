import { existsSync } from "node:fs";
import type { Command } from "commander";
import { displaySkillPath } from "../../agents/index.js";
import { resolveAgentOrPrompt } from "../../agents/select.js";
import type { AgentAdapter } from "../../agents/types.js";
import { CliError, type Writers, defaultWriters, logInfo, writeJson } from "../../output.js";
import { confirm, isInteractive, readLine } from "../../prompt.js";
import { createStyler } from "../../render/style.js";
import { bundledSkillDir } from "../../skills/bundled.js";
import { installBundledSkill } from "../../skills/install.js";
import type { BuiltinSkill } from "../../skills/registry.js";
import { resolveSkillOrPrompt } from "../../skills/select.js";

/** Dependencies for the testable core of `skills install`. */
export interface RunSkillsInstallDeps {
  /** Missing/unknown is reported (with the valid names) before the agent is resolved. */
  skillName?: string;
  /** Missing means prompt (interactive) or fail (non-interactive/JSON). */
  agentId?: string;
  cwd: string;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  writers: Writers;
  /** Injected for tests; default is "stdin and stdout are TTYs". */
  isInteractive?: boolean;
  /** Injected for tests; default is a readline prompt. */
  prompt?: (question: string) => Promise<string>;
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
export async function runSkillsInstall(deps: RunSkillsInstallDeps): Promise<void> {
  const { skillName, agentId, cwd, force, dryRun, json, writers } = deps;
  const interactive = deps.isInteractive ?? isInteractive();
  const prompt = deps.prompt ?? readLine;

  // Resolve the skill before the agent, so a missing/unknown skill is reported
  // (or prompted) first — never "missing --agent" ahead of a missing skill.
  const skill = await resolveSkillOrPrompt({
    skillName,
    json,
    writers,
    isInteractive: interactive,
    prompt,
  });
  const agent = await resolveAgentOrPrompt({
    agentId,
    json,
    isInteractive: interactive,
    prompt,
    example: `traceroot skills install ${skill.name} --agent claude`,
  });
  const sourceDir = bundledSkillDir(skill.name);
  const targetDir = agent.getSkillInstallPath(cwd, skill.name);
  const displayPath = displaySkillPath(cwd, targetDir);

  // Overwrite handling. In an interactive TTY (and not dry-run/JSON) confirm
  // before clobbering; an empty/"n" answer aborts with no write. Otherwise the
  // standard non-interactive "use --force" guard in installBundledSkill applies.
  let effectiveForce = force;
  if (!dryRun && !force && interactive && !json && existsSync(targetDir)) {
    const ok = await confirm(`Skill already exists at ${displayPath}.\nOverwrite? (y/N): `, prompt);
    if (!ok) {
      throw new CliError("Aborted: skill not overwritten.");
    }
    effectiveForce = true;
  }

  const result = installBundledSkill({ sourceDir, targetDir, force: effectiveForce, dryRun });

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
  skills
    .command("install")
    // Optional at the parser level so a missing skill yields our actionable error
    // (listing the valid skills) instead of commander's generic message.
    .argument("[skill]", "skill name (see `traceroot skills list`)")
    // Not `.requiredOption`: commander would reject before the action runs, which
    // would block the interactive prompt. Validated/prompted in the action instead.
    .option("--agent <agent>", "target agent: claude, codex, or generic")
    .option("--force", "overwrite an existing skill directory")
    .option("--dry-run", "show what would happen without writing files")
    .description("Install a TraceRoot skill into an agent's skill directory")
    .action(async (skillName: string | undefined, _opts, command: Command) => {
      const opts = command.optsWithGlobals();
      await runSkillsInstall({
        skillName,
        agentId: opts.agent as string | undefined,
        cwd: process.cwd(),
        force: opts.force === true,
        dryRun: opts.dryRun === true,
        json: opts.json === true,
        writers: defaultWriters,
      });
    });
}
