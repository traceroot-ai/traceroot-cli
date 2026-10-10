import type { TraceList } from "../api/client.js";
import { ExitCode } from "../output.js";

/**
 * Just enough of a client to poll for a trace.
 *
 * Deliberately structural rather than the generated `ApiClient`: which reads
 * that interface carries is settled by the tool registry, not by this command,
 * and a wizard that needs one read should not be coupled to that decision.
 * Anything that can list traces satisfies this.
 *
 * `endBefore` is `end_before` on the published endpoint. A client that predates
 * it and drops the parameter still satisfies this interface, which is why the
 * bound is re-checked here rather than trusted: the narrowing has to hold
 * whether or not the request carried it.
 */
export interface TraceLister {
  listTraces(params: {
    limit?: number;
    startAfter?: string;
    endBefore?: string;
  }): Promise<TraceList>;
}
import type { TraceVerification } from "./types.js";

/**
 * Poll cadence: tight at first, because a trace usually lands within seconds of
 * the app running, then relaxed so a long wait does not hammer the API.
 */
const POLL_SCHEDULE_MS = [2000, 2000, 3000, 5000] as const;
/** The schedule's last step, held for every attempt past the end of it. */
const STEADY_INTERVAL_MS = 5000;

/**
 * The endpoint's documented maximum. One page, newest-first, with no ascending
 * order and no cursor, so "the earliest trace" is only ever the earliest of
 * this page — which is why the page is as wide as the endpoint allows and why
 * {@link TraceAttribution.truncated} exists for the case where even that was
 * not wide enough.
 */
const PAGE_LIMIT = 200;

/** Row shape used from the trace list; kept minimal so the poll is schema-tolerant. */
type TraceRow = TraceList extends readonly (infer Row)[] ? Row : never;

/** When the instrumented application ran, by the clock that ran it. */
export interface RunWindow {
  from: Date;
  to: Date;
}

export interface PollForTraceInput {
  client: TraceLister;
  /** Only traces at or after this instant count as "the first trace of this run". */
  startedAt: Date;
  /**
   * When this run actually ran the instrumented application, or null when
   * nothing ran it — a repository with no check to run, or a resumed run that
   * no longer knows.
   *
   * Required rather than optional, and nullable rather than absent, because the
   * difference decides what the result is allowed to claim: a trace that
   * started while the application was running is this run's, and a trace that
   * merely arrived in the project afterwards is not. A caller that cannot
   * answer has to say so, and the answer is reported in
   * {@link TraceAttribution.basis} rather than quietly assumed.
   */
  ranAt: RunWindow | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Progress callback, so the caller can render an elapsed-time line. */
  onAttempt?: (attempt: number, elapsedMs: number) => void;
}

/**
 * How firmly the reported trace is tied to this run, and what else was in the
 * frame when it was chosen.
 *
 * The list endpoint can be narrowed by time (`start_after`, `end_before`), by
 * trace name, by `user_id` and by typed predicates over a field catalog that
 * holds nothing identifying the process that emitted a trace — no service, no
 * host, no key. So nothing here is a server-side proof of origin, and the
 * closing message must not read as one: this is the evidence a user needs to
 * judge the link themselves.
 */
export interface TraceAttribution {
  /**
   * `application-run` — the trace started while this run was running the
   * application. `setup-window` — it only arrived at some point during setup,
   * which is all the old poll ever established.
   */
  basis: "application-run" | "setup-window";
  /** The trace's own name: the one field in a list row that hints at its origin. */
  name: string;
  /**
   * How many traces matched. More than one means the project received other
   * traffic in the same window and this was a choice between them.
   */
  candidates: number;
  /** The page came back full, so a matching trace may have fallen off the end. */
  truncated: boolean;
}

export type PollForTraceResult =
  | { found: true; trace: TraceVerification; attribution: TraceAttribution }
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

interface Row {
  traceId: string;
  traceUrl: string;
  startTime: string;
  name: string;
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
  if (typeof traceId !== "string" || typeof traceUrl !== "string") {
    return null;
  }
  return {
    traceId,
    traceUrl,
    startTime: typeof startTime === "string" ? startTime : "",
    name: typeof name === "string" ? name : "",
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
 * The earliest trace in one window, oldest first rather than newest.
 *
 * The backend orders `trace_start_time DESC` and has no ascending mode, so row
 * zero is the *most recent* trace — while both this poll and the browser wizard
 * call what they show "your first trace". An application that emits several
 * traces per run (one per query, say) makes that a race: whichever surface
 * happens to look after the second trace lands links to the second one, and the
 * two disagree about which trace the run produced. Sorting here makes the
 * answer the same no matter when anyone looked.
 */
async function earliestIn(
  client: TraceLister,
  window: { from: Date; to: Date | null },
): Promise<Search> {
  const response = await client.listTraces({
    limit: PAGE_LIMIT,
    startAfter: window.from.toISOString(),
    // `end_before` is exclusive and the window's end is inclusive — a trace
    // that started in the application's last millisecond is still the
    // application's.
    endBefore: window.to === null ? undefined : new Date(window.to.getTime() + 1).toISOString(),
  });

  const rows = rowsOf(response as unknown as TraceRow[]);
  const fromMs = window.from.getTime();
  const toMs = window.to === null ? Number.POSITIVE_INFINITY : window.to.getTime();
  let earliest: { row: Row; at: number } | null = null;
  let candidates = 0;
  for (const raw of rows) {
    const row = rowOf(raw);
    if (row === null) {
      continue;
    }
    // Both bounds are applied server-side, but a backend that ignores either of
    // them must not make setup claim someone else's trace as its own.
    const rowMs = row.startTime === "" ? Number.NaN : parseStartTime(row.startTime);
    if (Number.isFinite(rowMs) && (rowMs < fromMs || rowMs > toMs)) {
      continue;
    }
    // An unparseable or absent start time cannot be placed in the window at
    // all. Inside a bounded window that disqualifies it; in the open-ended one
    // it is still a trace worth reporting, but it sorts last so it never wins
    // against one that can actually be ordered.
    if (!Number.isFinite(rowMs) && window.to !== null) {
      continue;
    }
    candidates += 1;
    const at = Number.isFinite(rowMs) ? rowMs : Number.POSITIVE_INFINITY;
    if (earliest === null || at < earliest.at) {
      earliest = { row, at };
    }
  }
  return {
    earliest: earliest?.row ?? null,
    candidates,
    // A full page is the signal that the single page may not hold the whole
    // window. The claim is still the earliest trace *seen*; this says so.
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
 * Asking it by start time alone is not enough either. A project that already
 * receives traffic — a second service, a teammate, a staging deployment — hands
 * the poll somebody else's trace, and the first poll then succeeds *even when
 * the instrumentation did nothing*, which is the same failure as trusting the
 * agent's word, one step later. So the run's own window comes first: a trace
 * that started while this run was running the application is attributable to
 * it. Only once that window is exhausted does the wider "some trace arrived
 * during setup" reading come back, and then it is labelled as such in
 * {@link TraceAttribution} rather than passed off as proof.
 *
 * The permalink is the `trace_url` the backend returned, echoed verbatim — the
 * same rule `traces get` follows. Constructing a URL client-side would break
 * self-hosted deployments and would silently drift from the frontend's routing.
 */
export async function pollForTrace(input: PollForTraceInput): Promise<PollForTraceResult> {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => Date.now());
  const began = now();
  let attempts = 0;
  let lastError: string | null = null;

  const found = (
    search: Search,
    row: Row,
    basis: TraceAttribution["basis"],
  ): PollForTraceResult => ({
    found: true,
    trace: {
      traceId: row.traceId,
      traceUrl: row.traceUrl,
      observedAt: new Date(now()).toISOString(),
      waitedMs: now() - began,
    },
    attribution: {
      basis,
      name: row.name,
      candidates: search.candidates,
      truncated: search.truncated,
    },
  });

  /** Everything since setup started: what this poll could claim before. */
  const wholeRun = { from: input.startedAt, to: null };

  for (;;) {
    if (input.signal?.aborted === true) {
      return { found: false, waitedMs: now() - began, attempts, lastError };
    }

    attempts += 1;
    input.onAttempt?.(attempts, now() - began);

    try {
      const scope = input.ranAt === null ? wholeRun : input.ranAt;
      const search = await earliestIn(input.client, scope);
      if (search.earliest !== null) {
        return found(
          search,
          search.earliest,
          input.ranAt === null ? "setup-window" : "application-run",
        );
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
        return { found: false, waitedMs: now() - began, attempts, lastError: message };
      }
      lastError = message;
    }

    const elapsed = now() - began;
    if (elapsed >= input.timeoutMs) {
      // Nothing is attributable to the application's own run. Before reporting
      // a timeout, take the one look the poll used to take all along: a trace
      // that merely turned up during setup is worth showing — the user may well
      // recognise it — but it is reported for what it is.
      if (input.ranAt !== null) {
        try {
          const search = await earliestIn(input.client, wholeRun);
          if (search.earliest !== null) {
            return found(search, search.earliest, "setup-window");
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      return { found: false, waitedMs: now() - began, attempts, lastError };
    }

    // Past the end of the schedule the last step repeats. There was a 10s cap
    // here, and nothing ever reached it: the schedule tops out at 5s and the
    // cap could only ever lower a value, so it described a backoff the poll
    // does not have.
    const scheduled = POLL_SCHEDULE_MS[attempts - 1] ?? STEADY_INTERVAL_MS;
    await sleep(Math.min(scheduled, input.timeoutMs - elapsed), input.signal);
  }
}
