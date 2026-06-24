import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Command } from "commander";
import { displaySkillPath } from "../agents/index.js";
import { resolveAgentOrPrompt } from "../agents/select.js";
import {
  CliError,
  type Writers,
  defaultWriters,
  logInfo,
  logProgress,
  writeJson,
} from "../output.js";
import { confirm, isInteractive, readLine } from "../prompt.js";
import { buildInstrumentPrompt } from "../prompts/instrumentPrompt.js";
import { type RepoDetection, detectRepo } from "../repo/detect.js";
import { createStyler } from "../render/style.js";
import { formatBytes } from "../util/index.js";

/** Default location for the generated prompt when neither --print nor --output is given. */
const DEFAULT_PROMPT_PATH = join(".traceroot", "prompts", "instrument-repo.md");

/** Dependencies for the testable core of `instrument`. */
export interface RunInstrumentDeps {
  /** Missing means prompt (interactive) or fail (non-interactive/JSON). */
  agentId?: string;
  cwd: string;
  print: boolean;
  outputPath?: string;
  force: boolean;
  json: boolean;
  writers: Writers;
  /** Injectable repo detection; defaults to scanning `cwd`. */
  detection?: RepoDetection;
  /** Injected for tests; default is "stdin and stdout are TTYs". */
  isInteractive?: boolean;
  /** Injected for tests; default is a readline prompt. */
  prompt?: (question: string) => Promise<string>;
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
 * Generates the agent-ready instrumentation prompt for the current repo. The
 * agent is resolved from `--agent` or, in an interactive TTY, prompted. With
 * `--print` the prompt goes to stdout; otherwise it is written to `--output`, or
 * to an interactively prompted path (default `.traceroot/prompts/instrument-repo.md`),
 * confirming before overwriting. Never edits application source or embeds secrets.
 */
export async function runInstrument(deps: RunInstrumentDeps): Promise<void> {
  const { agentId, cwd, print, outputPath, force, json, writers } = deps;
  const interactive = deps.isInteractive ?? isInteractive();
  const prompt = deps.prompt ?? readLine;

  const agent = await resolveAgentOrPrompt({
    agentId,
    json,
    isInteractive: interactive,
    prompt,
    example: "traceroot instrument --agent claude --print",
  });
  const detection = deps.detection ?? detectRepo(cwd);
  const skillPath = displaySkillPath(
    cwd,
    agent.getSkillInstallPath(cwd, "traceroot-instrument-repo"),
  );
  const promptText = buildInstrumentPrompt(detection, { agentId: agent.id, skillPath });
  const bytes = Buffer.byteLength(promptText, "utf8");

  if (print) {
    if (json) {
      writeJson({ data: { agent: agent.id, printed: true, bytes, prompt: promptText } }, writers);
    } else {
      writers.out.write(promptText.endsWith("\n") ? promptText : `${promptText}\n`);
    }
    return;
  }

  // Write mode: resolve the output path — from --output, an interactive prompt
  // (Enter accepts the default), or a clear error when neither is available.
  let resolvedOutput: string;
  if (outputPath !== undefined) {
    resolvedOutput = outputPath;
  } else if (interactive && !json) {
    const answer = (await prompt(`Output path (default: ${DEFAULT_PROMPT_PATH}): `)).trim();
    resolvedOutput = answer === "" ? DEFAULT_PROMPT_PATH : answer;
  } else {
    throw new CliError(
      `Missing required option --output.\nProvide a path to write the prompt, or use --print.\nExample:\n  traceroot instrument --agent ${agent.id} --output ${DEFAULT_PROMPT_PATH}`,
    );
  }

  const target = resolve(cwd, resolvedOutput);
  const overwritten = existsSync(target);
  const displayPath = relative(cwd, target) || target;

  // Overwrite handling: confirm in an interactive TTY (empty/"n" aborts); keep the
  // non-interactive "use --force" guard otherwise.
  if (overwritten && !force) {
    if (interactive && !json) {
      const ok = await confirm(
        `Prompt already exists at ${displayPath}.\nOverwrite? (y/N): `,
        prompt,
      );
      if (!ok) {
        throw new CliError("Aborted: prompt not overwritten.");
      }
    } else {
      throw new CliError(`Prompt already exists at ${displayPath}\n\nUse --force to overwrite it.`);
    }
  }

  atomicWrite(target, promptText);

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
  logProgress(`Wrote ${formatBytes(bytes)} to ${displayPath}`, writers);
  logInfo(`\nNext: review the prompt, then run it in ${agent.displayName}.`, writers);
}

export function registerInstrument(program: Command): void {
  program
    .command("instrument")
    .description("Generate an agent prompt to instrument this repo with TraceRoot")
    // No default agent: the prompt's skill path and install command depend on it,
    // so the target must be explicit (prompted when interactive, else an error).
    .option("--agent <agent>", "target agent: claude, codex, or generic")
    .option("--print", "print the prompt to stdout instead of writing a file")
    .option("--output <path>", "write the prompt to this path")
    .option("--force", "overwrite an existing prompt file")
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals();
      await runInstrument({
        agentId: opts.agent as string | undefined,
        cwd: process.cwd(),
        print: opts.print === true,
        outputPath: opts.output as string | undefined,
        force: opts.force === true,
        json: opts.json === true,
        writers: defaultWriters,
      });
    });
}
