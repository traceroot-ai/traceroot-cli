import { join } from "node:path";
import { writeFileSecure } from "../util/secureFile.js";
import type { SetupContext } from "./types.js";

/**
 * The record a setup run leaves behind.
 *
 * Everything a run establishes — what it found, what it changed, whether the
 * application still passes without TraceRoot, which trace proved it — is
 * printed to stderr and then gone. That is exactly the material a reviewer
 * wants when the resulting diff arrives as a pull request, and exactly what the
 * author has to reconstruct from memory instead.
 *
 * Keeping it costs one file.
 *
 * Written as Markdown so it can be pasted into a PR description unedited, and
 * kept in `.traceroot/` where the existing `.gitignore` covers it — a report is
 * a local artefact, not something to commit.
 */

/** Where the report lives, relative to the repository root. */
export const REPORT_PATH = join(".traceroot", "setup-report.md");

/** A value in a table cell: an unescaped pipe splits the row, a newline ends the table. */
function cell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function line(label: string, value: string | null | undefined): string {
  const text = value === null || value === undefined || value === "" ? "—" : cell(value);
  return `| ${label} | ${text} |`;
}

/**
 * Renders the report.
 *
 * Never includes a credential. The key is represented by its hint and id,
 * which is the same rule the checkpoint follows — a report is a file people
 * paste into pull requests, which is the last place a secret should be able to
 * reach.
 */
export function renderSetupReport(ctx: SetupContext, now: Date): string {
  const cp = ctx.checkpoint;
  const service = cp.service;
  const app = ctx.application;
  const trace = ctx.trace;

  const verdict =
    trace !== undefined
      ? "TraceRoot is connected and a trace has been received."
      : "TraceRoot is configured, but no trace has been seen yet.";

  const checks =
    app === undefined
      ? "Not run."
      : app.passed
        ? "Passed both with and without `TRACEROOT_API_KEY`, so the application does not depend on TraceRoot being configured."
        : "Did not pass.";

  const sections = [
    "# TraceRoot setup report",
    "",
    verdict,
    "",
    `Generated ${now.toISOString()} by traceroot-cli ${cp.cliVersion}.`,
    "",
    "## What it connected to",
    "",
    "| | |",
    "|---|---|",
    line("Project", cp.projectName ?? cp.projectId),
    line("Project id", cp.projectId),
    line("Workspace id", cp.workspaceId),
    line("Host", cp.host),
    // The hint, never the key. Enough to identify it in a settings list.
    line(
      "API key",
      cp.projectKeyHint ? `${cp.projectKeyHint} (id ${cp.projectKeyId ?? "—"})` : null,
    ),
    "",
    "## What it instrumented",
    "",
    "| | |",
    "|---|---|",
    line("Service", service?.path),
    line("Language", service?.language),
    line("Framework", service?.framework ?? "none detected"),
    line("SDK version", cp.sdkVersion),
    line("Method", ctx.method),
    line("Agent", cp.agentId),
    "",
    "## What it verified",
    "",
    `**Your checks.** ${checks}`,
    "",
    app?.command ? `Command: \`${app.command}\`` : "",
    "",
    trace !== undefined
      ? `**First trace.** \`${trace.traceId}\`\n\n${trace.traceUrl}`
      : "**First trace.** None yet. Run the application, then `traceroot setup --resume`.",
    "",
    "## Files this run touched",
    "",
    "| Path | Why |",
    "|---|---|",
    "| `.env.traceroot` | `TRACEROOT_API_KEY` for the application. Git-ignored. |",
    "| `.traceroot/config.json` | The CLI's own credential. Git-ignored. |",
    "| `.traceroot/setup.json` | Checkpoint, so `--resume` can continue. |",
    ctx.agent !== undefined
      ? "| `.claude/skills/traceroot-instrument-repo/` | The instrumentation skill. |"
      : "",
    "",
    "Application files changed by the agent are not listed here — `git diff` is the",
    "authority on those, and duplicating it would only go stale.",
    "",
  ];

  return `${sections.filter((section) => section !== "").join("\n")}\n`;
}

/**
 * Writes the report, returning its path.
 *
 * Best-effort by design: a run that connected TraceRoot, instrumented an
 * application and saw a trace has succeeded, and failing it at the last step
 * over a file nobody has read yet would be absurd.
 */
export function writeSetupReport(ctx: SetupContext, now: Date = new Date()): string | null {
  const target = join(ctx.root, REPORT_PATH);
  try {
    // Creates `.traceroot/` 0700, writes a fresh temp file exclusively and
    // renames it into place, so a symlink planted at the report's path is
    // replaced rather than written through. Also makes the write atomic and
    // leaves the file 0600, which is right for something in a 0700 directory.
    writeFileSecure(target, renderSetupReport(ctx, now));
    return REPORT_PATH;
  } catch {
    return null;
  }
}
