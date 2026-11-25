import { describe, expect, it, vi } from "vitest";
import type { DashboardDetail } from "../../../src/api/client.js";
import { buildProgram } from "../../../src/cli.js";
import {
  renderDashboard,
  widgetDisplay,
  widgetQuery,
} from "../../../src/registry/enhancers/dashboards-get.js";
import { createFakeFetch, jsonResponse } from "../../helpers/fakeFetch.js";
import { withoutForcedColor } from "../../helpers/plainColor.js";
import { StringSink } from "../../helpers/stringSink.js";

withoutForcedColor();

function sinks() {
  const out = new StringSink();
  const err = new StringSink();
  return { w: { out, err }, out, err };
}

const CREATED = "2026-11-17T02:44:22.118000Z";

type WidgetItem = DashboardDetail["widgets"][number];

function widget(i: number, title: string, type: string, spec: unknown): WidgetItem {
  return { id: `seed-${i}-p-1`, title, type, spec, create_time: CREATED };
}

function query(view: string, agg: string, measure: string, display: string, extra = {}) {
  return {
    view,
    metric: { agg, measure },
    display: { type: display },
    filters: [],
    breakdown: null,
    ...extra,
  };
}

const LLM_ONLY = {
  filters: [{ op: "in", field: "span_kind", value: ["LLM", "DECISION"] }],
  breakdown: "model_name",
};

/** The default dashboard every project is created with, as the API returns it. */
function dashboard(over: Partial<DashboardDetail> = {}): DashboardDetail {
  const widgets = [
    widget(0, "Trace count", "query", query("traces", "count", "count", "number")),
    widget(1, "Total cost", "query", query("traces", "sum", "cost", "number")),
    widget(2, "Tokens", "query", query("traces", "sum", "total_tokens", "number")),
    widget(3, "p95 latency", "query", query("traces", "p95", "duration_ms", "number")),
    widget(
      4,
      "Cost over time · by model",
      "query",
      query("spans", "sum", "cost", "line", LLM_ONLY),
    ),
    widget(5, "Tokens by model", "query", query("spans", "sum", "total_tokens", "bar", LLM_ONLY)),
    widget(6, "Recent traces", "trace_feed", { limit: 10, filters: [] }),
    widget(7, "Recent failures", "trace_feed", {
      limit: 10,
      filters: [{ op: "gt", field: "errors", value: 0 }],
    }),
  ];
  return {
    id: "default_p-1",
    name: "Default",
    description: "Auto-created overview of traces, cost, tokens, and latency.",
    is_default: true,
    creator: "Ada Park",
    create_time: CREATED,
    update_time: CREATED,
    widgets,
    layout: widgets.map((w, i) => ({ i: w.id, x: (i % 4) * 3, y: 0, w: 3, h: 2 })),
    ...over,
  };
}

const EMPTY_FIELDS = [
  "Dashboard ID:  cmhx1a2b3c4d5e6f7g8h9i0jk",
  "Name:          Empty",
  "Description:   —",
  "Default:       no",
  "Created:       2026-11-17 02:44:22 UTC",
  "Updated:       2026-11-17 02:44:22 UTC",
  "",
].join("\n");

function emptyDashboard(over: Partial<DashboardDetail> = {}): DashboardDetail {
  return dashboard({
    id: "cmhx1a2b3c4d5e6f7g8h9i0jk",
    name: "Empty",
    description: null,
    is_default: false,
    creator: null,
    widgets: [],
    layout: [],
    ...over,
  });
}

describe("dashboards get rendering", () => {
  it("shows the dashboard, then one row per widget, then what to run next", () => {
    const { w, out, err } = sinks();
    renderDashboard(dashboard(), w, "UTC");
    // No grid position is printed: the layout is for the web page.
    expect(out.data).toBe(
      [
        "Dashboard ID:  default_p-1",
        "Name:          Default",
        "Description:   Auto-created overview of traces, cost, tokens, and latency.",
        "Default:       yes",
        "Created:       2026-11-17 02:44:22 UTC by Ada Park",
        "Updated:       2026-11-17 02:44:22 UTC",
        "",
        "8 widgets",
        "TITLE                      DISPLAY     QUERY                                              WIDGET ID",
        "Trace count                number      count of traces                                    seed-0-p-1",
        "Total cost                 number      sum cost of traces                                 seed-1-p-1",
        "Tokens                     number      sum total_tokens of traces                         seed-2-p-1",
        "p95 latency                number      p95 duration_ms of traces                          seed-3-p-1",
        "Cost over time · by model  line        sum cost of spans by model_name, 1 filter          seed-4-p-1",
        "Tokens by model            bar         sum total_tokens of spans by model_name, 1 filter  seed-5-p-1",
        "Recent traces              trace_feed  latest 10 traces                                   seed-6-p-1",
        "Recent failures            trace_feed  latest 10 traces, 1 filter                         seed-7-p-1",
        "",
      ].join("\n"),
    );
    expect(err.data).toBe(
      [
        "read one widget, with its full spec:",
        "  traceroot widgets get <widget-id>",
        "grid positions are left out here; --json prints the full response",
        "",
      ].join("\n"),
    );
  });

  it("on a terminal, dims the lead-ins and leaves the command at full contrast", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const out = new StringSink(true);
    const err = new StringSink(true);
    renderDashboard(dashboard(), { out, err }, "UTC");
    expect(err.data).toBe(
      [
        "\u001b[2mread one widget, with its full spec:\u001b[0m",
        "  traceroot widgets get <widget-id>",
        "\u001b[2mgrid positions are left out here; --json prints the full response\u001b[0m",
        "",
      ].join("\n"),
    );
  });

  it("counts a single widget in the singular", () => {
    const { w, out } = sinks();
    renderDashboard(dashboard({ widgets: dashboard().widgets.slice(0, 1) }), w, "UTC");
    expect(out.data).toContain("\n\n1 widget\nTITLE ");
  });

  it("an empty dashboard says so on stderr, with no table and no hints", () => {
    const { w, out, err } = sinks();
    renderDashboard(emptyDashboard(), w, "UTC");
    expect(out.data).toBe(EMPTY_FIELDS);
    expect(err.data).toBe("this dashboard has no widgets\n");
  });

  it("a response without widgets prints the fields alone and says nothing", () => {
    const { widgets: _omitted, ...older } = emptyDashboard();
    const { w, out, err } = sinks();
    renderDashboard(older, w, "UTC");
    expect(out.data).toBe(EMPTY_FIELDS);
    expect(err.data).toBe("");
  });

  it("a widgets value that is not a list prints the fields alone, like a missing one", () => {
    const malformed = { ...emptyDashboard(), widgets: {} } as unknown as Parameters<
      typeof renderDashboard
    >[0];
    const { w, out, err } = sinks();
    renderDashboard(malformed, w, "UTC");
    expect(out.data).toBe(EMPTY_FIELDS);
    expect(err.data).toBe("");
  });

  it("shows a dash for a missing description or default flag, and no creator when none is sent", () => {
    const { is_default: _omitted, ...rest } = dashboard({
      description: null,
      creator: null,
      widgets: [],
    });
    const { w, out } = sinks();
    renderDashboard(rest, w, "UTC");
    expect(out.data).toContain("Description:   —\n");
    expect(out.data).toContain("Default:       —\n");
    expect(out.data).toContain("Created:       2026-11-17 02:44:22 UTC\n");
    expect(out.data).not.toContain(" by ");
  });

  it("escapes control characters in server text instead of sending them to the terminal", () => {
    const hostile = "\u001b[2J\u001b]0;pwned\u0007x";
    const { w, out, err } = sinks();
    renderDashboard(
      dashboard({
        id: hostile,
        name: hostile,
        description: hostile,
        creator: hostile,
        widgets: [
          { id: hostile, title: hostile, type: hostile, spec: {}, create_time: CREATED },
          {
            id: "w-2",
            title: "t",
            type: "query",
            spec: query(hostile, "sum", "cost", hostile),
            create_time: CREATED,
          },
        ],
      }),
      w,
      "UTC",
    );
    for (const text of [out.data, err.data]) {
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u0007");
    }
    expect(out.data).toContain("\\u001b[2J");
  });
});

describe("what a widget charts", () => {
  it("names a count by its view alone", () => {
    expect(widgetQuery({ type: "query", spec: query("traces", "count", "count", "number") })).toBe(
      "count of traces",
    );
  });

  it("names any other metric by its aggregation and measure", () => {
    expect(
      widgetQuery({ type: "query", spec: query("traces", "p95", "duration_ms", "number") }),
    ).toBe("p95 duration_ms of traces");
    expect(
      widgetQuery({ type: "query", spec: query("spans", "uniq", "model_name", "table") }),
    ).toBe("uniq model_name of spans");
  });

  it("names a histogram's measure without its aggregation, which a histogram does not use", () => {
    expect(
      widgetQuery({ type: "query", spec: query("traces", "p95", "duration_ms", "histogram") }),
    ).toBe("distribution of duration_ms of traces");
    const filter = { op: "=", field: "span_kind", value: "LLM" };
    expect(
      widgetQuery({
        type: "query",
        spec: query("spans", "sum", "cost", "histogram", { filters: [filter] }),
      }),
    ).toBe("distribution of cost of spans, 1 filter");
  });

  it("names a breakdown only when there is one", () => {
    const spec = (breakdown: unknown) => query("spans", "sum", "cost", "line", { breakdown });
    expect(widgetQuery({ type: "query", spec: spec("model_name") })).toBe(
      "sum cost of spans by model_name",
    );
    expect(widgetQuery({ type: "query", spec: spec(null) })).toBe("sum cost of spans");
    expect(widgetQuery({ type: "query", spec: spec("") })).toBe("sum cost of spans");
  });

  it("counts filters, and says nothing when there are none", () => {
    const spec = (filters: unknown) => query("spans", "sum", "cost", "line", { filters });
    const filter = { op: "=", field: "span_kind", value: "LLM" };
    expect(widgetQuery({ type: "query", spec: spec([filter]) })).toBe(
      "sum cost of spans, 1 filter",
    );
    expect(widgetQuery({ type: "query", spec: spec([filter, filter]) })).toBe(
      "sum cost of spans, 2 filters",
    );
    expect(widgetQuery({ type: "query", spec: spec([]) })).toBe("sum cost of spans");
    expect(widgetQuery({ type: "query", spec: spec(undefined) })).toBe("sum cost of spans");
    expect(widgetQuery({ type: "query", spec: spec("span_kind = LLM") })).toBe("sum cost of spans");
  });

  it("a trace feed names its limit only when it has one", () => {
    expect(widgetQuery({ type: "trace_feed", spec: { limit: 10, filters: [] } })).toBe(
      "latest 10 traces",
    );
    expect(widgetQuery({ type: "trace_feed", spec: { filters: [] } })).toBe("latest traces");
    expect(widgetDisplay({ type: "trace_feed", spec: { filters: [] } })).toBe("trace_feed");
  });

  it("an unknown widget type shows its type and a dash", () => {
    const legacy = { type: "detector", spec: { detector_id: "det-1" } };
    expect(widgetDisplay(legacy)).toBe("detector");
    expect(widgetQuery(legacy)).toBe("—");
    expect(widgetDisplay({ spec: {} })).toBe("—");
  });

  it("a malformed spec shows a dash rather than throwing", () => {
    for (const spec of [null, undefined, "count of traces", [], { view: "traces" }]) {
      expect(widgetQuery({ type: "query", spec })).toBe("—");
      expect(widgetDisplay({ type: "query", spec })).toBe("—");
    }
    const noDisplay = { view: "traces", metric: { agg: "count", measure: "count" } };
    expect(widgetDisplay({ type: "query", spec: noDisplay })).toBe("—");
    expect(widgetQuery({ type: "query", spec: noDisplay })).toBe("count of traces");
  });
});

describe("dashboards get command", () => {
  function harness(payload: unknown) {
    const fake = createFakeFetch(() => jsonResponse(payload));
    const out = new StringSink();
    const err = new StringSink();
    const program = buildProgram({
      registry: { fetchImpl: fake.fetchImpl, writers: { out, err } },
    });
    const run = (...argv: string[]) =>
      program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], {
        from: "user",
      });
    return { fake, out, err, run };
  }

  it("reads the dashboard by its id", async () => {
    const h = harness(dashboard());
    await h.run("dashboards", "get", "d-1");
    expect(h.fake.calls[0]?.url).toBe("https://api.test/api/v1/public/dashboards/d-1");
    expect(h.fake.calls[0]?.init.method).toBe("GET");
    expect(h.out.data).toContain("\n8 widgets\n");
  });

  it("still takes --project-id and sends it", async () => {
    const h = harness(dashboard());
    await h.run("dashboards", "get", "d-1", "--project-id", "p-9");
    expect(h.fake.calls[0]?.url).toBe(
      "https://api.test/api/v1/public/dashboards/d-1?project_id=p-9",
    );
  });

  it("--json passes the response through unchanged, with nothing on stderr", async () => {
    const payload = dashboard();
    const h = harness(payload);
    await h.run("dashboards", "get", "d-1", "--json");
    expect(h.out.data).toBe(`${JSON.stringify(payload)}\n`);
    expect(h.err.data).toBe("");
  });
});
