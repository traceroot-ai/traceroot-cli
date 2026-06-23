import type { Command } from "commander";
import { createApiClient } from "../api/client.js";
import { configPath } from "../config/manager.js";
import type { Context } from "../context.js";
import { buildDoctorReport } from "../doctor/checks.js";
import type { DoctorCheck, DoctorReport } from "../doctor/types.js";
import { type Writers, colorizeError, defaultWriters, writeJson } from "../output.js";
import { createStyler } from "../render/style.js";
import { type RepoDetection, detectRepo } from "../repo/detect.js";
import { contextFromCommand, withGlobalJsonHelp } from "./shared.js";

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
  writers: Writers;
  /** Network credential validation; omitted in tests to stay offline. */
  verifyCredentials?: (host: string, apiKey: string) => Promise<boolean>;
  /** Injectable repo detection; defaults to scanning `cwd`. */
  detection?: RepoDetection;
}

/** Picks the single most useful follow-up command from the report. */
function recommendedNextStep(report: DoctorReport): string {
  const find = (name: string): DoctorCheck | undefined =>
    report.checks.find((c) => c.name === name);
  if (find("api_key_resolved")?.status !== "pass") {
    return "traceroot login";
  }
  if (find("skills_installed")?.status !== "pass") {
    return "traceroot skills install traceroot-instrument-repo --agent claude";
  }
  return "traceroot instrument --agent claude --print";
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
    detection,
    env,
  });

  if (ctx.json) {
    writeJson({ data: report }, writers);
    return report;
  }

  const styler = createStyler(writers.out);
  // Markers stay in the CLI's existing grammar: plain glyphs, with error-red the
  // only color (no new green). `-` is a neutral "not yet" marker, kept full
  // contrast (not dimmed) since the status is meaningful.
  const symbol = (check: DoctorCheck): string => {
    if (check.status === "fail") {
      return colorizeError("✗", writers.out);
    }
    return check.status === "warn" ? "-" : "✓";
  };

  const sections: string[] = ["TraceRoot doctor"];
  for (const [category, heading] of CATEGORY_HEADINGS) {
    const checks = report.checks.filter((c) => c.category === category);
    if (checks.length === 0) {
      continue;
    }
    const lines = [styler.bold(heading), ...checks.map((c) => `  ${symbol(c)} ${c.message}`)];
    sections.push(lines.join("\n"));
  }
  sections.push(
    [styler.bold("Recommended next step:"), `  ${recommendedNextStep(report)}`].join("\n"),
  );

  writers.out.write(`${sections.join("\n\n")}\n`);
  return report;
}

export function registerDoctor(program: Command): void {
  const doctor = program
    .command("doctor")
    .description("Diagnose credentials, repo shape, and installed skills")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const report = await runDoctor({
        ctx,
        cwd: process.cwd(),
        env: process.env,
        configPath: configPath(),
        writers: defaultWriters,
        verifyCredentials: async (host, apiKey) => {
          try {
            await createApiClient({ host, apiKey }).whoami();
            return true;
          } catch {
            return false;
          }
        },
      });
      // Exit non-zero only on a hard failure; warnings (missing creds/skills) stay 0.
      if (report.summary.fail > 0) {
        process.exitCode = 1;
      }
    });
  withGlobalJsonHelp(doctor);
}
