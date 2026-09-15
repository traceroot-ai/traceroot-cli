import { describe, expect, it } from "vitest";
import type { Writers } from "../../../src/output.js";
import { renderAlertDetail } from "../../../src/registry/enhancers/alerts-get.js";
import { alertsList, renderAlertsList } from "../../../src/registry/enhancers/alerts-list.js";
import { StringSink } from "../../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const RES = {
  data: [
    {
      id: "alr-1",
      name: "checkout p95",
      status: "OK",
      severity: "NONE",
      aggregation: "p95",
      measure: "duration_ms",
      threshold_operator: ">",
      threshold: 1500,
      window: "5m",
      last_evaluated_at: "2026-09-14T10:00:00Z",
    },
  ],
  meta: { limit: 50, page: 0, total: 1, capacity: { used: 1, max: 20 } },
};

describe("alerts list rendering", () => {
  it("renders the curated columns with a composed rule", () => {
    const { writers, out } = makeWriters();
    renderAlertsList(RES, { json: false, writers, timeZone: "UTC" });
    expect(out.data).toContain("NAME");
    expect(out.data).toContain("SEVERITY");
    expect(out.data).toContain("ALERT ID");
    expect(out.data).toContain("p95 duration_ms > 1500 / 5m");
    expect(out.data).toContain("checkout p95");
  });

  it("reports capacity in the footer", () => {
    const { writers, err } = makeWriters();
    renderAlertsList(RES, { json: false, writers, timeZone: "UTC" });
    expect(err.data).toContain("1 alert(s)");
    expect(err.data).toContain("1/20");
  });

  it("emits exactly one JSON document under --json", () => {
    const { writers, out } = makeWriters();
    renderAlertsList(RES, { json: true, writers });
    expect(JSON.parse(out.data).data).toHaveLength(1);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
  });

  it("shows 'never' when an alert has not been evaluated", () => {
    const { writers, out } = makeWriters();
    const res = { ...RES, data: [{ ...RES.data[0], last_evaluated_at: null }] };
    renderAlertsList(res, { json: false, writers, timeZone: "UTC" });
    expect(out.data).toContain("never");
  });

  it("omits the capacity suffix when meta.capacity is absent", () => {
    const { writers, err } = makeWriters();
    renderAlertsList({ data: RES.data }, { json: false, writers, timeZone: "UTC" });
    expect(err.data).toContain("1 alert(s)");
    expect(err.data).not.toContain("/");
  });

  it("renders an empty list as a header-only table with a zero footer", () => {
    const { writers, out, err } = makeWriters();
    renderAlertsList({ data: [] }, { json: false, writers, timeZone: "UTC" });
    expect(out.data).toContain("ALERT ID");
    expect(err.data).toContain("0 alert(s)");
  });
});

const DETAIL = {
  ...RES.data[0],
  view: "SPANS",
  no_data_mode: "HOLD",
  renotify: { mode: "EVERY", interval_minutes: 30 },
  filters: [{ field: "service", op: "=", value: "checkout" }],
  creator: "arthur@traceroot.ai",
  create_time: "2026-09-01T00:00:00Z",
  update_time: "2026-09-02T00:00:00Z",
  last_error: null,
};

describe("alertsList.resolveArgs (--limit/--page forwarding)", () => {
  it("rejects a non-numeric --limit as a usage error instead of shipping NaN", () => {
    expect(() =>
      alertsList.resolveArgs?.({ opts: { limit: "abc" }, positionals: {}, extras: [] }),
    ).toThrow("--limit must be a positive integer");
  });

  it("forwards a valid --limit as args.limit", () => {
    const resolved = alertsList.resolveArgs?.({
      opts: { limit: "5" },
      positionals: {},
      extras: [],
    });
    expect(resolved?.args).toEqual({ limit: 5 });
  });

  it("omits args.limit when no --limit is given", () => {
    const resolved = alertsList.resolveArgs?.({ opts: {}, positionals: {}, extras: [] });
    expect(resolved?.args).toEqual({});
  });

  it("rejects a non-numeric --page as a usage error instead of shipping NaN", () => {
    expect(() =>
      alertsList.resolveArgs?.({ opts: { page: "abc" }, positionals: {}, extras: [] }),
    ).toThrow("--page must be a non-negative integer");
  });

  it("accepts --page 0 (zero-based paging)", () => {
    const resolved = alertsList.resolveArgs?.({
      opts: { page: "0" },
      positionals: {},
      extras: [],
    });
    expect(resolved?.args).toEqual({ page: 0 });
  });

  it("forwards a later --page as args.page", () => {
    const resolved = alertsList.resolveArgs?.({
      opts: { page: "2" },
      positionals: {},
      extras: [],
    });
    expect(resolved?.args).toEqual({ page: 2 });
  });

  it("rejects a --page beyond the safe-integer range instead of forwarding an imprecise value", () => {
    expect(() =>
      alertsList.resolveArgs?.({
        opts: { page: "99999999999999999999" },
        positionals: {},
        extras: [],
      }),
    ).toThrow("--page must be a non-negative integer");
  });

  it("rejects a --limit beyond the safe-integer range instead of forwarding an imprecise value", () => {
    expect(() =>
      alertsList.resolveArgs?.({
        opts: { limit: "99999999999999999999" },
        positionals: {},
        extras: [],
      }),
    ).toThrow("--limit must be a positive integer");
  });
});

describe("alerts get rendering", () => {
  it("renders the rule, filters and renotify as a key/value block", () => {
    const { writers, out } = makeWriters();
    renderAlertDetail(DETAIL, { json: false, writers, timeZone: "UTC" });
    expect(out.data).toContain("p95 duration_ms > 1500 / 5m");
    expect(out.data).toContain("service = checkout");
    expect(out.data).toContain("every 30m");
    expect(out.data).toContain("alr-1");
  });

  it("says none when there are no filters", () => {
    const { writers, out } = makeWriters();
    renderAlertDetail({ ...DETAIL, filters: [] }, { json: false, writers, timeZone: "UTC" });
    expect(out.data).toContain("Filters:");
    expect(out.data).toContain("none");
  });

  it("omits the creator when it is null", () => {
    const { writers, out } = makeWriters();
    renderAlertDetail({ ...DETAIL, creator: null }, { json: false, writers, timeZone: "UTC" });
    expect(out.data).toContain("Created:");
    expect(out.data).not.toContain(" by ");
  });

  it("renders a renotify interval of null as a bare 'every'", () => {
    const { writers, out } = makeWriters();
    renderAlertDetail(
      { ...DETAIL, renotify: { mode: "EVERY", interval_minutes: null } },
      { json: false, writers, timeZone: "UTC" },
    );
    expect(out.data).toMatch(/Renotify:\s+every\n/);
  });

  it("renders a non-EVERY renotify mode as off", () => {
    const { writers, out } = makeWriters();
    renderAlertDetail(
      { ...DETAIL, renotify: { mode: "OFF" } },
      { json: false, writers, timeZone: "UTC" },
    );
    expect(out.data).toMatch(/Renotify:\s+off\n/);
  });

  it("shows 'never' for an alert that has not been evaluated", () => {
    const { writers, out } = makeWriters();
    renderAlertDetail(
      { ...DETAIL, last_evaluated_at: null },
      { json: false, writers, timeZone: "UTC" },
    );
    expect(out.data).toMatch(/Last eval:\s+never\n/);
  });

  it("only prints a Last error line when there is one", () => {
    const a = makeWriters();
    renderAlertDetail(DETAIL, { json: false, writers: a.writers, timeZone: "UTC" });
    expect(a.out.data).not.toContain("Last error:");

    const b = makeWriters();
    renderAlertDetail(
      { ...DETAIL, last_error: "query timed out" },
      { json: false, writers: b.writers, timeZone: "UTC" },
    );
    expect(b.out.data).toContain("Last error:");
    expect(b.out.data).toContain("query timed out");
  });
});
