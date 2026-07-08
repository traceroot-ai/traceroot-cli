import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { ApiClient, FindingDetail, TraceExport } from "../../api/client.js";
import { CliError, type Writers, defaultWriters, logProgress } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { contextFromCommand, requireApiClient } from "../shared.js";

/** The four bundle files, in the fixed order they are reported. */
const BUNDLE_FILES = ["trace.json", "spans.json", "git_context.json", "manifest.json"] as const;

/** Injected dependencies for the testable core of `traces export`. */
export interface ExportDeps {
  client: ApiClient;
  traceId: string;
  outputDir?: string;
  force: boolean;
  json: boolean;
  writers: Writers;
  /** Injectable clock for a deterministic default directory name. */
  now?: () => string;
}

/** Replaces filesystem-unsafe characters in a trace id with underscores. */
function sanitizeId(traceId: string): string {
  return traceId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** A filename-safe UTC timestamp, e.g. `2026-06-05T12-00-00Z`. */
function defaultTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+/, "").replace(/:/g, "-");
}

/** Returns true when the directory exists and contains at least one entry. */
function isNonEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Serialises a value as pretty JSON with a trailing newline. */
function toJsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Fetches a trace export bundle and writes its four JSON parts into a
 * directory. Fetching happens before any directory is created, so a failed
 * fetch leaves nothing on disk.
 */
export async function runExport(deps: ExportDeps): Promise<void> {
  const { client, traceId, force, json, writers } = deps;

  // Fetch first: a failure here must not create a half-written bundle dir.
  const response: TraceExport = await client.exportTrace(traceId);

  // Best-effort: include the detector finding (1-per-trace) in the bundle. A 404
  // means "not flagged" (null); any other failure degrades to no finding so a
  // findings-API hiccup never blocks the export.
  let finding: FindingDetail | null = null;
  try {
    finding = await client.findFindingByTrace(traceId);
  } catch {
    finding = null;
  }

  const timestamp = deps.now ? deps.now() : defaultTimestamp();
  const outputDir =
    deps.outputDir ?? join(process.cwd(), `trace_${sanitizeId(traceId)}_${timestamp}`);

  if (!force && isNonEmptyDir(outputDir)) {
    throw new CliError(`output directory ${outputDir} is not empty; pass --force to overwrite`);
  }

  logProgress(`Writing bundle to ${outputDir} …`, writers);
  mkdirSync(outputDir, { recursive: true });

  const contents: Record<(typeof BUNDLE_FILES)[number], unknown> = {
    "trace.json": response.trace,
    "spans.json": response.spans,
    "git_context.json": response.git_context,
    "manifest.json": response.manifest,
  };
  // The trace is fetched before the directory is created, so a fetch failure
  // leaves nothing on disk. A mid-write I/O error here can still leave a partial
  // bundle; re-running (with --force for a non-empty dir) recovers it.
  for (const file of BUNDLE_FILES) {
    writeFileSync(join(outputDir, file), toJsonFile(contents[file]), "utf8");
  }

  // A flagged trace adds a 5th file, `finding.json` (the full FindingDetail —
  // finding id + per-detector results + RCA). The four core files stay unchanged.
  const files: string[] = [...BUNDLE_FILES];
  const findingPath = join(outputDir, "finding.json");
  if (finding !== null) {
    writeFileSync(findingPath, toJsonFile(finding), "utf8");
    files.push("finding.json");
  } else {
    // A --force overwrite of a directory from an earlier *flagged* export could
    // leave behind a finding.json for a different trace; remove it so the bundle
    // never carries a finding that doesn't match trace.json. `force` = no error
    // when the file is absent (the common, unflagged case).
    rmSync(findingPath, { force: true });
  }

  // Confirm what landed on disk, then (when flagged) a yellow one-liner naming
  // the detector(s) and pointing at finding.json — consistent with `traces get`.
  logProgress(`Wrote ${files.length} files: ${files.join(", ")}`, writers);
  if (finding !== null) {
    const by = finding.detectors.length > 0 ? ` by ${finding.detectors.join(", ")}` : "";
    const styler = createStyler(writers.err);
    writers.err.write(
      `${styler.warn(`Flagged${by} — finding ${finding.finding_id} in finding.json`)}\n`,
    );
  }

  if (json) {
    writers.out.write(
      `${JSON.stringify({ output_dir: outputDir, files, finding_id: finding?.finding_id ?? null })}\n`,
    );
  } else {
    writers.out.write(`${outputDir}\n`);
  }
}

export function registerTracesExport(traces: Command): void {
  traces
    .command("export")
    .argument("<traceId>", "trace identifier")
    .option("--output <dir>", "destination directory")
    .option("--force", "overwrite a non-empty output directory")
    .description("Export a trace bundle")
    .action(async (traceId: string, _opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const client = requireApiClient(ctx);
      const opts = command.optsWithGlobals();
      await runExport({
        client,
        traceId,
        outputDir: opts.output as string | undefined,
        force: opts.force === true,
        json: ctx.json,
        writers: defaultWriters,
      });
    });
}
