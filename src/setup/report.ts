import { join, relative, sep } from "node:path";
import { displaySkillPath, isInsideDirectory, requireAgent } from "../agents/index.js";
import { writeFileSecure } from "../util/secureFile.js";
import { applicationEnvKeys } from "./envWrite.js";
import { setupCommand } from "./invocation.js";
import { nameList } from "./production.js";
import { spanPhrase } from "./trace.js";
import type { ApplicationKeyLocation, SetupContext } from "./types.js";

/**
 * The record a setup run leaves behind.
 *
 * Everything a run establishes — what it found, what it changed, which trace
 * proved it — is printed to stderr and then gone. That is exactly the material
 * a reviewer wants when the resulting diff arrives as a pull request, and
 * exactly what the author has to reconstruct from memory instead.
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

/**
 * The variables a deployment needs, as code spans in a sentence.
 *
 * Asked of {@link applicationEnvKeys} rather than written out, which is what
 * keeps this in step with the file the run wrote and the notice it printed: off
 * the default host the application needs `TRACEROOT_HOST_URL` as well, and a
 * report that named the key alone would reproduce exactly the omission that
 * silently sends a self-hosted user's traces to the wrong instance.
 *
 * Joined by {@link nameList}, the same helper the closing notice and the
 * closing sentence use, so the one rule this phrase follows — names in a
 * sentence, no Oxford comma — is stated once rather than reproduced here.
 */
function productionKeys(host: string | undefined): string {
  return nameList(applicationEnvKeys(host).map((name) => `\`${name}\``));
}

function line(label: string, value: string | null | undefined): string {
  const text = value === null || value === undefined || value === "" ? "—" : cell(value);
  return `| ${label} | ${text} |`;
}

/**
 * The skill's row in the table of files the run touched, at the path the
 * agent's own adapter installs it to.
 *
 * Not one fixed path: each agent reads skills from a directory of its own, and
 * Codex's is in the user's home — outside the repository, where `git diff`
 * cannot show the write. A row naming `.claude/` for every agent sent the
 * reader to a directory the run never created, and left that write out.
 */
function skillRow(root: string, agentId: string): string {
  const target = requireAgent(agentId).getSkillInstallPath(root, "traceroot-instrument-repo");
  const path = `\`${cell(slashPath(displaySkillPath(root, target)))}/\``;
  return isInsideDirectory(root, target)
    ? `| ${path} | The instrumentation skill. |`
    : `| ${path} | The instrumentation skill, outside this repository. |`;
}

/**
 * Renders the report.
 *
 * Never includes a credential. The key is represented by its hint and id,
 * which is the same rule the checkpoint follows — a report is a file people
 * paste into pull requests, which is the last place a secret should be able to
 * reach.
 *
 * `keyLocation` is where the key sits on this machine, as
 * `applicationKeyLocation` answers it (see {@link ApplicationKeyLocation}).
 * Required, so that function stays the one rule for it. The context alone
 * cannot answer: a key already in the project's own `.env` skips
 * `configure_repository`, which leaves `credentialEnvFile` unset over a file
 * the application genuinely loads.
 */
export function renderSetupReport(
  ctx: SetupContext,
  now: Date,
  keyLocation: ApplicationKeyLocation,
): string {
  const cp = ctx.checkpoint;
  const service = cp.service;
  const trace = ctx.trace;
  // The file to copy the value out of, or null when there is no file to name.
  // `relativeToRoot` has already made the location's path root-relative with
  // `/` separators.
  const keyFile = keyLocation.kind === "file" ? keyLocation.path : null;

  const verdict =
    trace !== undefined
      ? "TraceRoot is connected and a trace has been received."
      : "TraceRoot is configured, but no trace has been seen yet.";

  // One entry per line, and `""` is a blank line: Markdown ends a paragraph or
  // a table only at one, so they are the report's structure. An optional entry
  // is spread in or left out rather than written as `""` and filtered, because
  // that filter took every blank line with it — the verdict ran into the line
  // below it, and the closing note was read as a row of the last table.
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
    // The count beside the id: the one thing the report says about how much of
    // the application the trace shows, and said as a number rather than a
    // verdict, because whether it is enough depends on the program. A reader
    // who finds no number knows the deployment did not report one rather than
    // being left to read something into its absence.
    trace !== undefined
      ? `**First trace.** \`${trace.traceId}\`${trace.spanCount === undefined ? "" : ` — ${spanPhrase(trace.spanCount)}`}${trace.attributed === false ? ". Not confirmed to come from this service: the project already had traces before setup started." : ""}\n\n${trace.traceUrl}`
      : `**First trace.** None yet. Run the application, then \`${setupCommand()} --resume\`.`,
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
    ...(ctx.credentialEnvFile !== undefined
      ? [
          `| \`${cell(slashPath(relative(ctx.root, ctx.credentialEnvFile)))}\` | \`TRACEROOT_API_KEY\` for the application. |`,
        ]
      : []),
    "| `.traceroot/config.json` | The CLI's own credential. Git-ignored. |",
    "| `.traceroot/setup.json` | Checkpoint, so `--resume` can continue. |",
    ...(ctx.agent !== undefined ? [skillRow(ctx.root, ctx.agent.id)] : []),
    "",
    "Application files changed by the agent are not listed here — `git diff` is the",
    "authority on those, and duplicating it would only go stale.",
    "",
    // The one thing the run did not do, said in the file that outlives the run.
    //
    // The terminal block that asks for this is seen once, by one person, at the
    // end of a long wizard. This report is what a reviewer reads when the diff
    // arrives as a pull request, and what the author reads a week later — and
    // the gap it has to close is the same one: everything above is about a
    // laptop, nothing in the repository carries the key, and a deployment of
    // this diff emits nothing until someone sets the variables. A report whose
    // last word is "a trace has been received" lets that be discovered in
    // production.
    //
    // Variables, never the value. Same rule as the key row above, and the same
    // source of truth as the closing notice, so a non-default host's second
    // variable is named here too.
    "## What production still needs",
    "",
    `${productionKeys(cp.host)} in your deployment's own environment.`,
    "",
    // Where to copy it from, and only when there is somewhere. A run that wrote
    // no file has nothing to point at, and pointing anyway is what sends a
    // reader looking for a file the repository does not contain.
    //
    // "Wrote no file" and "has nowhere to point" are not the same run, which is
    // why this asks the key's location rather than the file this run wrote: a
    // key already in the project's own `.env` is in the file the application
    // loads, and saying nothing carries it would be false about the file the
    // reader is most likely to already have open.
    keyFile !== null
      ? `The value is in \`${cell(keyFile)}\`, which stays on this machine — nothing in the repository carries it.`
      : "This run wrote the value to no file in the project, so nothing here carries it.",
  ];

  return `${sections.join("\n")}\n`;
}

/**
 * Writes the report, returning its path.
 *
 * Best-effort by design: a run that connected TraceRoot, instrumented an
 * application and saw a trace has succeeded, and failing it at the last step
 * over a file nobody has read yet would be absurd.
 */
export function writeSetupReport(
  ctx: SetupContext,
  now: Date,
  keyLocation: ApplicationKeyLocation,
): string | null {
  const target = join(ctx.root, REPORT_PATH);
  try {
    // Creates `.traceroot/` 0700, writes a fresh temp file exclusively and
    // renames it into place, so a symlink planted at the report's path is
    // replaced rather than written through. Also makes the write atomic and
    // leaves the file 0600, which is right for something in a 0700 directory.
    writeFileSecure(target, renderSetupReport(ctx, now, keyLocation));
    return REPORT_PATH;
  } catch {
    return null;
  }
}
