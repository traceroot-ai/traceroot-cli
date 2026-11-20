import { describe, expect, it } from "vitest";
import { renderDefault } from "../../src/registry/render.js";
import { withoutForcedColor } from "../helpers/plainColor.js";
import { StringSink } from "../helpers/stringSink.js";

withoutForcedColor();

function writers() {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

describe("renderDefault", () => {
  it("--json emits the raw payload untouched", () => {
    const w = writers();
    const payload = { data: [{ a: 1 }], meta: { limit: 50, total: 1, page: 1 } };
    renderDefault(payload, { json: true, writers: w.writers, args: {} });
    expect(JSON.parse(w.out.data)).toEqual(payload);
    expect(w.err.data).toBe("");
  });

  it("renders list payloads as the standard table with a count footer", () => {
    const w = writers();
    renderDefault(
      {
        data: [
          { session_id: "s-1", trace_count: 3, duration_ms: null },
          { session_id: "s-2", trace_count: 1, duration_ms: 40 },
        ],
        meta: { page: 1, limit: 50, total: 7 },
      },
      { json: false, writers: w.writers, args: {} },
    );
    const [header, row1, row2] = w.out.data.split("\n");
    expect(header).toBe("SESSION ID  TRACE COUNT  DURATION MS");
    expect(row1).toBe("s-1         3");
    expect(row2).toBe("s-2         1            40");
    expect(w.err.data).toBe("2 of 7 items | limit 50\n");
  });

  it("agrees the footer's noun with the total, not the page, when a total is shown", () => {
    const w = writers();
    renderDefault(
      { data: [{ id: "a" }], meta: { page: 1, limit: 1, total: 7 } },
      { json: false, writers: w.writers, args: {} },
    );
    expect(w.err.data).toBe("1 of 7 items | limit 1\n");
  });

  it("renders an empty list as just the footer", () => {
    const w = writers();
    renderDefault(
      { data: [], meta: { page: 1, limit: 50, total: 0 } },
      { json: false, writers: w.writers, args: {} },
    );
    expect(w.out.data).toBe("");
    expect(w.err.data).toBe("0 items | limit 50\n");
  });

  it("renders object payloads as an aligned key/value block", () => {
    const w = writers();
    renderDefault(
      { session_id: "s-1", trace_count: 2, traces: [{ trace_id: "t-1" }] },
      { json: false, writers: w.writers, args: {} },
    );
    expect(w.out.data).toBe(
      'Session ID:   s-1\nTrace count:  2\nTraces:       [{"trace_id":"t-1"}]\n',
    );
  });

  it("names ids and times as the curated commands do, and shows a missing value as a dash", () => {
    const w = writers();
    renderDefault(
      {
        detector_id: "d-1",
        run_ids: ["r-1"],
        updated_at: "2026-11-17T00:00:00Z",
        trigger_conditions: null,
      },
      { json: false, writers: w.writers, args: {} },
    );
    expect(w.out.data).toBe(
      'Detector ID:         d-1\nRun IDs:             ["r-1"]\nUpdated:             2026-11-17T00:00:00Z\nTrigger conditions:  —\n',
    );
  });

  it("names a record's own id for its tool, and the API's create and update times as Created and Updated", () => {
    const w = writers();
    renderDefault(
      { id: "d-1", create_time: "2026-11-01T00:00:00Z", update_time: "2026-11-02T00:00:00Z" },
      { json: false, writers: w.writers, args: {}, tool: "get_dashboard" },
    );
    expect(w.out.data).toBe(
      "Dashboard ID:  d-1\nCreated:       2026-11-01T00:00:00Z\nUpdated:       2026-11-02T00:00:00Z\n",
    );
  });

  it("keeps a bare ID when the tool is not known", () => {
    const w = writers();
    renderDefault({ id: "d-1" }, { json: false, writers: w.writers, args: {} });
    expect(w.out.data).toBe("ID:  d-1\n");
  });

  it("shows an empty string as a dash and an empty list as (none), and writes RCA in capitals", () => {
    const w = writers();
    renderDefault(
      { description: "", widgets: [], enable_rca: false },
      { json: false, writers: w.writers, args: {} },
    );
    expect(w.out.data).toBe("Description:  —\nWidgets:      (none)\nEnable RCA:   false\n");
  });

  it("derives columns from the union of all rows, not just row 0", () => {
    const w = writers();
    renderDefault(
      {
        data: [{ id: "a" }, { id: "b", extra: "only-on-row-1" }],
        meta: { page: 1, limit: 50, total: 2 },
      },
      { json: false, writers: w.writers, args: {} },
    );
    const [header, row1, row2] = w.out.data.split("\n");
    expect(header).toBe("ID  EXTRA");
    expect(row1).toBe("a");
    expect(row2).toBe("b   only-on-row-1");
  });

  it("does not table-render a data array of non-object items", () => {
    const w = writers();
    renderDefault({ data: ["a", "b"] }, { json: false, writers: w.writers, args: {} });
    // Falls through to the key/value renderer instead of fabricating
    // per-character index columns.
    expect(w.out.data).toBe('Data:  ["a","b"]\n');
    expect(w.err.data).toBe("");
  });
});
