import type { Command } from "commander";
import { createApiClient } from "../api/client.js";
import { createTokenProvider } from "../auth/token.js";
import { configPath } from "../config/manager.js";
import type { ResolvedCredential } from "../config/resolve.js";
import type { Context } from "../context.js";
import { buildDoctorReport } from "../doctor/checks.js";
import type { DoctorCheck, DoctorReport } from "../doctor/types.js";
import { type Writers, defaultWriters, writeJson } from "../output.js";
import { statusSymbol } from "../render/status.js";
import { createStyler } from "../render/style.js";
import { type RepoDetection, detectRepo } from "../repo/detect.js";
import { serviceArtifactDir } from "../setup/artifacts.js";
import { readCheckpoint, setupRoot } from "../setup/checkpoint.js";
import type { SetupCheckpoint } from "../setup/types.js";
import { contextFromCommand } from "./shared.js";

/** Ordered category → human heading. */
const CATEGORY_HEADINGS: ReadonlyArray<[DoctorCheck["category"], string]> = [
  ["credentials", "Credentials"],
  ["traceroot_files", "TraceRoot files"],
  ["agent_skills", "Agent skills"],
  ["repo", "Repo"],
  ["runtime_env", "Runtime env"],
  ["setup", "Setup"],
];

/** Dependencies for the testable core of `doctor`. */
export interface RunDoctorDeps {
  ctx: Context;
  cwd: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  writers: Writers;
  /** Network credential validation; omitted in tests to stay offline. */
  verifyCredentials?: (host: string, credential: ResolvedCredential) => Promise<boolean>;
  /** Injectable repo detection; defaults to scanning `cwd`. */
  detection?: RepoDetection;
  /** The `setup` checkpoint; `undefined` means "read it from `cwd`". */
  checkpoint?: SetupCheckpoint | null;
  /** `--service <path>`: whose setup run to diagnose, as `setup` resolves it. */
  service?: string;
  /** Force the Setup section even when no checkpoint exists (`setup doctor`). */
  includeSetup?: boolean;
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

  const credential = ctx.auth.credential;
  const host = ctx.auth.hostUrl.value;
  let credentialsValid: boolean | null = null;
  if (
    credential.kind !== "none" &&
    credential.value !== undefined &&
    host !== undefined &&
    deps.verifyCredentials !== undefined
  ) {
    credentialsValid = await deps.verifyCredentials(host, credential);
  }

  // `undefined` means "read it"; an explicit `null` means "there is none",
  // which keeps tests offline and free of filesystem surprises.
  //
  // Looks where setup would have written it — the service directory implied by
  // where you are standing — and falls back to the repository root, both for
  // checkpoints written before they moved and for a user running `doctor` from
  // somewhere other than the directory they ran setup in. Diagnosing a run is
  // exactly when being strict about the location would be least helpful.
  const setupDir = setupRoot(cwd);
  const checkpoint =
    deps.checkpoint === undefined
      ? (readCheckpoint(serviceArtifactDir({ root: setupDir, cwd, service: deps.service })) ??
        readCheckpoint(setupDir))
      : deps.checkpoint;

  const report = buildDoctorReport({
    cwd,
    auth: ctx.auth,
    credentialsValid,
    configPath: deps.configPath,
    detection,
    env,
    checkpoint,
    includeSetup: deps.includeSetup,
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
    .option("--service <path>", "path of the service whose setup run to diagnose")
    .action(async (opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const report = await runDoctor({
        ctx,
        cwd: process.cwd(),
        service: opts.service as string | undefined,
        env: process.env,
        configPath: configPath(),
        writers: defaultWriters,
        verifyCredentials: async (host, credential) => {
          try {
            if (credential.kind === "session") {
              // whoami is API-key-only. Mint through the provider AND make a
              // session-capable read against the public API host, so doctor
              // validates both hosts the way the api-key whoami path does.
              const provider = createTokenProvider({
                authHost: ctx.auth.authHost.value ?? host,
                sessionToken: credential.value ?? "",
                timeoutMs: ctx.timeoutMs,
              });
              await createApiClient({
                host,
                auth: {
                  kind: "token-provider",
                  getAccessToken: () => provider.getAccessToken(),
                  invalidate: () => provider.invalidate(),
                },
                timeoutMs: ctx.timeoutMs,
              }).listWorkspaces();
              return true;
            }
            await createApiClient({
              host,
              auth: { kind: "api-key", key: credential.value ?? "" },
              timeoutMs: ctx.timeoutMs,
            }).whoami();
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
