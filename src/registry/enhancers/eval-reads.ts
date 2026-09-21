import { REGISTRY } from "@traceroot-ai/tools";
import type { Command } from "commander";
import { type Writers, logProgress, logWarn } from "../../output.js";
import { onceOption } from "../flags.js";

/**
 * The pieces the five evaluation reads share: how an absent value prints, how a
 * cursor-paged command flags an unreachable tail, and the `--limit` flag whose
 * bounds come from the registry rather than from a number copied into this file.
 */

/** `limit`'s declared default and ceiling for one tool, straight from the registry. */
export function limitBounds(tool: string): { serverDefault: number; max: number } {
  const schema = REGISTRY.find((entry) => entry.name === tool)?.inputSchema.properties.limit;
  return {
    serverDefault: typeof schema?.default === "number" ? schema.default : 50,
    max: typeof schema?.maximum === "number" ? schema.maximum : 200,
  };
}

/** The `--limit` flag, described with the bound the server actually enforces. */
export function addLimitFlag(cmd: Command, tool: string, noun: string): Command {
  const { serverDefault, max } = limitBounds(tool);
  return cmd.option(
    "--limit <n>",
    `${noun} to return, 1-${max} (default ${serverDefault})`,
    onceOption("--limit"),
  );
}

/**
 * A value that may legitimately be absent.
 *
 * Never renders `null` as `0` or as a blank cell that reads like one. An absent
 * thing prints as an em dash and stays visibly absent.
 */
export function orDash(value: unknown): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** `(none)` is for a thing that exists and has no value yet — distinct from unknown. */
export function orNone(value: unknown): string {
  return value === null || value === undefined || value === "" ? "(none)" : String(value);
}

/** A timestamp trimmed to the day. `--json` carries the exact value; the table is for reading. */
export function day(value: unknown): string {
  if (typeof value !== "string" || value === "") return "—";
  const at = value.indexOf("T");
  return at === -1 ? value : value.slice(0, at);
}

/** One-line JSON for a table cell, clipped so a wide input cannot break the layout. */
export function compact(value: unknown, width: number): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length <= width ? oneLine : `${oneLine.slice(0, width - 1)}…`;
}

/** `<n> thing(s)`, pluralised. */
export function countLine(count: number, noun: string, writers: Writers): void {
  logProgress(`${count} ${noun}${count === 1 ? "" : "s"}`, writers);
}

/**
 * Says, out loud, when a page is all there is.
 *
 * These routes are cursor-paged and the CLI deliberately exposes no `--cursor`,
 * so a result set larger than one page has an unreachable tail — and the only
 * dishonest option is to print a full-looking table and say nothing.
 *
 * Triggered by evidence rather than arithmetic: a `next_cursor` is the server
 * saying there is more. The "page looks exactly full" fallback catches a server
 * that sends none, at the cost of an occasional false positive on an exactly
 * full last page, which is the safe direction to be wrong in.
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
  const pageSize = requested ?? serverDefault;
  const hasMore =
    (typeof nextCursor === "string" && nextCursor !== "") || (received > 0 && received >= pageSize);
  if (!hasMore) return;
  const ceiling = requested === undefined ? "" : ` (--limit ${requested})`;
  logWarn(
    `showing ${received} ${noun}${ceiling} and there are more. This command reads ONE page: ` +
      `raise --limit up to ${max} to widen it. There is no cursor flag, so anything beyond ` +
      `${max} ${noun} is not reachable from the CLI.`,
    writers,
  );
}

/** State a paged read threads from `resolveArgs` to `render`. */
export interface PagedState {
  limit?: number;
}
