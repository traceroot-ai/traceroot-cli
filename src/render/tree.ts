import { elapsedMs, formatDuration } from "../util/index.js";

/**
 * Minimal structural shape a span needs to be rendered as a tree. A superset of
 * the fields of `SpanResponse` used here, kept local so the renderer stays a
 * pure, dependency-free string transform.
 */
export interface SpanLike {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  status?: string;
  span_start_time?: string;
  /** End timestamp, or `null`/absent while the span is still running. */
  span_end_time?: string | null;
  /** Error detail, shown as its own line beneath an errored span. */
  status_message?: string | null;
  /** LLM model name; presence triggers the compact model/token/cost detail. */
  model_name?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  cost?: number | null;
}

const ERROR_STATUSES = new Set(["ERROR", "error", "STATUS_CODE_ERROR"]);

// Bright (not dark) red so an errored span reads clearly on dark and light
// terminals; applied to the whole line, gated behind the `color` option.
const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[91m";
// Dim, for the secondary LLM model/token/cost detail line, so it reads as
// supplementary rather than competing with the span line itself.
const ANSI_DIM = "\x1b[2m";

/** Default terminal width assumed when {@link RenderTreeOptions.width} is omitted. */
const DEFAULT_WIDTH = 80;

function isError(status: string | undefined): boolean {
  return status !== undefined && ERROR_STATUSES.has(status);
}

function marker(status: string | undefined): string {
  return isError(status) ? "[error]" : "[ok]";
}

function sortKey(span: SpanLike, index: number): [string, number] {
  return [span.span_start_time ?? "", index];
}

/**
 * Compact token count for the LLM detail line, e.g. `850` → `"850 tok"`,
 * `1200` → `"1.2k tok"`. Values at or above 1000 collapse to one decimal of
 * thousands (trailing `.0` dropped) so the detail stays a single glanceable
 * token.
 */
function formatTokens(count: number): string {
  if (count < 1000) {
    return `${count} tok`;
  }
  const thousands = (count / 1000).toFixed(1).replace(/\.0$/, "");
  return `${thousands}k tok`;
}

/** `total_tokens` if present, else `input_tokens + output_tokens`; null if neither is known. */
function tokenCount(span: SpanLike): number | null {
  if (span.total_tokens !== undefined && span.total_tokens !== null) {
    return span.total_tokens;
  }
  if (
    (span.input_tokens !== undefined && span.input_tokens !== null) ||
    (span.output_tokens !== undefined && span.output_tokens !== null)
  ) {
    return (span.input_tokens ?? 0) + (span.output_tokens ?? 0);
  }
  return null;
}

/**
 * Compact `model · N tok · $cost` detail for an LLM span, or null when the
 * span has no `model_name`. Tokens and cost are each omitted individually when
 * unknown, so a span with only a model name still renders that much.
 */
function llmDetail(span: SpanLike): string | null {
  if (span.model_name === undefined || span.model_name === null || span.model_name === "") {
    return null;
  }
  const parts = [span.model_name];
  const tokens = tokenCount(span);
  if (tokens !== null) {
    parts.push(formatTokens(tokens));
  }
  if (span.cost !== undefined && span.cost !== null) {
    parts.push(`$${span.cost.toFixed(4)}`);
  }
  return parts.join(" · ");
}

/** Optional behavior for {@link renderTree}. */
export interface RenderTreeOptions {
  /** When true, error span lines are colored red. Off for non-TTY / `NO_COLOR`. */
  color?: boolean;
  /**
   * Terminal width: durations are right-aligned to this column and error
   * messages are truncated to it. Defaults to 80.
   */
  width?: number;
  /**
   * ISO timestamp used as "now" for the elapsed-so-far duration of a span with
   * no `span_end_time` (still running). Passed in — rather than read via
   * `Date.now()` inside the renderer — so this stays a pure, testable
   * transform and agrees with whatever "now" the caller used for its own live
   * elapsed display (e.g. the `traces get` header).
   */
  now?: string;
}

/**
 * Renders spans as an indented ASCII tree built from `parent_span_id`. Roots are
 * spans whose parent is null or absent from the set (orphans). Siblings are
 * ordered by start time, falling back to input order for stability.
 */
export function renderTree(spans: SpanLike[], options: RenderTreeOptions = {}): string {
  if (spans.length === 0) {
    return "";
  }
  const color = options.color === true;
  const width = options.width ?? DEFAULT_WIDTH;
  const now = options.now;

  const indexOf = new Map<string, number>();
  for (const [i, span] of spans.entries()) {
    indexOf.set(span.span_id, i);
  }

  const childrenOf = new Map<string, SpanLike[]>();
  const roots: SpanLike[] = [];
  for (const span of spans) {
    const parent = span.parent_span_id;
    if (parent !== null && indexOf.has(parent)) {
      const siblings = childrenOf.get(parent) ?? [];
      siblings.push(span);
      childrenOf.set(parent, siblings);
    } else {
      roots.push(span);
    }
  }

  const byStart = (a: SpanLike, b: SpanLike): number => {
    const [ak, ai] = sortKey(a, indexOf.get(a.span_id) ?? 0);
    const [bk, bi] = sortKey(b, indexOf.get(b.span_id) ?? 0);
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return ai - bi;
  };

  const lines: string[] = [];
  // Guards against re-visiting a span: prevents infinite recursion and silent
  // duplication if the external span data contains a parent cycle.
  const visited = new Set<string>();

  const walk = (span: SpanLike, prefix: string, isLast: boolean, isRoot: boolean): void => {
    if (visited.has(span.span_id)) {
      return;
    }
    visited.add(span.span_id);
    const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const text = `${prefix}${connector}${span.name} ${marker(span.status)}`;
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");

    // Duration, right-aligned to `width`: end time if the span has finished,
    // otherwise elapsed-so-far against `now` (only when the caller supplied
    // one — a still-running span with no `now` simply shows no duration
    // rather than silently computing one from a fresh `Date.now()`).
    const end = span.span_end_time ?? now ?? null;
    const durationMs =
      span.span_start_time !== undefined ? elapsedMs(span.span_start_time, end) : null;
    const durationText = durationMs !== null ? formatDuration(durationMs) : null;
    const lineCore =
      durationText === null
        ? text
        : `${text}${" ".repeat(Math.max(1, width - text.length - durationText.length))}${durationText}`;
    lines.push(color && isError(span.status) ? `${ANSI_RED}${lineCore}${ANSI_RESET}` : lineCore);

    // Error detail, directly beneath the span line, indented to align under
    // the name (the same indent children continue at) and truncated to width.
    if (isError(span.status) && span.status_message !== undefined && span.status_message !== null) {
      const trimmed = span.status_message.trim();
      if (trimmed.length > 0) {
        const msgText = `${childPrefix}${truncate(trimmed, Math.max(10, width - childPrefix.length))}`;
        lines.push(color ? `${ANSI_RED}${msgText}${ANSI_RESET}` : msgText);
      }
    }

    // Compact LLM detail (model · tokens · cost), dim, on its own line.
    const detail = llmDetail(span);
    if (detail !== null) {
      const detailText = `${childPrefix}${detail}`;
      lines.push(color ? `${ANSI_DIM}${detailText}${ANSI_RESET}` : detailText);
    }

    const children = [...(childrenOf.get(span.span_id) ?? [])].sort(byStart);
    for (const [i, child] of children.entries()) {
      walk(child, childPrefix, i === children.length - 1, false);
    }
  };

  const sortedRoots = [...roots].sort(byStart);
  for (const root of sortedRoots) {
    walk(root, "", true, true);
  }
  // Recover any spans never reached from a root (e.g. members of a parent cycle
  // in malformed data) as additional roots, so nothing is silently dropped.
  for (const span of spans) {
    if (!visited.has(span.span_id)) {
      walk(span, "", true, true);
    }
  }

  return lines.join("\n");
}

/** Hint appended to truncated text; budgeted into {@link truncate}'s `max`. */
const TRUNCATION_SUFFIX = "… (truncated)";

/**
 * Returns `text` unchanged when its length is at most `max`, otherwise a
 * truncated form whose TOTAL length (kept text plus the truncation hint) is at
 * most `max`, so callers can budget it against a terminal width. When `max` is
 * too small to fit the hint at all, one source character is still kept so the
 * result is never just the hint. HUMAN-render only.
 */
export function truncate(text: string, max = 200): string {
  if (text.length <= max) {
    return text;
  }
  const keep = Math.max(1, max - TRUNCATION_SUFFIX.length);
  return `${text.slice(0, keep)}${TRUNCATION_SUFFIX}`;
}
