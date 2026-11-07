import { REGISTRY } from "@traceroot-ai/tools";
import type { Command } from "commander";
import { CliError, ExitCode, type Writers, logProgress, logWarn } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { formatTimestamp } from "../../util/index.js";
import { onceOption } from "../flags.js";
import { sanitize } from "./sql.js";
import type { ResolveInput } from "./types.js";

/**
 * The pieces the five evaluation reads share: how an absent value prints, how a
 * cursor-paged command says there is a next page and how to read it, and the
 * `--limit` and `--cursor` flags.
 */

/**
 * A contract type as a defensive renderer reads it: any field may be missing or
 * null, at any depth, so an older or newer server never crashes a table. The field
 * NAMES and value types still come from the contract, so a field the renderer uses
 * that is renamed, dropped or retyped there is a type error here.
 */
export type Wire<T> = T extends readonly (infer U)[]
  ? Wire<U>[]
  : T extends object
    ? { [K in keyof T]?: Wire<T[K]> | null }
    : T;

/**
 * `limit`'s declared default and ceiling for one tool, straight from the registry.
 *
 * `serverDefault` is undefined when the tool declares none: without a limit,
 * `get_dataset_version` returns the whole version, which no page size describes.
 * A tool with no `limit` ceiling, or a misspelled tool name, is a programming
 * error, and it throws rather than falling back to a number from this file.
 */
export function limitBounds(tool: string): { serverDefault: number | undefined; max: number } {
  const schema = REGISTRY.find((entry) => entry.name === tool)?.inputSchema.properties.limit;
  if (typeof schema?.maximum !== "number") {
    throw new Error(`registry tool '${tool}' declares no limit ceiling`);
  }
  return {
    serverDefault: typeof schema.default === "number" ? schema.default : undefined,
    max: schema.maximum,
  };
}

/**
 * The `--limit` flag, described with the bound the server actually enforces.
 * `cliDefault` is for a read whose server default is "everything" — the CLI
 * always sends that default, so it is the one the help text names.
 */
export function addLimitFlag(
  cmd: Command,
  tool: string,
  noun: string,
  cliDefault?: number,
): Command {
  const { serverDefault, max } = limitBounds(tool);
  const shown = cliDefault ?? serverDefault;
  return cmd.option(
    "--limit <n>",
    `${noun} to return, 1-${max}${shown === undefined ? "" : ` (default ${shown})`}`,
    onceOption("--limit"),
  );
}

/**
 * The `--cursor` flag. Its value is the `next_cursor` a previous page returned,
 * passed back as it came: the server owns what a cursor means and rejects one
 * that names no row in the set being paged.
 */
export function addCursorFlag(cmd: Command): Command {
  return cmd.option(
    "--cursor <cursor>",
    "read the page after a previous one: the next_cursor it returned",
    onceOption("--cursor"),
  );
}

/**
 * `--cursor`, validated. An empty cursor is a usage error rather than "the first
 * page": it is a variable that expanded to nothing, and reading page one again
 * would loop a script forever.
 */
export function parseCursor(input: ResolveInput): string | undefined {
  const cursor = input.opts.cursor as string | undefined;
  if (cursor !== undefined && cursor.trim() === "") {
    throw new CliError("--cursor must not be empty", ExitCode.usage);
  }
  return cursor;
}

/**
 * Server text, safe to print. Dataset names, case inputs and run URLs come from
 * whatever the SDK or a captured trace stored, so control characters are escaped
 * rather than sent to the terminal, where ESC and OSC sequences would act on it.
 */
export function clean(value: unknown): string {
  return sanitize(String(value));
}

/**
 * A value that may legitimately be absent.
 *
 * Never renders `null` as `0` or as a blank cell that reads like one. An absent
 * thing prints as an em dash and stays visibly absent.
 */
export function orDash(value: unknown): string {
  return value === null || value === undefined || value === "" ? "—" : clean(value);
}

/** `(none)` is for a thing that exists and has no value yet — distinct from unknown. */
export function orNone(value: unknown): string {
  return value === null || value === undefined || value === "" ? "(none)" : clean(value);
}

/**
 * A timestamp in local time with its zone, as every other curated command shows
 * one. Slicing the date out of the UTC string would put an evening version on the
 * wrong day east of UTC. `timeZone` is for deterministic tests.
 */
export function when(value: unknown, timeZone?: string): string {
  if (typeof value !== "string" || value === "") return "—";
  return clean(formatTimestamp(value, timeZone));
}

/** One-line JSON for a table cell, clipped so a wide input cannot break the layout. */
export function compact(value: unknown, width: number): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = sanitize(text.replace(/\s+/g, " "));
  return oneLine.length <= width ? oneLine : `${oneLine.slice(0, width - 1)}…`;
}

/** `noun` as it reads after `count`: "1 case", "2 cases". */
export function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** A block of bold, aligned `label  value` lines, for a record's identity. */
export function renderFields(fields: [string, string][], writers: Writers): void {
  const styler = createStyler(writers.out);
  const width = Math.max(...fields.map(([label]) => label.length));
  for (const [label, value] of fields) {
    writers.out.write(`${styler.bold(label.padEnd(width))}  ${value}\n`);
  }
}

/** `<n> thing(s)`, pluralised. */
export function countLine(count: number, noun: string, writers: Writers): void {
  logProgress(`${count} ${plural(count, noun)}`, writers);
}

/**
 * What to say when a page came back empty.
 *
 * An empty PAGE and an empty RESULT are different facts, and only the response
 * can tell them apart: a `next_cursor` means the server has more to give, so
 * "no datasets" would be a claim about the project that the payload does not
 * support. `--json` already warns on this response — it hands the body over and
 * calls {@link warnIfCapped} unconditionally — so an early return here would
 * make the two output modes disagree about the same bytes.
 */
export function renderEmptyPage(
  message: string,
  requested: number | undefined,
  tool: string,
  nextCursor: unknown,
  noun: string,
  writers: Writers,
): void {
  const hasMore = typeof nextCursor === "string" && nextCursor !== "";
  logProgress(hasMore ? `no ${plural(2, noun)} on this page` : message, writers);
  warnIfCapped(0, requested, tool, nextCursor, noun, writers);
}

/**
 * Says, out loud, when a page is not all there is, and how to read the next one.
 *
 * Triggered by evidence rather than arithmetic. When the response carries
 * `next_cursor` at all, it is the answer: a string means more, `null` means this
 * was the last page — even when that page happens to be exactly full. Only a
 * response with no `next_cursor` field falls back to "the page came back full",
 * where an occasional false positive is the safe direction to be wrong in. `noun`
 * is singular ("case"), and pluralised to match each count.
 *
 * The hint names the flag and the cursor, not a whole command line: rebuilding
 * argv would echo a global `--api-key` into a terminal or a CI log.
 */
export function warnIfCapped(
  received: number,
  requested: number | undefined,
  tool: string,
  nextCursor: unknown,
  noun: string,
  writers: Writers,
): void {
  const { serverDefault, max } = limitBounds(tool);
  // Without an explicit --limit the page size is the SERVER's default, not the
  // number that came back — comparing against what arrived would make every page
  // look full and warn on every call, which trains people to ignore the warning.
  // With no page size at all, the server sent everything it had.
  const pageSize = requested ?? serverDefault;
  const ceiling = requested === undefined ? "" : ` (--limit ${requested})`;
  const shown = `showing ${received} ${plural(received, noun)}${ceiling}`;
  if (typeof nextCursor === "string" && nextCursor !== "") {
    logWarn(
      `${shown} and there are more. For the next page, run this command again with ` +
        `--cursor ${clean(nextCursor)}`,
      writers,
    );
    return;
  }
  const full =
    nextCursor === undefined && pageSize !== undefined && received > 0 && received >= pageSize;
  if (!full) return;
  // A full page and no cursor to continue from: all that is left is to widen the
  // page. At the maximum there is nothing left to raise, so the advice changes
  // rather than telling someone to do what they already did.
  const widen =
    pageSize >= max
      ? `The page came back full with no cursor to continue from, and ${max} is the most a page holds.`
      : `The page came back full with no cursor to continue from: raise --limit up to ${max} to widen it.`;
  logWarn(`${shown} and there are more. ${widen}`, writers);
}

/** State a paged read threads from `resolveArgs` to `render`. */
export interface PagedState {
  limit?: number;
  /** The `--cursor` this page was read after; an empty page then says "no more". */
  cursor?: string;
}
