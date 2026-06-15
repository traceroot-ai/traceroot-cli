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

/** Treats a zone-less backend timestamp as UTC and returns a Date (or null). */
function parseBackendTime(raw: string): Date | null {
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
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")} ${pick("timeZoneName")}`;
}
