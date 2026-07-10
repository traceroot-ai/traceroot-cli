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
}

const ERROR_STATUSES = new Set(["ERROR", "error", "STATUS_CODE_ERROR"]);

// Bright (not dark) red so an errored span reads clearly on dark and light
// terminals; applied to the whole line, gated behind the `color` option.
const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[91m";

/**
 * Whether a span's `status` denotes an error. The single source of truth for
 * error classification, shared by the renderer and the `--errors-only` filter so
 * the two can't drift apart.
 */
export function isErrorStatus(status: string | undefined): boolean {
  return status !== undefined && ERROR_STATUSES.has(status);
}

function marker(status: string | undefined): string {
  return isErrorStatus(status) ? "[error]" : "[ok]";
}

function sortKey(span: SpanLike, index: number): [string, number] {
  return [span.span_start_time ?? "", index];
}

/** Optional behavior for {@link renderTree}. */
export interface RenderTreeOptions {
  /** When true, error span lines are colored red. Off for non-TTY / `NO_COLOR`. */
  color?: boolean;
  /**
   * Cap the rendered tree depth (roots are depth 1). Spans deeper than this are
   * not printed; a `… N deeper span(s) hidden` marker is appended under the
   * deepest visible ancestor whose children were dropped. Undefined = no cap.
   */
  maxDepth?: number;
  /**
   * Cap the number of span lines emitted. Once reached, rendering stops and a
   * single `… N more span(s)` elision line is appended, where N is the true
   * remainder (post depth-cap). Undefined = no cap.
   */
  maxSpans?: number;
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
  const maxDepth = options.maxDepth;
  const maxSpans = options.maxSpans;

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

  // Count the unique spans in the subtrees rooted at `children`, so a depth
  // elision marker can report exactly how many spans it stands in for. Each
  // hidden span is also added to `visited` (passed in) so the orphan-recovery
  // pass below does not re-render it as a stray root. A local `seen` set guards
  // against cycles in malformed data.
  const subtreeSpanCount = (children: SpanLike[], markHidden: Set<string>): number => {
    const seen = new Set<string>();
    const stack = [...children];
    while (stack.length > 0) {
      const s = stack.pop() as SpanLike;
      if (seen.has(s.span_id)) {
        continue;
      }
      seen.add(s.span_id);
      markHidden.add(s.span_id);
      for (const c of childrenOf.get(s.span_id) ?? []) {
        stack.push(c);
      }
    }
    return seen.size;
  };

  // Each entry is one output line, tagged so the `--max-spans` cap can count
  // span lines while still emitting the depth markers that precede the cut.
  interface Entry {
    text: string;
    isSpan: boolean;
  }
  const entries: Entry[] = [];
  // Guards against re-visiting a span: prevents infinite recursion and silent
  // duplication if the external span data contains a parent cycle.
  const visited = new Set<string>();

  const walk = (
    span: SpanLike,
    prefix: string,
    isLast: boolean,
    isRoot: boolean,
    depth: number,
  ): void => {
    if (visited.has(span.span_id)) {
      return;
    }
    visited.add(span.span_id);
    const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const text = `${prefix}${connector}${span.name} ${marker(span.status)}`;
    entries.push({
      text: color && isErrorStatus(span.status) ? `${ANSI_RED}${text}${ANSI_RESET}` : text,
      isSpan: true,
    });
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    const children = [...(childrenOf.get(span.span_id) ?? [])].sort(byStart);
    if (children.length === 0) {
      return;
    }
    // Depth cap: at the limit, hide this span's whole subtree behind one marker
    // rendered as a final pseudo-child, rather than recursing further.
    if (maxDepth !== undefined && depth >= maxDepth) {
      const hidden = subtreeSpanCount(children, visited);
      entries.push({
        text: `${childPrefix}└─ … ${hidden} deeper span${hidden === 1 ? "" : "s"} hidden`,
        isSpan: false,
      });
      return;
    }
    for (const [i, child] of children.entries()) {
      walk(child, childPrefix, i === children.length - 1, false, depth + 1);
    }
  };

  const sortedRoots = [...roots].sort(byStart);
  for (const root of sortedRoots) {
    walk(root, "", true, true, 1);
  }
  // Recover any spans never reached from a root (e.g. members of a parent cycle
  // in malformed data) as additional roots, so nothing is silently dropped.
  for (const span of spans) {
    if (!visited.has(span.span_id)) {
      walk(span, "", true, true, 1);
    }
  }

  const spanTotal = entries.reduce((n, e) => n + (e.isSpan ? 1 : 0), 0);
  const cap = maxSpans ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  let shown = 0;
  for (const entry of entries) {
    if (shown >= cap) {
      break;
    }
    lines.push(entry.text);
    if (entry.isSpan) {
      shown += 1;
    }
  }
  if (spanTotal > cap) {
    // `shown` equals the cap here (we filled to it), so this is the true remainder.
    const remaining = spanTotal - shown;
    lines.push(`… ${remaining} more span${remaining === 1 ? "" : "s"}`);
  }

  return lines.join("\n");
}

/**
 * Depth of each span keyed by `span_id`, where a root/orphan is depth 1 and a
 * child is one deeper than its parent. Computed by a BFS from the roots — the
 * same root/orphan and cycle-recovery rules {@link renderTree} uses — so the
 * flat-array depth filter and the tree renderer agree on what "depth" means.
 * Spans never reached (e.g. members of a parent cycle) are treated as roots.
 */
function computeDepths<T extends { span_id: string; parent_span_id: string | null }>(
  spans: T[],
): Map<string, number> {
  const present = new Set(spans.map((s) => s.span_id));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const span of spans) {
    const parent = span.parent_span_id;
    if (parent !== null && present.has(parent)) {
      const siblings = childrenOf.get(parent) ?? [];
      siblings.push(span);
      childrenOf.set(parent, siblings);
    } else {
      roots.push(span);
    }
  }
  const depthOf = new Map<string, number>();
  const queue: Array<[T, number]> = roots.map((r) => [r, 1]);
  for (let i = 0; i < queue.length; i++) {
    const [span, depth] = queue[i] as [T, number];
    if (depthOf.has(span.span_id)) {
      continue;
    }
    depthOf.set(span.span_id, depth);
    for (const child of childrenOf.get(span.span_id) ?? []) {
      queue.push([child, depth + 1]);
    }
  }
  // Spans unreachable from any root (parent cycles in malformed data) are
  // recovered as depth-1 roots, matching renderTree's recovery pass.
  for (const span of spans) {
    if (!depthOf.has(span.span_id)) {
      depthOf.set(span.span_id, 1);
    }
  }
  return depthOf;
}

/**
 * Returns the spans whose depth (roots = 1) is at most `maxDepth`, preserving
 * input order. The flat-array counterpart of {@link renderTree}'s depth cap.
 */
export function spansWithinDepth<T extends { span_id: string; parent_span_id: string | null }>(
  spans: T[],
  maxDepth: number,
): T[] {
  const depthOf = computeDepths(spans);
  return spans.filter((s) => (depthOf.get(s.span_id) ?? 1) <= maxDepth);
}

/**
 * Keeps every error-status span plus its full ancestor chain (via
 * `parent_span_id`), dropping unrelated spans. Input order is preserved. A
 * per-span `seen` set guards against parent cycles in malformed data.
 */
export function filterErrorsWithAncestors<
  T extends { span_id: string; parent_span_id: string | null; status?: string },
>(spans: T[]): T[] {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const keep = new Set<string>();
  for (const span of spans) {
    if (!isErrorStatus(span.status)) {
      continue;
    }
    let cur: T | undefined = span;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur.span_id)) {
      seen.add(cur.span_id);
      keep.add(cur.span_id);
      cur = cur.parent_span_id !== null ? byId.get(cur.parent_span_id) : undefined;
    }
  }
  return spans.filter((s) => keep.has(s.span_id));
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
