import { type Sink, colorEnabled } from "../output.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
// Bright red — the single error color, matching `colorizeError` and error spans.
const ANSI_RED = "\x1b[91m";
const ANSI_DIM = "\x1b[2m";

/** The three states a status row can be in. */
export type StatusKind = "pass" | "warn" | "fail";

/**
 * Renders the leading status glyph for a human-readable status row, colored only
 * when {@link colorEnabled} is true for `sink` (a TTY with `NO_COLOR` unset):
 * green `✓` for pass/ready, dim `-` for a neutral/optional/not-yet state, red `✗`
 * for failure. Centralized so `doctor` and `skills list` share one convention.
 */
export function statusSymbol(
  kind: StatusKind,
  sink: Sink,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const on = colorEnabled(sink, env);
  if (kind === "fail") {
    return on ? `${ANSI_RED}✗${ANSI_RESET}` : "✗";
  }
  if (kind === "warn") {
    return on ? `${ANSI_DIM}-${ANSI_RESET}` : "-";
  }
  return on ? `${ANSI_GREEN}✓${ANSI_RESET}` : "✓";
}
