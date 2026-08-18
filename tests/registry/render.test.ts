import { describe, expect, it } from "vitest";
import { renderDefault } from "../../src/registry/render.js";
import { StringSink } from "../helpers/stringSink.js";

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
    expect(w.err.data).toBe("2 of 7 item(s) | limit 50\n");
  });

  it("renders an empty list as just the footer", () => {
    const w = writers();
    renderDefault(
      { data: [], meta: { page: 1, limit: 50, total: 0 } },
      { json: false, writers: w.writers, args: {} },
    );
    expect(w.out.data).toBe("");
    expect(w.err.data).toBe("0 item(s) | limit 50\n");
  });

  it("renders object payloads as an aligned key/value block", () => {
    const w = writers();
    renderDefault(
      { session_id: "s-1", trace_count: 2, traces: [{ trace_id: "t-1" }] },
      { json: false, writers: w.writers, args: {} },
    );
    expect(w.out.data).toBe(
      'Session id:   s-1\nTrace count:  2\nTraces:       [{"trace_id":"t-1"}]\n',
    );
  });
});
