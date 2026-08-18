import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { FindingDetail, TraceExport } from "../../api/client.js";
import { CliError, type Writers, logProgress } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { rejectExtras } from "../flags.js";
import { onceOption } from "../flags.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./types.js";

/** The four bundle files, in the fixed order they are reported. */
const BUNDLE_FILES = ["trace.json", "spans.json", "git_context.json", "manifest.json"] as const;

/** Injected dependencies for the testable core of `traces export`. */
export interface ExportDeps {
  traceId: string;
  outputDir?: string;
  force: boolean;
  json: boolean;
  writers: Writers;
  /** Injectable clock for a deterministic default directory name. */
  now?: () => string;
  /** Best-effort finding lookup; resolves to null when there is none. */
  getFinding: (traceId: string) => Promise<FindingDetail | null>;
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
 * Writes an already-fetched trace export bundle's four JSON parts into a
 * directory. The trace itself is fetched by the factory before `render` runs,
 * so a failed fetch never reaches here and never leaves a half-written bundle
 * dir behind.
 */
export async function runExport(response: TraceExport, deps: ExportDeps): Promise<void> {
  const { traceId, force, json, writers } = deps;

  // Best-effort: include the detector finding (1-per-trace) in the bundle. A 404
  // means "not flagged" (null); any other API failure degrades to no finding so
  // a findings-API hiccup never blocks the export. Contract: `deps.getFinding`
  // never rejects for API failures — production wires it to
  // `ctx.dispatchToolOptional`, which resolves null on dispatch failure while
  // letting the factory's internal assertions throw. No catch here, so a
  // programming bug can never masquerade as "no finding".
  const finding: FindingDetail | null = await deps.getFinding(traceId);

  const timestamp = deps.now ? deps.now() : defaultTimestamp();
  const outputDir =
    deps.outputDir ?? join(process.cwd(), `trace_${sanitizeId(traceId)}_${timestamp}`);

  if (!force && isNonEmptyDir(outputDir)) {
    throw new CliError(`output directory ${outputDir} is not empty; pass --force to overwrite`);
  }

  logProgress(`Writing bundle to ${outputDir} …`, writers);
  mkdirSync(outputDir, { recursive: true });

  // A flagged trace adds a 5th file, `finding.json` (the full FindingDetail —
  // finding id + per-detector results + RCA). Computed up front so the manifest
  // written to disk, the stderr summary, and the --json summary all report the
  // exact same file list — the server's manifest doesn't know about the finding,
  // which the CLI fetches separately, so it must be patched here.
  const files: string[] = finding !== null ? [...BUNDLE_FILES, "finding.json"] : [...BUNDLE_FILES];

  const contents: Record<(typeof BUNDLE_FILES)[number], unknown> = {
    "trace.json": response.trace,
    "spans.json": response.spans,
    "git_context.json": response.git_context,
    // Spread-then-override preserves key order and leaves bundle_version,
    // project_id, trace_id untouched; only `files` reflects the finding.
    "manifest.json": { ...response.manifest, files },
  };
  // The trace is fetched before the directory is created, so a fetch failure
  // leaves nothing on disk. A mid-write I/O error here can still leave a partial
  // bundle; re-running (with --force for a non-empty dir) recovers it.
  for (const file of BUNDLE_FILES) {
    writeFileSync(join(outputDir, file), toJsonFile(contents[file]), "utf8");
  }

  const findingPath = join(outputDir, "finding.json");
  if (finding !== null) {
    writeFileSync(findingPath, toJsonFile(finding), "utf8");
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

/** State threaded from `resolveArgs` to `render`. */
interface ExportState {
  output?: string;
  force: boolean;
  traceId: string;
}

export const tracesExport: Enhancer = {
  description: "Export a trace bundle",
  arguments(cmd: Command): void {
    cmd.argument("<traceId>", "trace identifier");
  },
  flags(cmd: Command): void {
    cmd
      .option("--output <dir>", "destination directory")
      .option("--force", "overwrite a non-empty output directory")
      .option(
        "--fields <groups>",
        "field projection to request, e.g. full or io,metadata. Export defaults to the full " +
          "projection (span input/output/metadata included); pass --fields to narrow it.",
        onceOption("--fields"),
      );
  },
  resolveArgs(input: ResolveInput): Resolved {
    rejectExtras(input);
    const traceId = input.positionals.trace_id as string;
    const fields = input.opts.fields as string | undefined;
    const state: ExportState = {
      output: input.opts.output as string | undefined,
      force: input.opts.force === true,
      traceId,
    };
    return {
      args: { trace_id: traceId, ...(fields !== undefined ? { fields } : {}) },
      state,
    };
  },
  async render(payload: unknown, ctx: RenderContext): Promise<void> {
    const state = ctx.state as ExportState;
    await runExport(payload as TraceExport, {
      traceId: state.traceId,
      outputDir: state.output,
      force: state.force,
      json: ctx.json,
      writers: ctx.writers,
      getFinding: (traceId) =>
        ctx
          .dispatchToolOptional("get_finding_by_trace", { trace_id: traceId })
          .then((result) => result as FindingDetail | null),
    });
  },
};
