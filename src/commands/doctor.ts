import type { Command } from "commander";
import { createApiClient } from "../api/client.js";
import { configPath, globalConfigPath } from "../config/manager.js";
import type { Context } from "../context.js";
import { buildDoctorReport } from "../doctor/checks.js";
import type { DoctorCheck, DoctorReport } from "../doctor/types.js";
import { type Writers, defaultWriters, writeJson } from "../output.js";
import { statusSymbol } from "../render/status.js";
import { createStyler } from "../render/style.js";
import { type RepoDetection, detectRepo } from "../repo/detect.js";
import { contextFromCommand } from "./shared.js";

/** Ordered category → human heading. */
const CATEGORY_HEADINGS: ReadonlyArray<[DoctorCheck["category"], string]> = [
  ["credentials", "Credentials"],
  ["traceroot_files", "TraceRoot files"],
  ["agent_skills", "Agent skills"],
  ["repo", "Repo"],
  ["runtime_env", "Runtime env"],
];

/** Dependencies for the testable core of `doctor`. */
export interface RunDoctorDeps {
  ctx: Context;
  cwd: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  /** Path to the global (per-user) config fallback; see `globalConfigPath()`. */
  globalConfigPath: string;
  writers: Writers;
  /** Network credential validation; omitted in tests to stay offline. */
  verifyCredentials?: (host: string, apiKey: string) => Promise<boolean>;
  /** Injectable repo detection; defaults to scanning `cwd`. */
  detection?: RepoDetection;
}

/**
 * Runs all diagnostics and renders the report. Validates credentials over the
 * network only when both are present (so a fresh repo never errors). Returns the
 * report so the caller can set the process exit code (non-zero iff any check
 * fails). Never prints secrets — only their source and presence.
 */
export async function runDoctor(deps: RunDoctorDeps): Promise<DoctorReport> {
  const { ctx, cwd, env, writers } = deps;
  const detection = deps.detection ?? detectRepo(cwd);

  const apiKey = ctx.auth.apiKey.value;
  const host = ctx.auth.hostUrl.value;
  let credentialsValid: boolean | null = null;
  if (apiKey !== undefined && host !== undefined && deps.verifyCredentials !== undefined) {
    credentialsValid = await deps.verifyCredentials(host, apiKey);
  }

  const report = buildDoctorReport({
    cwd,
    auth: ctx.auth,
    credentialsValid,
    configPath: deps.configPath,
    globalConfigPath: deps.globalConfigPath,
    detection,
    env,
  });

  if (ctx.json) {
    writeJson({ data: report }, writers);
    return report;
  }

  const styler = createStyler(writers.out);
  // Status grammar shared with `skills list`: green ✓ (pass), gray - (neutral/
  // optional), red ✗ (fail); color only when the sink allows it. No standalone
  // command title — like `status`/`traces get`, sections start directly.
  const sections: string[] = [];
  for (const [category, heading] of CATEGORY_HEADINGS) {
    const checks = report.checks.filter((c) => c.category === category);
    if (checks.length === 0) {
      continue;
    }
    const lines = [
      styler.bold(heading),
      ...checks.map((c) => `  ${statusSymbol(c.status, writers.out)} ${c.message}`),
    ];
    sections.push(lines.join("\n"));
  }

  writers.out.write(`${sections.join("\n\n")}\n`);
  return report;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose credentials, repo shape, and installed skills")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const report = await runDoctor({
        ctx,
        cwd: process.cwd(),
        env: process.env,
        configPath: configPath(),
        globalConfigPath: globalConfigPath(),
        writers: defaultWriters,
        verifyCredentials: async (host, apiKey) => {
          try {
            await createApiClient({ host, apiKey, timeoutMs: ctx.timeoutMs }).whoami();
            return true;
          } catch {
            return false;
          }
        },
      });
      // Exit non-zero only on hard failures. Missing credentials are hard failures;
      // optional/missing skills and runtime-env warnings do not fail the command.
      if (report.summary.fail > 0) {
        process.exitCode = 1;
      }
    });
}
