import { describe, expect, it } from "vitest";
import type { Writers } from "../../../src/output.js";
import { renderAlertDetail } from "../../../src/registry/enhancers/alerts-get.js";
import { renderAlertsList } from "../../../src/registry/enhancers/alerts-list.js";
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
});
