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
}

const ERROR_STATUSES = new Set(["ERROR", "error", "STATUS_CODE_ERROR"]);

// Bright (not dark) red so an errored span reads clearly on dark and light
// terminals; applied to the whole line, gated behind the `color` option.
const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[91m";

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

/** Optional behavior for {@link renderTree}. */
export interface RenderTreeOptions {
  /** When true, error span lines are colored red. Off for non-TTY / `NO_COLOR`. */
  color?: boolean;
  /**
   * Terminal width: durations are right-aligned to this column. Defaults to
   * 80.
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

/**
 * Returns `text` unchanged when its length is at most `max`, otherwise the first
 * `max` characters followed by a truncation hint. HUMAN-render only.
 */
export function truncate(text: string, max = 200): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… (truncated)`;
}
