import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInstrument } from "../../src/commands/instrument.js";
import { CliError, type Writers } from "../../src/output.js";
import type { RepoDetection } from "../../src/repo/detect.js";
import { StringSink } from "../helpers/stringSink.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tr-instrument-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const tsDetection: RepoDetection = {
  root: "/repo",
  hasPackageJson: true,
  hasPyprojectToml: false,
  hasRequirementsTxt: false,
  hasTsconfigJson: true,
  likelyLanguages: ["typescript", "javascript"],
  packageManager: "pnpm",
};

const base = { agentId: "claude", cwd: "", force: false, json: false } as const;

describe("runInstrument (--print)", () => {
  it("prints the prompt to stdout and writes no file", async () => {
    const { writers, out } = makeWriters();
    await runInstrument({ ...base, cwd, print: true, writers, detection: tsDetection });
    expect(out.data).toContain("Instrument this repository with TraceRoot");
    expect(existsSync(join(cwd, ".traceroot"))).toBe(false);
  });

  it("includes the detected repo facts", async () => {
    const { writers, out } = makeWriters();
    await runInstrument({ ...base, cwd, print: true, writers, detection: tsDetection });
    expect(out.data).toContain("Detected repository facts:");
    expect(out.data).toContain("package.json: present");
    expect(out.data).toContain("pyproject.toml: absent");
    expect(out.data).toContain("package manager: pnpm");
  });

  it("never embeds an API key value in the prompt", async () => {
    const { writers, out } = makeWriters();
    await runInstrument({ ...base, cwd, print: true, writers, detection: tsDetection });
    expect(out.data).not.toMatch(/tr_[A-Za-z0-9]/);
    // It references the env var name as guidance, but assigns no value.
    expect(out.data).toContain("TRACEROOT_API_KEY");
    expect(out.data).not.toMatch(/TRACEROOT_API_KEY\s*=/);
  });

  it("emits valid JSON carrying the prompt under data when --print --json", async () => {
    const { writers, out } = makeWriters();
    await runInstrument({ ...base, cwd, print: true, json: true, writers, detection: tsDetection });
    const parsed = JSON.parse(out.data) as { data: { printed: boolean; prompt: string } };
    expect(parsed.data.printed).toBe(true);
    expect(parsed.data.prompt).toContain("Instrument this repository");
  });
});

const DEFAULT_OUTPUT = ".traceroot/prompts/instrument-repo.md";

describe("runInstrument (file write)", () => {
  it("writes the prompt to the given --output path", async () => {
    const { writers } = makeWriters();
    await runInstrument({
      ...base,
      cwd,
      print: false,
      outputPath: DEFAULT_OUTPUT,
      writers,
      detection: tsDetection,
    });
    const target = join(cwd, ".traceroot", "prompts", "instrument-repo.md");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("Instrument this repository");
  });

  it("reports the written size with grouped bytes and an MB value (stderr)", async () => {
    const { writers, err } = makeWriters();
    await runInstrument({
      ...base,
      cwd,
      print: false,
      outputPath: DEFAULT_OUTPUT,
      writers,
      detection: tsDetection,
    });
    expect(err.data).toMatch(/\d,\d{3} bytes \(\d+\.\d MB\)/);
  });

  it("refuses to overwrite an existing prompt without --force (non-interactive)", async () => {
    const { writers } = makeWriters();
    const args = {
      ...base,
      cwd,
      print: false,
      outputPath: DEFAULT_OUTPUT,
      isInteractive: false,
      writers,
      detection: tsDetection,
    };
    await runInstrument(args);
    await expect(runInstrument(args)).rejects.toBeInstanceOf(CliError);
  });

  it("overwrites with --force", async () => {
    const { writers } = makeWriters();
    const args = {
      ...base,
      cwd,
      print: false,
      outputPath: DEFAULT_OUTPUT,
      writers,
      detection: tsDetection,
    };
    await runInstrument(args);
    await expect(runInstrument({ ...args, force: true })).resolves.toBeUndefined();
  });

  it("requires --output when writing non-interactively (no --print)", async () => {
    const { writers, out } = makeWriters();
    await expect(
      runInstrument({
        ...base,
        cwd,
        print: false,
        isInteractive: false,
        writers,
        detection: tsDetection,
      }),
    ).rejects.toThrow(/Missing required option --output/);
    expect(existsSync(join(cwd, ".traceroot"))).toBe(false);
    expect(out.data).toBe("");
  });

  it("honors a custom --output path and reports it in JSON", async () => {
    const { writers, out } = makeWriters();
    await runInstrument({
      ...base,
      cwd,
      print: false,
      json: true,
      outputPath: "docs/prompt.md",
      writers,
      detection: tsDetection,
    });
    const parsed = JSON.parse(out.data) as { data: { output: string; bytes: number } };
    expect(parsed.data.output).toBe("docs/prompt.md");
    // JSON preserves the raw numeric byte count (human formatting is stderr-only).
    expect(typeof parsed.data.bytes).toBe("number");
    expect(parsed.data.bytes).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "docs", "prompt.md"))).toBe(true);
  });

  it("derives repo facts from cwd when no detection is injected", async () => {
    writeFileSync(join(cwd, "pyproject.toml"), "", "utf8");
    const { writers } = makeWriters();
    await runInstrument({ ...base, cwd, print: false, outputPath: DEFAULT_OUTPUT, writers });
    const target = join(cwd, ".traceroot", "prompts", "instrument-repo.md");
    expect(readFileSync(target, "utf8")).toContain("pyproject.toml: present");
  });
});

/** A prompt fn keyed on the question text, returning scripted answers per field. */
function scripted(answers: { agent?: string; output?: string; overwrite?: string }) {
  return async (q: string): Promise<string> => {
    if (q.includes("Overwrite?")) return answers.overwrite ?? "";
    if (q.startsWith("Agent (")) return answers.agent ?? "";
    if (q.startsWith("Output path")) return answers.output ?? "";
    throw new Error(`unexpected prompt: ${q}`);
  };
}

describe("runInstrument (interactive)", () => {
  it("bare command prompts for agent then output path; empty input picks defaults", async () => {
    const { writers } = makeWriters();
    await runInstrument({
      ...base,
      agentId: undefined,
      cwd,
      print: false,
      isInteractive: true,
      prompt: scripted({ agent: "", output: "" }),
      writers,
      detection: tsDetection,
    });
    const target = join(cwd, ".traceroot", "prompts", "instrument-repo.md");
    expect(existsSync(target)).toBe(true);
    // Empty agent → claude (the prompt references the claude install command).
    expect(readFileSync(target, "utf8")).toContain("--agent claude");
  });

  it("with --agent provided, prompts only for the output path", async () => {
    const { writers } = makeWriters();
    await runInstrument({
      ...base,
      agentId: "codex",
      cwd,
      print: false,
      isInteractive: true,
      prompt: scripted({ output: "" }),
      writers,
      detection: tsDetection,
    });
    const target = join(cwd, ".traceroot", "prompts", "instrument-repo.md");
    expect(readFileSync(target, "utf8")).toContain("--agent codex");
  });

  it("with --output provided, prompts only for the agent", async () => {
    const { writers } = makeWriters();
    await runInstrument({
      ...base,
      agentId: undefined,
      cwd,
      print: false,
      outputPath: "docs/p.md",
      isInteractive: true,
      prompt: scripted({ agent: "" }),
      writers,
      detection: tsDetection,
    });
    expect(existsSync(join(cwd, "docs", "p.md"))).toBe(true);
  });

  it("with explicit agent and output, prompts for nothing", async () => {
    const { writers } = makeWriters();
    const prompt = async (q: string): Promise<string> => {
      throw new Error(`should not prompt: ${q}`);
    };
    await runInstrument({
      ...base,
      agentId: "claude",
      cwd,
      print: false,
      outputPath: "docs/p.md",
      isInteractive: true,
      prompt,
      writers,
      detection: tsDetection,
    });
    expect(existsSync(join(cwd, "docs", "p.md"))).toBe(true);
  });

  it("--print prompts only for the agent (no output path prompt)", async () => {
    const { writers, out } = makeWriters();
    await runInstrument({
      ...base,
      agentId: undefined,
      cwd,
      print: true,
      isInteractive: true,
      // scripted() throws on an unexpected "Output path" question.
      prompt: scripted({ agent: "codex" }),
      writers,
      detection: tsDetection,
    });
    expect(out.data).toContain("--agent codex");
    expect(existsSync(join(cwd, ".traceroot"))).toBe(false);
  });
});

describe("runInstrument (interactive overwrite)", () => {
  const seed = {
    ...base,
    agentId: "claude",
    print: false,
    outputPath: DEFAULT_OUTPUT,
    isInteractive: true,
    detection: tsDetection,
  } as const;

  it("'y' overwrites an existing prompt", async () => {
    await runInstrument({ ...seed, cwd, prompt: scripted({}), writers: makeWriters().writers });
    await expect(
      runInstrument({
        ...seed,
        cwd,
        prompt: scripted({ overwrite: "y" }),
        writers: makeWriters().writers,
      }),
    ).resolves.toBeUndefined();
  });

  it("declining with empty input aborts (non-zero) and keeps the file", async () => {
    await runInstrument({ ...seed, cwd, prompt: scripted({}), writers: makeWriters().writers });
    const target = join(cwd, ".traceroot", "prompts", "instrument-repo.md");
    writeFileSync(target, "ORIGINAL", "utf8");
    await expect(
      runInstrument({
        ...seed,
        cwd,
        prompt: scripted({ overwrite: "" }),
        writers: makeWriters().writers,
      }),
    ).rejects.toThrow(/Aborted/);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
  });

  it("--force skips the overwrite prompt", async () => {
    await runInstrument({ ...seed, cwd, prompt: scripted({}), writers: makeWriters().writers });
    const prompt = async (q: string): Promise<string> => {
      throw new Error(`should not prompt with --force: ${q}`);
    };
    await expect(
      runInstrument({ ...seed, cwd, force: true, prompt, writers: makeWriters().writers }),
    ).resolves.toBeUndefined();
  });
});

describe("runInstrument (missing --agent)", () => {
  it("fails with an actionable error when non-interactive and writes no file", async () => {
    const { writers, out } = makeWriters();
    try {
      await runInstrument({
        ...base,
        agentId: undefined,
        cwd,
        print: false,
        isInteractive: false,
        writers,
        detection: tsDetection,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const msg = (err as CliError).message;
      expect(msg).toContain("--agent");
      expect(msg).toContain("claude, codex, generic");
      expect(msg).toContain("traceroot instrument --agent claude --print");
    }
    expect(existsSync(join(cwd, ".traceroot"))).toBe(false);
    expect(out.data).toBe("");
  });

  it("does not prompt or emit partial JSON in --json mode", async () => {
    const { writers, out } = makeWriters();
    const prompt = async (): Promise<string> => {
      throw new Error("should not prompt in JSON mode");
    };
    await expect(
      runInstrument({
        ...base,
        agentId: undefined,
        cwd,
        print: true,
        json: true,
        isInteractive: true,
        prompt,
        writers,
        detection: tsDetection,
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(out.data).toBe("");
  });

  it("uses the interactively selected agent in the generated prompt", async () => {
    const { writers, out } = makeWriters();
    await runInstrument({
      ...base,
      agentId: undefined,
      cwd,
      print: true,
      isInteractive: true,
      prompt: async () => "codex",
      writers,
      detection: tsDetection,
    });
    // The prompt's install command reflects the chosen agent.
    expect(out.data).toContain("--agent codex");
    expect(out.data).not.toContain("--agent claude");
  });
});
