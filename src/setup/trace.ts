import type { TraceList } from "../api/client.js";
import { ExitCode } from "../output.js";
import { sleep } from "../util/sleep.js";

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

/** The schedule's last step, held for every attempt past the end of it. */
const STEADY_INTERVAL_MS = 5000;
/**
 * Poll cadence: tight at first, because a trace usually lands within seconds of
 * the app running, then relaxed so a long wait does not hammer the API.
 */
const POLL_SCHEDULE_MS = [2000, 2000, 3000, STEADY_INTERVAL_MS] as const;

/**
 * The endpoint's documented maximum. One page, newest-first, with no ascending
 * order and no cursor, so "the earliest trace" is only ever the earliest of
 * this page — which is why the page is as wide as the endpoint allows and why
 * {@link TraceAttribution.truncated} exists for the case where even that was
 * not wide enough.
 */
const PAGE_LIMIT = 200;

export interface PollForTraceInput {
  client: TraceLister;
  /** Only traces at or after this instant count as "the first trace of this run". */
  startedAt: Date;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the shared timer in `util/sleep`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Progress callback, so the caller can render an elapsed-time line. */
  onAttempt?: (attempt: number, elapsedMs: number) => void;
}

/**
 * What else was in the frame when the reported trace was chosen, and what that
 * trace holds.
 *
 * The list endpoint can be narrowed by time (`start_after`, `end_before`), by
 * trace name, by `user_id` and by typed predicates over a field catalog that
 * holds nothing identifying the process that emitted a trace — no service, no
 * host, no key. So nothing here is a server-side proof of origin, and the
 * closing message must not read as one: this is the evidence a user needs to
 * judge the link themselves.
 */
export interface TraceAttribution {
  /** The trace's own name: the one field in a list row that hints at its origin. */
  name: string;
  /**
   * How many traces matched. More than one means the project received other
   * traffic since setup started and this was a choice between them.
   */
  candidates: number;
  /** The page came back full, so a matching trace may have fallen off the end. */
  truncated: boolean;
  /**
   * How many spans the trace holds, or null when the response did not say.
   *
   * The one field in a list row that says anything about how much of the
   * application the trace covers, and the reason this interface is where it
   * belongs: a span count is not part of the trace's identity, it is evidence
   * about what the trace shows. It is printed as a number and never read as a
   * verdict. How many spans a first trace ought to hold depends on the program,
   * which nothing this run inspected describes — one is the whole truth for a
   * single-function script — and the one verdict this process used to draw from
   * it, a warning at a single span, fired over a unit test's trace that setup
   * had mistaken for the application's.
   *
   * Null rather than zero for "not said". `span_count` is required and
   * non-nullable in the published list response, so in practice a number always
   * arrives; the null exists because this poll reads rows structurally, and a
   * deployment or a stub that omits the field must not be printed as a trace
   * with nothing in it.
   */
  spanCount: number | null;
}

/**
 * A span count as prose rather than as a figure.
 *
 * One function, because the count is printed by more than one surface — the
 * report's trace row and the line the poll closes on — and two spellings of
 * "1 span" read as two different findings.
 */
export function spanPhrase(count: number): string {
  if (count === 0) {
    return "no spans";
  }
  return count === 1 ? "a single span" : `${count} spans`;
}

export type PollForTraceResult =
  | { found: true; trace: TraceVerification; attribution: TraceAttribution }
  | { found: false; waitedMs: number; attempts: number; lastError: string | null };

interface Row {
  traceId: string;
  traceUrl: string;
  startTime: string;
  name: string;
  spanCount: number | null;
}

function rowOf(value: unknown): Row | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const traceId = row.trace_id;
  const traceUrl = row.trace_url;
  const startTime = row.trace_start_time;
  const name = row.name;
  const spanCount = row.span_count;
  if (typeof traceId !== "string" || typeof traceUrl !== "string") {
    return null;
  }
  return {
    traceId,
    traceUrl,
    startTime: typeof startTime === "string" ? startTime : "",
    name: typeof name === "string" ? name : "",
    // Whole and not negative, or not a count. A fractional or negative
    // `span_count` is not a number any reading of it would survive, and the
    // honest answer to a row carrying one is that the response did not say how
    // many spans the trace holds.
    spanCount:
      typeof spanCount === "number" && Number.isInteger(spanCount) && spanCount >= 0
        ? spanCount
        : null,
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

interface Search {
  earliest: Row | null;
  candidates: number;
  truncated: boolean;
}

/**
 * The earliest trace since `from`, oldest first rather than newest.
 *
 * The backend orders `trace_start_time DESC` and has no ascending mode, so row
 * zero is the *most recent* trace — while both this poll and the browser wizard
 * call what they show "your first trace". An application that emits several
 * traces per run (one per query, say) makes that a race: whichever surface
 * happens to look after the second trace lands links to the second one, and the
 * two disagree about which trace the run produced. Sorting here settles the
 * page: two surfaces reading the same rows agree on which trace is first.
 *
 * It does not settle ingestion, and nothing on this side could. A trace appears
 * in this list when the backend has finished receiving it, which is not the
 * order the traces started in, so a look taken while the earlier of two traces
 * is still arriving reports the later one. What this returns is the earliest
 * trace that had arrived by the time it was asked — the poll chooses as soon as
 * there is one rather than waiting for the list to settle, because the
 * alternative is a user watching a terminal for the length of the backend's
 * ingestion lag to improve a link they already have.
 */
async function earliestSince(client: TraceLister, from: Date): Promise<Search> {
  const response = await client.listTraces({
    limit: PAGE_LIMIT,
    startAfter: from.toISOString(),
  });

  const rows = rowsOf(response);
  const fromMs = from.getTime();
  let earliest: { row: Row; at: number } | null = null;
  let candidates = 0;
  for (const raw of rows) {
    const row = rowOf(raw);
    if (row === null) {
      continue;
    }
    // `start_after` is applied server-side, but a backend that ignores the
    // bound must not make setup claim a pre-existing trace as its own.
    const rowMs = row.startTime === "" ? Number.NaN : parseStartTime(row.startTime);
    if (Number.isFinite(rowMs) && rowMs < fromMs) {
      continue;
    }
    candidates += 1;
    // An unparseable or absent start time sorts last: it is still a trace
    // worth reporting, but it cannot win against one that can actually be
    // ordered.
    const at = Number.isFinite(rowMs) ? rowMs : Number.POSITIVE_INFINITY;
    if (earliest === null || at < earliest.at) {
      earliest = { row, at };
    }
  }
  return {
    earliest: earliest?.row ?? null,
    candidates,
    // A full page is the signal that the single page may not hold every trace
    // since setup started. The claim is still the earliest trace *seen*; this
    // says so.
    truncated: rows.length >= PAGE_LIMIT,
  };
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
 * The first trace is the earliest one since setup started, and nothing
 * narrower. That reads as the application's own trace because nothing setup
 * runs for itself can send one: the project's check runs with TraceRoot
 * switched off (see `verifyApplication`), and the agent is told to run the
 * suite the same way. What arrives is the application being run — by the
 * agent, or by the user before a `--resume`.
 *
 * It used to be narrower, and the narrowing was the bug. Setup ran the
 * project's check with the key in its environment, then searched that run's
 * window first and called the earliest trace in it the application's. A suite
 * that never reaches `initialize()` still exports when the key is in its
 * environment, because `@observe` starts the SDK on its own, so the window
 * filled with unit-test traces and the poll opened a one-span test of a single
 * tool as "your first trace" — while the application's own trace, sent seconds
 * earlier by the agent, sat outside the window.
 *
 * A project that already receives other traffic — a second service, a
 * teammate, a staging deployment — can still put a trace in this frame first,
 * and nothing in a list row says which process sent it. So the result carries
 * what a user needs to judge the link ({@link TraceAttribution}) rather than
 * passing the choice off as proof.
 *
 * The permalink is the `trace_url` the backend returned, echoed verbatim — the
 * same rule `traces get` follows. Constructing a URL client-side would break
 * self-hosted deployments and would silently drift from the frontend's routing.
 */
export async function pollForTrace(input: PollForTraceInput): Promise<PollForTraceResult> {
  const wait = input.sleep ?? sleep;
  const now = input.now ?? (() => Date.now());
  const began = now();
  let attempts = 0;
  let lastError: string | null = null;

  const found = (search: Search, row: Row): PollForTraceResult => ({
    found: true,
    trace: {
      traceId: row.traceId,
      traceUrl: row.traceUrl,
      observedAt: new Date(now()).toISOString(),
      waitedMs: now() - began,
      // Onto the record and not only into the attribution beside it. The
      // report's trace row reads the count off here, and the checkpoint carries
      // this record rather than the attribution — so a count that stopped at
      // the attribution left the report with nothing to print, and `--resume`
      // with nothing at all.
      //
      // Spread away when the response did not report one, because absent and
      // zero are different answers and `TraceVerification` spells the first as
      // a missing field. A null here would read downstream as a number.
      ...(row.spanCount === null ? {} : { spanCount: row.spanCount }),
    },
    attribution: {
      name: row.name,
      candidates: search.candidates,
      truncated: search.truncated,
      spanCount: row.spanCount,
    },
  });
  const notFound = (error: string | null): PollForTraceResult => ({
    found: false,
    waitedMs: now() - began,
    attempts,
    lastError: error,
  });

  for (;;) {
    if (input.signal?.aborted === true) {
      return notFound(lastError);
    }

    attempts += 1;
    input.onAttempt?.(attempts, now() - began);

    try {
      const search = await earliestSince(input.client, input.startedAt);
      if (search.earliest !== null) {
        return found(search, search.earliest);
      }
      lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An auth failure will not fix itself by waiting; anything else might.
      //
      // The classified status is the reliable signal: the client throws the
      // backend's own `detail` as the message ("Invalid API key",
      // "Authentication failed"), so no regex over the text can be trusted to
      // recognise one. Read structurally so this stays uncoupled from the
      // generated client, with the text kept as a fallback.
      const exitCode = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
      if (exitCode === ExitCode.auth || /401|403|unauthor|forbidden/i.test(message)) {
        return notFound(message);
      }
      lastError = message;
    }

    const elapsed = now() - began;
    if (elapsed >= input.timeoutMs) {
      return notFound(lastError);
    }

    // Past the end of the schedule the last step repeats. There was a 10s cap
    // here, and nothing ever reached it: the schedule tops out at 5s and the
    // cap could only ever lower a value, so it described a backoff the poll
    // does not have.
    const scheduled = POLL_SCHEDULE_MS[attempts - 1] ?? STEADY_INTERVAL_MS;
    await wait(Math.min(scheduled, input.timeoutMs - elapsed), input.signal);
  }
}
