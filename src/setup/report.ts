import { join, relative, sep } from "node:path";
import { writeFileSecure } from "../util/secureFile.js";
import { isThinTrace, spanPhrase, thinTraceFinding } from "./trace.js";
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

/**
 * A filesystem path with `/` separators, whatever platform the run was on.
 *
 * `relative()` separates with a backslash on Windows, and {@link cell} escapes
 * every backslash so Markdown prints the character rather than eating it — so
 * the code span in the report carries two of them per separator, which is not a
 * path anyone can paste. Splitting on the platform's own separator rather than
 * on every backslash is what leaves a POSIX filename that genuinely contains one
 * intact; `separator` is a parameter so that behaviour can be pinned from a test
 * on either platform.
 */
export function slashPath(path: string, separator: string = sep): string {
  return path.split(separator).join("/");
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

  // Three answers rather than two, because "a trace has been received" is true
  // of a trace that covers one function and reads as though it covers the
  // application. A run ended on that sentence over a single-span trace, and the
  // user was told their instrumentation worked. So the verdict carries what was
  // found when what was found is small: this is the line a reader skims, and
  // the line that gets pasted into a pull request.
  //
  // What it does not do is guess at the application's shape — it reports the
  // count, says what one span can and cannot establish, and leaves the
  // judgement where the knowledge of the program is.
  const verdict =
    trace === undefined
      ? "TraceRoot is configured, but no trace has been seen yet."
      : isThinTrace(trace.spanCount)
        ? `TraceRoot is connected and a trace has been received, but that trace ${thinTraceFinding(trace.spanCount)}. Check that the instrumentation covers the code you meant it to.`
        : "TraceRoot is connected and a trace has been received.";

  // Four answers, because the fourth is the one a reader acts on differently.
  // "Did not pass" over a suite that was already red sent people to look for a
  // fault in instrumentation that had just been done correctly, so the
  // inconclusive case says what was measured and when.
  //
  // Inconclusive has two readings and they are not interchangeable here. One
  // reports a measurement; the other reports that there was none. A report that
  // printed the first over the second would be asserting a prior failure
  // nothing observed, which is the same kind of invented cause this field
  // exists to stop — pointed the other way.
  const inconclusive =
    app?.baseline?.ran === true
      ? `Inconclusive. \`${app.command}\` was already failing before anything was instrumented${app.baseline.exitCode === null ? "" : ` (exit ${app.baseline.exitCode})`}, so its result afterwards says nothing about the instrumentation.`
      : `Inconclusive. \`${app?.command}\` does not pass, and nothing ran it before the code was instrumented, so this run cannot say whether the instrumentation is why.`;
  const checks =
    app === undefined
      ? "Not run."
      : app.outcome === "skipped"
        ? `Not run — ${app.skippedReason ?? "no command to run"}.`
        : app.outcome === "passed"
          ? "Passed both with and without `TRACEROOT_API_KEY`, so the application does not depend on TraceRoot being configured."
          : app.outcome === "inconclusive"
            ? inconclusive
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
    line("Service", service === undefined ? undefined : slashPath(service.path)),
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
    // The count beside the id, for every trace and not only a small one. A
    // reviewer reading this over a healthy trace gets the number that the
    // qualified verdict would otherwise be the only way to see, and a reader who
    // finds no number knows the deployment did not report one rather than being
    // left to read something into its absence.
    trace !== undefined
      ? `**First trace.** \`${trace.traceId}\`${trace.spanCount === undefined ? "" : ` — ${spanPhrase(trace.spanCount)}`}\n\n${trace.traceUrl}`
      : "**First trace.** None yet. Run the application, then `traceroot setup --resume`.",
    "",
    "## Files this run touched",
    "",
    "| Path | Why |",
    "|---|---|",
    // The credential's own row only when a credential was written. The file is
    // one of the project's own now, so neither its name nor its presence is a
    // constant: `configure_repository` refuses a file git tracks, and does not
    // run at all when the application already resolves the key. Printing the row
    // regardless claimed a file this run never touched, and "Git-ignored" went
    // from a thing setup arranged to a thing setup only checks.
    ctx.credentialEnvFile !== undefined
      ? `| \`${cell(slashPath(relative(ctx.root, ctx.credentialEnvFile)))}\` | \`TRACEROOT_API_KEY\` for the application. |`
      : "",
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
