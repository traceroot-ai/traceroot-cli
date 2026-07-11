import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let codexHome: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tr-doctor-"));
  // Pin CODEX_HOME so codex skill checks are hermetic (never read the real ~/.codex).
  codexHome = join(cwd, "codex-home");
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (prevCodexHome === undefined) {
    // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = prevCodexHome;
  }
  rmSync(cwd, { recursive: true, force: true });
});

/** Marks a skill installed for an agent by writing its SKILL.md. */
function writeSkill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# skill", "utf8");
}

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

function makeCtx(opts: {
  apiKey?: string;
  host?: string;
  json?: boolean;
  source?: "config" | "global-config";
}): Context {
  const source = opts.source ?? "config";
  const auth: ResolvedAuth = {
    apiKey: opts.apiKey ? { value: opts.apiKey, source } : { value: undefined, source: "none" },
    hostUrl: opts.host ? { value: opts.host, source } : { value: undefined, source: "none" },
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
  // A path under the isolated temp cwd, never the real ~/.config, so the
  // global-config-presence check never touches the real filesystem.
  globalConfigPath: join(cwdArg, "global-config", "config.json"),
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

  it("treats missing API key and host as required failures, but a missing skill as a warning", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({}),
    });
    const key = report.checks.find((c) => c.name === "api_key_resolved");
    const host = report.checks.find((c) => c.name === "host_resolved");
    const skill = report.checks.find((c) => c.name === "skill_instrument");
    // Required credentials → fail (red ✗); optional skill → warn (gray -).
    expect(key?.status).toBe("fail");
    expect(host?.status).toBe("fail");
    expect(skill?.status).toBe("warn");
    expect(report.summary.fail).toBeGreaterThanOrEqual(2);
  });

  it("treats the quickstart skill as optional and the instrumentation skill as the readiness signal", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    const instrument = report.checks.find((c) => c.name === "skill_instrument");
    const quickstart = report.checks.find((c) => c.name === "skill_quickstart");
    expect(instrument?.message).toContain("Instrumentation skill");
    // Hint points at the bare interactive install command — no --agent, no semicolon.
    expect(instrument?.message).not.toContain("--agent");
    expect(instrument?.message).not.toContain(";");
    // Concise wording: no "; optional" clause.
    expect(quickstart?.message).toBe("Quickstart skill not installed");
    // Both warn when absent; neither implies the other is installed.
    expect(instrument?.status).toBe("warn");
    expect(quickstart?.status).toBe("warn");
  });

  it("lists every agent that has the instrumentation skill (claude, codex order)", async () => {
    writeSkill(join(cwd, ".claude", "skills", "traceroot-instrument-repo"));
    writeSkill(join(codexHome, "skills", "traceroot-instrument-repo"));
    const { writers } = makeWriters();
    const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    const instrument = report.checks.find((c) => c.name === "skill_instrument");
    expect(instrument?.status).toBe("pass");
    expect(instrument?.message).toBe("Instrumentation skill installed for Claude Code, Codex");
  });

  it("uses concise, login-pointing wording for missing credentials and config", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    const key = report.checks.find((c) => c.name === "api_key_resolved");
    const host = report.checks.find((c) => c.name === "host_resolved");
    const config = report.checks.find((c) => c.name === "config_file_present");
    expect(key?.message).toBe("API key not found. Run `traceroot login`.");
    expect(host?.message).toBe("Host not found. Run `traceroot login`.");
    expect(key?.message).not.toContain("set TRACEROOT_API_KEY");
    expect(config?.message).toBe("No config file found");
    expect(config?.status).toBe("warn");
  });

  it("renders required credential failures as red ✗ in human output (color enabled)", async () => {
    const out = new StringSink(true);
    const err = new StringSink(true);
    await runDoctor({ ...baseDeps(cwd, { out, err }), ctx: makeCtx({}) });
    // Red ✗ glyph present; missing API key uses it (not the gray "-").
    expect(out.data).toContain("\x1b[91m✗\x1b[0m API key not found");
  });

  it("redacts embedded credentials/query from the resolved host (shows origin only)", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({
        apiKey: "tr_x",
        host: "https://user:pass@app.traceroot.ai:8443/p?token=SEKRET",
      }),
      verifyCredentials: async () => true,
    });
    const host = report.checks.find((c) => c.name === "host_resolved");
    expect(host?.message).toBe("Host resolved: https://app.traceroot.ai:8443");
    expect(host?.message).not.toContain("user:pass");
    expect(host?.message).not.toContain("SEKRET");
  });

  it("runtime-env warnings carry no semicolon explanatory clauses", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    for (const c of report.checks.filter((c) => c.category === "runtime_env")) {
      expect(c.status).toBe("warn");
      expect(c.message).not.toContain(";");
    }
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
    // Terse wording: no semicolon explanatory clause.
    expect(envKey?.message).toBe("TRACEROOT_API_KEY is not set in this shell");
    expect(envHost?.message).toBe("TRACEROOT_HOST_URL is not set in this shell");
    expect(envKey?.message).not.toContain(";");
    expect(envHost?.message).not.toContain(";");
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

  it("omits the recommended-next-step block from human output", async () => {
    const { writers, out } = makeWriters();
    await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    expect(out.data).not.toContain("Recommended next step");
  });

  it("reports the global config path as the source when credentials resolved from it", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({
      ...baseDeps(cwd, writers),
      ctx: makeCtx({
        apiKey: "tr_x",
        host: "https://api.example.com",
        source: "global-config",
      }),
    });
    const key = report.checks.find((c) => c.name === "api_key_resolved");
    expect(key?.message).toBe(`API key resolved from ${join(cwd, "global-config", "config.json")}`);
  });

  it("reports the global config file as absent when not present", async () => {
    const { writers } = makeWriters();
    const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    expect(report.checks.find((c) => c.name === "global_config_file_present")).toBeUndefined();
  });

  it("reports the global config file as present when it exists", async () => {
    const globalConfigPath = join(cwd, "global-config", "config.json");
    mkdirSync(join(cwd, "global-config"), { recursive: true });
    writeFileSync(globalConfigPath, JSON.stringify({ api_key: "k", host_url: "https://h" }));
    const { writers } = makeWriters();
    const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
    const check = report.checks.find((c) => c.name === "global_config_file_present");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain(globalConfigPath);
  });

  it.skipIf(process.platform === "win32")(
    "passes the global config permission check when the file is 0600",
    async () => {
      const globalConfigPath = join(cwd, "global-config", "config.json");
      mkdirSync(join(cwd, "global-config"), { recursive: true });
      writeFileSync(globalConfigPath, JSON.stringify({ api_key: "k", host_url: "https://h" }));
      chmodSync(globalConfigPath, 0o600);
      const { writers } = makeWriters();
      const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
      const check = report.checks.find((c) => c.name === "global_config_permissions");
      expect(check?.status).toBe("pass");
      expect(check?.message).toBe("Global config file permissions are restrictive (0600)");
    },
  );

  it.skipIf(process.platform === "win32")(
    "warns when the global config file is group/world-readable",
    async () => {
      const globalConfigPath = join(cwd, "global-config", "config.json");
      mkdirSync(join(cwd, "global-config"), { recursive: true });
      writeFileSync(globalConfigPath, JSON.stringify({ api_key: "k", host_url: "https://h" }));
      chmodSync(globalConfigPath, 0o644);
      const { writers } = makeWriters();
      const report = await runDoctor({ ...baseDeps(cwd, writers), ctx: makeCtx({}) });
      const check = report.checks.find((c) => c.name === "global_config_permissions");
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("mode 644");
      expect(check?.message).toContain(`chmod 600 ${globalConfigPath}`);
    },
  );

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
