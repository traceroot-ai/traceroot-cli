import { CliError } from "../output.js";

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parses a relative duration like `30m`, `6h`, `7d`, or `2w` into milliseconds.
 * Units: `s` seconds, `m` minutes, `h` hours, `d` days, `w` weeks. Throws a
 * {@link CliError} for anything that is not a positive integer count followed by
 * a single supported unit.
 */
export function parseDuration(raw: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(raw.trim());
  if (match === null) {
    throw new CliError(
      `invalid duration: "${raw}" (expected a count and unit, e.g. 30m, 6h, 7d, 2w)`,
    );
  }
  const count = Number.parseInt(match[1] as string, 10);
  if (count < 1) {
    throw new CliError(`invalid duration: "${raw}" (must be a positive amount)`);
  }
  return count * (DURATION_UNITS_MS[match[2] as string] as number);
}

/**
 * Formats a millisecond duration as a compact human string: under one second
 * renders as whole milliseconds (`"850ms"`), otherwise seconds with one decimal
 * (`"1.5s"`). `null` renders as the empty string. Shared by `traces list` (which
 * gets `duration_ms` from the backend) and `traces get` (which derives it from
 * span timestamps).
 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "";
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Formats a byte count for humans: thousands-separated, with a one-decimal KB
 * value in parentheses, e.g. `534922` → `"534,922 bytes (534.9 KB)"`. The raw
 * numeric value is preserved in JSON output; this is for human-readable lines
 * only.
 */
export function formatBytes(bytes: number): string {
  const grouped = Math.trunc(bytes)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const kb = (bytes / 1000).toFixed(1);
  return `${grouped} bytes (${kb} KB)`;
}

/** Treats a zone-less backend timestamp as UTC and returns a Date (or null). */
export function parseBackendTime(raw: string): Date | null {
  // Backend timestamps are naive UTC, e.g. "2026-06-04T23:43:13.590000" (no
  // suffix). JS would parse a zone-less datetime as LOCAL, so append `Z`.
  const hasZone = /([zZ])$|([+-]\d{2}:?\d{2})$/.test(raw);
  const date = new Date(hasZone ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Renders a backend timestamp in a readable, unambiguous form: local time with
 * an explicit timezone label (e.g. `2026-06-04 16:43:13 PDT`), since the backend
 * sends zone-less UTC. `timeZone` overrides the local zone (used by tests for
 * deterministic output). Falls back to the raw string if it can't be parsed.
 */
export function formatTimestamp(raw: string, timeZone?: string): string {
  const date = parseBackendTime(raw);
  if (date === null) {
    return raw;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU builds render local midnight as "24" with hour12:false — normalize
  // to "00" so midnight is "00:00:00" consistently across platforms.
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}:${pick("second")} ${pick("timeZoneName")}`;
}
