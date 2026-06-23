import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Command } from "commander";
import { displaySkillPath, requireAgent } from "../agents/index.js";
import {
  CliError,
  type Writers,
  defaultWriters,
  logInfo,
  logProgress,
  writeJson,
} from "../output.js";
import { buildInstrumentPrompt } from "../prompts/instrumentPrompt.js";
import { type RepoDetection, detectRepo } from "../repo/detect.js";
import { createStyler } from "../render/style.js";
import { withGlobalJsonHelp } from "./shared.js";

/** Default location for the generated prompt when neither --print nor --output is given. */
const DEFAULT_PROMPT_PATH = join(".traceroot", "prompts", "instrument-repo.md");

/** Dependencies for the testable core of `instrument`. */
export interface RunInstrumentDeps {
  agentId: string;
  cwd: string;
  print: boolean;
  outputPath?: string;
  force: boolean;
  json: boolean;
  writers: Writers;
  /** Injectable repo detection; defaults to scanning `cwd`. */
  detection?: RepoDetection;
}

/** Writes `content` to `target` via a temp file + rename so a crash can't truncate it. */
function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    if (err instanceof CliError) {
      throw err;
    }
    throw new CliError(`Failed to write prompt to ${target}`);
  }
}

/**
 * Generates the Claude Code-ready instrumentation prompt for the current repo.
 * With `--print` the prompt goes to stdout; otherwise it is written to
 * `--output` (or the default `.traceroot/prompts/instrument-repo.md`), refusing
 * to overwrite without `--force`. Never edits application source or embeds
 * secrets.
 */
export function runInstrument(deps: RunInstrumentDeps): void {
  const { agentId, cwd, print, outputPath, force, json, writers } = deps;

  const agent = requireAgent(agentId);
  const detection = deps.detection ?? detectRepo(cwd);
  const skillPath = displaySkillPath(
    cwd,
    agent.getSkillInstallPath(cwd, "traceroot-instrument-repo"),
  );
  const prompt = buildInstrumentPrompt(detection, { agentId: agent.id, skillPath });
  const bytes = Buffer.byteLength(prompt, "utf8");

  if (print) {
    if (json) {
      writeJson({ data: { agent: agent.id, printed: true, bytes, prompt } }, writers);
    } else {
      writers.out.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
    }
    return;
  }

  const target = outputPath ? resolve(cwd, outputPath) : resolve(cwd, DEFAULT_PROMPT_PATH);
  const overwritten = existsSync(target);
  const displayPath = relative(cwd, target) || target;

  if (overwritten && !force) {
    throw new CliError(`Prompt already exists at ${displayPath}\n\nUse --force to overwrite it.`);
  }

  atomicWrite(target, prompt);

  if (json) {
    writeJson({ data: { agent: agent.id, output: displayPath, bytes, overwritten } }, writers);
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const lines = [
    "Wrote instrument prompt",
    "",
    `${label("Agent:")} ${agent.displayName}`,
    `${label("Path:")}  ${displayPath}`,
  ];
  writers.out.write(`${lines.join("\n")}\n`);
  logProgress(`Wrote ${bytes} bytes to ${displayPath}`, writers);
  logInfo(`\nNext: review the prompt, then run it in ${agent.displayName}.`, writers);
}

export function registerInstrument(program: Command): void {
  const instrument = program
    .command("instrument")
    .description("Generate an agent prompt to instrument this repo with TraceRoot")
    .option("--agent <id>", "target agent: claude, codex, or generic", "claude")
    .option("--print", "print the prompt to stdout instead of writing a file")
    .option("--output <path>", "write the prompt to this path")
    .option("--force", "overwrite an existing prompt file")
    .action((_opts, command: Command) => {
      const opts = command.optsWithGlobals();
      runInstrument({
        agentId: opts.agent as string,
        cwd: process.cwd(),
        print: opts.print === true,
        outputPath: opts.output as string | undefined,
        force: opts.force === true,
        json: opts.json === true,
        writers: defaultWriters,
      });
    });
  withGlobalJsonHelp(instrument);
}
