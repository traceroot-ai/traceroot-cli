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

/** The schedule's last step, held for every attempt past the end of it. */
const STEADY_INTERVAL_MS = 5000;
/**
 * Poll cadence: tight at first, because a trace usually lands within seconds of
 * the app running, then relaxed so a long wait does not hammer the API.
 */
const POLL_SCHEDULE_MS = [2000, 2000, 3000, STEADY_INTERVAL_MS] as const;

/**
 * How long the run's own window keeps the poll to itself after it has closed.
 *
 * A trace is in this list once the backend has finished receiving it, which is
 * seconds after it started, so a window that closed a moment ago can still fill
 * up. That grace is worth waiting for: a trace inside the window is
 * attributable to this run, and one that merely arrived during setup is not.
 *
 * Waiting the whole timeout for it is not. Once the window has been closed this
 * long and is still empty, nothing ran the application inside it and no further
 * waiting changes that — the project's check can exercise instrumented code
 * without ever reaching the entry point, which is the ordinary case, not a
 * strange one. The poll used to hold its one wider look until the deadline, so
 * a run whose trace was already in the project reported success two minutes
 * after it could have. Past the grace the wider look is taken on every attempt
 * instead, and what it finds is reported for what it is.
 *
 * How long the grace is, is not a judgement about any backend's ingestion lag,
 * which this process cannot measure. It is {@link POLL_SCHEDULE_MS} spent in
 * full: the point at which the poll's own back-off gives up on a prompt arrival
 * and settles into {@link STEADY_INTERVAL_MS}. Deriving it means there is one
 * decision about how long "promptly" is rather than two that can disagree, and
 * tuning the schedule carries the grace with it.
 */
export const WINDOW_GRACE_MS = POLL_SCHEDULE_MS.reduce((total, ms) => total + ms, 0);

/**
 * The endpoint's documented maximum. One page, newest-first, with no ascending
 * order and no cursor, so "the earliest trace" is only ever the earliest of
 * this page — which is why the page is as wide as the endpoint allows and why
 * {@link TraceAttribution.truncated} exists for the case where even that was
 * not wide enough.
 */
const PAGE_LIMIT = 200;

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
  /**
   * How many spans the trace holds, or null when the response did not say.
   *
   * The one field in a list row that says anything about how much of the
   * application the trace covers, and the reason this interface is where it
   * belongs: a span count is not part of the trace's identity, it is evidence
   * about what the trace shows. {@link isThinTrace} is the only reading of it
   * this process is prepared to defend.
   *
   * Null rather than zero for "not said". `span_count` is required and
   * non-nullable in the published list response, so in practice a number always
   * arrives; the null exists because this poll reads rows structurally, and a
   * deployment or a stub that omits the field must not be read as a trace with
   * nothing in it — the one value that would make the run say the opposite of
   * the truth.
   */
  spanCount: number | null;
}

/**
 * The most spans a trace can hold and still show less than it appears to.
 *
 * One. A trace with a single span is one instrumented function, entered and
 * left, with nothing instrumented running inside it. It establishes that the
 * SDK is installed, that the credential reaches the backend and that something
 * ran — and nothing at all about how much of the application is covered,
 * because there is no parent and child in it to read a call path from. That is
 * a structural fact about the trace rather than a guess about the program.
 *
 * Any number above one would be a guess. Two spans could be an entry point and
 * its one model call, which for some programs is the entire program; five could
 * be a third of a single request. Nothing this run has looked at says which: a
 * list row carries a span count and no structure, and stack detection reports
 * the language, the framework and the entry point, and nothing about which
 * functions call a model or are registered as tools. So the bound sits at the
 * one place where the reading needs no knowledge of the application at all.
 *
 * It is still the wrong bound for a single-function script, where one span is
 * the whole truth. Which is why what it produces is a remark and never a
 * failure: the run says how many spans it found and what one span does and does
 * not show, and leaves the judgement with the only party that knows the
 * program.
 */
export const THIN_TRACE_MAX_SPANS = 1;

/**
 * Whether a span count is small enough to be worth saying out loud.
 *
 * One function, so the threshold is decided once. A second copy of `<= 1` in
 * the report and a third in the closing output would be three things that can
 * disagree about what a run promised.
 *
 * An unknown count is not thin. A deployment that did not report one has told
 * this process nothing, and silence is not evidence of a small trace.
 *
 * Narrows rather than returning a bare boolean, so a caller that goes on to
 * print the number does not have to re-test for it and risk disagreeing with
 * this function about which values are numbers.
 */
export function isThinTrace(spanCount: number | null | undefined): spanCount is number {
  return typeof spanCount === "number" && spanCount <= THIN_TRACE_MAX_SPANS;
}

/**
 * A span count as prose rather than as a figure.
 *
 * Here beside the threshold because the count and the reading of it are one
 * decision, and because the count is printed by more than one surface — the
 * report's verdict, the report's trace row, the line the poll closes on. Three
 * spellings of "1 span" read as three different findings.
 */
export function spanPhrase(count: number): string {
  if (count === 0) {
    return "no spans";
  }
  return count === 1 ? "a single span" : `${count} spans`;
}

/**
 * What a trace this process calls thin actually holds, in the words every
 * surface that reports it uses.
 *
 * Written once and shared, because the report and the closing output make the
 * same claim about the same trace, and a run whose two records of it read
 * differently is worse than either of them on its own. Each surface supplies
 * its own subject and its own next step; this is the finding they share.
 *
 * Claims nothing about the application. "One instrumented function ran" is read
 * off the span count; whether that is the whole program is not knowable from
 * here, and the sentence deliberately stops before saying so.
 */
export function thinTraceFinding(spanCount: number): string {
  return spanCount === 1
    ? "holds a single span: one instrumented function ran, and nothing instrumented ran inside it"
    : `holds ${spanPhrase(spanCount)}: the response reports nothing in it at all`;
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
 * Parses a trace start time to epoch milliseconds, fraction and all.
 *
 * The backend emits UTC timestamps with no zone designator
 * (`2026-07-28T23:29:34.593000`). `Date.parse` reads a date-time without an
 * offset as *local* time, so west of UTC the trace looks later than it is
 * (harmless) and east of UTC it looks earlier — which would make a freshly
 * emitted trace fall behind the run's start bound and be discarded, reporting a
 * timeout for a trace that had already arrived. Assume UTC when no zone is
 * given, which is what the backend means.
 *
 * The return is fractional because the timestamps are microsecond-precision and
 * `Date.parse` keeps three digits of the fraction and drops the rest. Dropping
 * them rounds every trace *down*, towards the start of the run, and the window
 * bounds here are inclusive — so a trace that started a fraction of a
 * millisecond after the application stopped parses as having started exactly
 * when it stopped, and is admitted as this run's own. Microseconds are not a
 * rounding detail at the edge of a window: either side of it is a different
 * claim about where a trace came from.
 */
function parseStartTime(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const milliseconds = Date.parse(hasZone ? value : `${value}Z`);
  if (!Number.isFinite(milliseconds)) {
    return milliseconds;
  }
  // Whatever `Date.parse` discarded: the fourth fractional digit onwards, read
  // back as a fraction of a millisecond. Added rather than subtracted whichever
  // side of the epoch the value falls on, because dropping digits always lowers
  // the parsed instant.
  const fraction = /\.(\d{4,})/.exec(value)?.[1];
  return fraction === undefined ? milliseconds : milliseconds + Number(`0.${fraction.slice(3)}`);
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
 * two disagree about which trace the run produced. Sorting here settles the
 * page: two surfaces reading the same rows agree on which trace is first.
 *
 * It does not settle ingestion, and nothing on this side could. A trace appears
 * in this list when the backend has finished receiving it, which is not the
 * order the traces started in, so a look taken while the earlier of two traces
 * is still arriving reports the later one. What this returns is the earliest
 * trace of the window that had arrived by the time it was asked — the poll
 * chooses as soon as the window is not empty rather than waiting for it to
 * settle, because the alternative is a user watching a terminal for the length
 * of the backend's ingestion lag to improve a link they already have.
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

  const rows = rowsOf(response);
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
 * Exhausted means closed and given {@link WINDOW_GRACE_MS} to fill, not "the
 * timeout expired". The window can close without the application ever having
 * run in it — the project's check exercises instrumented code without reaching
 * its entry point, which is the common shape of a test suite — and holding the
 * wider look until the deadline made that case wait out the entire trace
 * budget for a trace that was already in the project.
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
      // Onto the record and not only into the attribution beside it. The
      // report's verdict and its trace row both read the count off here, and
      // the checkpoint carries this record rather than the attribution — so a
      // count that stopped at the attribution left every surface that can
      // remark on a thin trace with nothing to remark on, and `--resume` with
      // nothing at all.
      //
      // Spread away when the response did not report one, because absent and
      // zero are different answers and `TraceVerification` spells the first as
      // a missing field. A null here would read downstream as a number.
      ...(row.spanCount === null ? {} : { spanCount: row.spanCount }),
    },
    attribution: {
      basis,
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

  /** Everything since setup started: what this poll could claim before. */
  const wholeRun = { from: input.startedAt, to: null };

  for (;;) {
    if (input.signal?.aborted === true) {
      return notFound(lastError);
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
      // Nothing in the run's own window, and the window has had its grace. The
      // wider reading is the weaker claim either way, so taking it now rather
      // than at the deadline costs the report nothing it would have said — and
      // it is the difference between a user waiting two seconds and a user
      // watching a spinner for the whole trace budget while the trace they are
      // waiting for is already in the list.
      if (input.ranAt !== null && now() - input.ranAt.to.getTime() >= WINDOW_GRACE_MS) {
        const wider = await earliestIn(input.client, wholeRun);
        if (wider.earliest !== null) {
          return found(wider, wider.earliest, "setup-window");
        }
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
      return notFound(lastError);
    }

    // Past the end of the schedule the last step repeats. There was a 10s cap
    // here, and nothing ever reached it: the schedule tops out at 5s and the
    // cap could only ever lower a value, so it described a backoff the poll
    // does not have.
    const scheduled = POLL_SCHEDULE_MS[attempts - 1] ?? STEADY_INTERVAL_MS;
    await sleep(Math.min(scheduled, input.timeoutMs - elapsed), input.signal);
  }
}
