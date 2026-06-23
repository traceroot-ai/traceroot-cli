import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/commands/doctor.js";
import type { ResolvedAuth } from "../../src/config/resolve.js";
import type { Context } from "../../src/context.js";
import type { Writers } from "../../src/output.js";
import type { RepoDetection } from "../../src/repo/detect.js";
import { StringSink } from "../helpers/stringSink.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tr-doctor-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

function makeCtx(opts: { apiKey?: string; host?: string; json?: boolean }): Context {
  const auth: ResolvedAuth = {
    apiKey: opts.apiKey
      ? { value: opts.apiKey, source: "config" }
      : { value: undefined, source: "none" },
    hostUrl: opts.host
      ? { value: opts.host, source: "config" }
      : { value: undefined, source: "none" },
  };
  return { auth, json: opts.json ?? false };
}

const detection: RepoDetection = {
  root: "/repo",
  hasPackageJson: true,
  hasPyprojectToml: false,
  hasRequirementsTxt: false,
  hasTsconfigJson: true,
  likelyLanguages: ["typescript", "javascript"],
  packageManager: "npm",
};

const baseDeps = (cwdArg: string, writers: Writers) => ({
  cwd: cwdArg,
  env: {} as NodeJS.ProcessEnv,
  configPath: join(cwdArg, ".traceroot", "config.json"),
  writers,
  detection,
});

describe("runDoctor", () => {
  it("aggregates checks and the summary counts sum to the number of checks", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({}),
    });
    const total = report.summary.pass + report.summary.warn + report.summary.fail;
    expect(total).toBe(report.checks.length);
  });

  it("treats missing credentials and skills as warnings, never crashing", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({}),
    });
    const key = report.checks.find((c) => c.name === "api_key_resolved");
    const skill = report.checks.find((c) => c.name === "skill_instrument");
    expect(key?.status).toBe("warn");
    expect(skill?.status).toBe("warn");
    expect(report.summary.fail).toBe(0);
  });

  it("treats the quickstart skill as optional and the instrumentation skill as the readiness signal", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    const instrument = report.checks.find((c) => c.name === "skill_instrument");
    const quickstart = report.checks.find((c) => c.name === "skill_quickstart");
    expect(instrument?.message).toContain("Instrumentation skill");
    expect(quickstart?.message).toContain("optional");
    // Both warn when absent; neither implies the other is installed.
    expect(instrument?.status).toBe("warn");
    expect(quickstart?.status).toBe("warn");
  });

  it("reports runtime env as a neutral warning (not pass) when the var is unset but CLI auth is from config", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({ apiKey: "tr_secret_value", host: "https://api.example.com" }),
      verifyCredentials: async () => true,
    });
    const envKey = report.checks.find((c) => c.name === "env_api_key");
    const envHost = report.checks.find((c) => c.name === "env_host");
    // No green "✓ ... is not set": shell-env checks warn, even though CLI auth resolved.
    expect(envKey?.status).toBe("warn");
    expect(envHost?.status).toBe("warn");
    expect(envKey?.message).toContain("CLI auth is resolved from config");
    expect(envKey?.message).toContain("runtime");
    expect(envHost?.message).toContain("CLI host is resolved from config");
  });

  it("does not warn about absent Python files in a Node/TypeScript repo", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({}),
    });
    const repoChecks = report.checks.filter((c) => c.category === "repo");
    // Detected facts are reported as passes; nothing about absent pyproject/requirements.
    expect(repoChecks.every((c) => c.status === "pass")).toBe(true);
    expect(repoChecks.some((c) => c.message.includes("Node project detected"))).toBe(true);
    expect(report.checks.some((c) => c.message.includes("pyproject.toml"))).toBe(false);
    expect(report.checks.some((c) => c.message.includes("requirements.txt"))).toBe(false);
  });

  it("marks credentials invalid as a hard failure when verification fails", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({ apiKey: "tr_secret_value", host: "https://api.example.com" }),
      verifyCredentials: async () => false,
    });
    const valid = report.checks.find((c) => c.name === "api_credentials_valid");
    expect(valid?.status).toBe("fail");
    expect(report.summary.fail).toBeGreaterThan(0);
  });

  it("passes credential validation when verification succeeds", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({ apiKey: "tr_secret_value", host: "https://api.example.com" }),
      verifyCredentials: async () => true,
    });
    expect(report.checks.find((c) => c.name === "api_credentials_valid")?.status).toBe("pass");
  });

  it("never prints the full API key (human or JSON)", async () => {
    const FULL = "tr_super_secret_LEAK";
    const human = makeWriters();
    await runDoctor({
      ...baseDeps(cwd, human.writers),
      ctx: makeCtx({ apiKey: FULL, host: "https://api.example.com" }),
      verifyCredentials: async () => true,
    });
    expect(human.out.data).not.toContain(FULL);

    const jsonW = makeWriters();
    await runDoctor({
      ...baseDeps(cwd, jsonW.writers),
      ctx: makeCtx({ apiKey: FULL, host: "https://api.example.com", json: true }),
      verifyCredentials: async () => true,
    });
    expect(jsonW.out.data).not.toContain(FULL);
  });

  it("emits valid JSON with data.checks and data.summary", async () => {
    const { writers, out, err } = makeWriters();
    await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({ json: true }),
    });
    const parsed = JSON.parse(out.data) as {
      data: { checks: unknown[]; summary: { pass: number; warn: number; fail: number } };
    };
    expect(Array.isArray(parsed.data.checks)).toBe(true);
    expect(parsed.data.summary).toHaveProperty("pass");
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(err.data).toBe("");
  });
});
