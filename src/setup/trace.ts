import type { TraceList } from "../api/client.js";

/**
 * Just enough of a client to poll for a trace.
 *
 * Deliberately structural rather than the generated `ApiClient`: which reads
 * that interface carries is settled by the tool registry, not by this command,
 * and a wizard that needs one read should not be coupled to that decision.
 * Anything that can list traces satisfies this.
 */
export interface TraceLister {
  listTraces(params: { limit?: number; startAfter?: string }): Promise<TraceList>;
}
import type { TraceVerification } from "./types.js";

/**
 * Poll cadence: tight at first, because a trace usually lands within seconds of
 * the app running, then relaxed so a long wait does not hammer the API.
 */
const POLL_SCHEDULE_MS = [2000, 2000, 3000, 5000] as const;
const MAX_INTERVAL_MS = 10_000;

/** Row shape used from the trace list; kept minimal so the poll is schema-tolerant. */
type TraceRow = TraceList extends readonly (infer Row)[] ? Row : never;

export interface PollForTraceInput {
  client: TraceLister;
  /** Only traces at or after this instant count as "the first trace of this run". */
  startedAt: Date;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Progress callback, so the caller can render an elapsed-time line. */
  onAttempt?: (attempt: number, elapsedMs: number) => void;
}

export type PollForTraceResult =
  | { found: true; trace: TraceVerification }
  | { found: false; waitedMs: number; attempts: number; lastError: string | null };

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function rowOf(value: unknown): { traceId: string; traceUrl: string; startTime: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const traceId = row.trace_id;
  const traceUrl = row.trace_url;
  const startTime = row.trace_start_time;
  if (typeof traceId !== "string" || typeof traceUrl !== "string") {
    return null;
  }
  return {
    traceId,
    traceUrl,
    startTime: typeof startTime === "string" ? startTime : "",
  };
}

/**
 * Rows from the list response.
 *
 * The published contract is `PublicTraceListResponse { data, meta }`
 * (`openapi.json`), so `data` is the shape that actually matters; the bare-array
 * fallback exists only so a hand-rolled stub or an older deployment does not
 * silently yield "no traces ever", which is indistinguishable from a real
 * timeout and was exactly how this went wrong the first time.
 */
function rowsOf(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response;
  }
  if (typeof response === "object" && response !== null) {
    const record = response as Record<string, unknown>;
    for (const key of ["data", "traces"]) {
      const wrapped = record[key];
      if (Array.isArray(wrapped)) {
        return wrapped;
      }
    }
  }
  return [];
}

/**
 * Parses a trace start time to epoch milliseconds.
 *
 * The backend emits UTC timestamps with no zone designator
 * (`2026-07-28T23:29:34.593000`). `Date.parse` reads a date-time without an
 * offset as *local* time, so west of UTC the trace looks later than it is
 * (harmless) and east of UTC it looks earlier — which would make a freshly
 * emitted trace fall behind the run's start bound and be discarded, reporting a
 * timeout for a trace that had already arrived. Assume UTC when no zone is
 * given, which is what the backend means.
 */
function parseStartTime(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return Date.parse(hasZone ? value : `${value}Z`);
}

/**
 * Polls for the first trace produced by this setup run and returns the
 * backend's own permalink.
 *
 * Deciding that setup succeeded from the coding agent's exit status and then
 * printing a static project-logs link is not enough: an agent that exits
 * cleanly without emitting anything, or that emits to the wrong project, would
 * still be reported as a success. Asking the API is the only way the completion
 * message can be honest.
 *
 * The permalink is the `trace_url` the backend returned, echoed verbatim — the
 * same rule `traces get` follows. Constructing a URL client-side would break
 * self-hosted deployments and would silently drift from the frontend's routing.
 */
export async function pollForTrace(input: PollForTraceInput): Promise<PollForTraceResult> {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => Date.now());
  const began = now();
  const startedAtMs = input.startedAt.getTime();
  let attempts = 0;
  let lastError: string | null = null;

  for (;;) {
    if (input.signal?.aborted === true) {
      return { found: false, waitedMs: now() - began, attempts, lastError };
    }

    attempts += 1;
    input.onAttempt?.(attempts, now() - began);

    try {
      const response = await input.client.listTraces({
        limit: 20,
        startAfter: input.startedAt.toISOString(),
      });
      // Oldest first, not newest.
      //
      // The backend orders `trace_start_time DESC` and has no ascending mode,
      // so row zero is the *most recent* trace — while both this block and the
      // browser wizard call what they show "your first trace". An application
      // that emits several traces per run (one per query, say) makes that a
      // race: whichever surface happens to poll after the second trace lands
      // links to the second one, and the two disagree about which trace the
      // run produced. Sorting here makes the answer the same no matter when
      // anyone looked.
      let earliest: { row: NonNullable<ReturnType<typeof rowOf>>; at: number } | null = null;
      for (const raw of rowsOf(response as unknown as TraceRow[])) {
        const row = rowOf(raw);
        if (row === null) {
          continue;
        }
        // `start_after` is applied server-side, but a backend that ignores the
        // bound must not make setup claim a pre-existing trace as its own.
        const rowMs = row.startTime === "" ? Number.NaN : parseStartTime(row.startTime);
        if (Number.isFinite(rowMs) && rowMs < startedAtMs) {
          continue;
        }
        // An unparseable or absent start time sorts last: it is still a valid
        // trace to report, but it cannot win against one we can actually
        // order.
        const at = Number.isFinite(rowMs) ? rowMs : Number.POSITIVE_INFINITY;
        if (earliest === null || at < earliest.at) {
          earliest = { row, at };
        }
      }
      if (earliest !== null) {
        return {
          found: true,
          trace: {
            traceId: earliest.row.traceId,
            traceUrl: earliest.row.traceUrl,
            observedAt: new Date(now()).toISOString(),
            waitedMs: now() - began,
          },
        };
      }
      lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An auth failure will not fix itself by waiting; anything else might.
      if (/401|403|unauthor/i.test(message)) {
        return { found: false, waitedMs: now() - began, attempts, lastError: message };
      }
      lastError = message;
    }

    const elapsed = now() - began;
    if (elapsed >= input.timeoutMs) {
      return { found: false, waitedMs: elapsed, attempts, lastError };
    }

    const scheduled =
      POLL_SCHEDULE_MS[Math.min(attempts - 1, POLL_SCHEDULE_MS.length - 1)] ?? MAX_INTERVAL_MS;
    const remaining = input.timeoutMs - elapsed;
    await sleep(Math.min(scheduled, MAX_INTERVAL_MS, remaining), input.signal);
  }
}
