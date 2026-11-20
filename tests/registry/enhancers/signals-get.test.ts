import { describe, expect, it, vi } from "vitest";
import type { SignalDetail } from "../../../src/api/client.js";
import { buildProgram } from "../../../src/cli.js";
import { renderSignal } from "../../../src/registry/enhancers/signals-get.js";
import { createFakeFetch, jsonResponse } from "../../helpers/fakeFetch.js";
import { withoutForcedColor } from "../../helpers/plainColor.js";
import { StringSink } from "../../helpers/stringSink.js";

withoutForcedColor();

function sinks() {
  const out = new StringSink();
  const err = new StringSink();
  return { w: { out, err }, out, err };
}

function signal(over: Partial<SignalDetail> = {}): SignalDetail {
  return {
    signal_id: "sig_7f3a",
    title: "Tool call returns an empty result",
    status: "open",
    detector_id: "det_91c2",
    detector_name: "empty-tool-result",
    hit_count: 42,
    reopen_count: 0,
    rca_state: "completed",
    first_seen_at: "2026-11-01T08:00:00Z",
    last_seen_at: "2026-11-10T09:30:00Z",
    created_at: "2026-11-01T08:00:00Z",
    resolved_at: null,
    merged_into_id: null,
    recent_hits: [
      {
        trace_id: "tr_c41d",
        finding_id: "0b1e6a52-3f4d-4c2a-9d8e-7a6b5c4d3e2f",
        trace_start_time: "2026-11-10T09:29:58Z",
      },
      {
        trace_id: "tr_a907",
        finding_id: "5e2f0c9d8b7a46e1a3c2d1f0e9b8a7c6",
        trace_start_time: "2026-11-09T17:04:12Z",
      },
    ],
    ...over,
  };
}

describe("signals get rendering", () => {
  it("shows the signal, then its recent traces, then what to run next", () => {
    const { w, out, err } = sinks();
    renderSignal(signal(), w, "UTC");
    expect(out.data).toBe(
      [
        "Title:        Tool call returns an empty result",
        "Signal ID:    sig_7f3a",
        "Status:       open",
        "Detector:     empty-tool-result",
        "Detector ID:  det_91c2",
        "Hits:         42",
        "First seen:   2026-11-01 08:00:00 UTC",
        "Last seen:    2026-11-10 09:30:00 UTC",
        "Analysis:     completed",
        "",
        "2 recent traces, latest trace start first",
        "TRACE ID  FINDING ID                        TRACE START",
        "tr_c41d   0b1e6a523f4d4c2a9d8e7a6b5c4d3e2f  2026-11-10 09:29:58 UTC",
        "tr_a907   5e2f0c9d8b7a46e1a3c2d1f0e9b8a7c6  2026-11-09 17:04:12 UTC",
        "",
      ].join("\n"),
    );
    // The newest hit, with the finding id in the form `findings get` takes, one
    // command to a line.
    expect(err.data).toBe(
      [
        "open the newest trace and its finding:",
        "  traceroot traces get tr_c41d",
        "  traceroot findings get 0b1e6a523f4d4c2a9d8e7a6b5c4d3e2f",
        "",
      ].join("\n"),
    );
  });

  it("counts a single recent trace in the singular", () => {
    const { w, out } = sinks();
    renderSignal(signal({ recent_hits: signal().recent_hits?.slice(0, 1) }), w, "UTC");
    expect(out.data).toContain("\n1 recent trace, latest trace start first\n");
  });

  it("on a terminal, dims the lead-in and leaves the commands at full contrast", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const out = new StringSink(true);
    const err = new StringSink(true);
    renderSignal(signal(), { out, err }, "UTC");
    expect(err.data).toBe(
      [
        "\u001b[2mopen the newest trace and its finding:\u001b[0m",
        "  traceroot traces get tr_c41d",
        "  traceroot findings get 0b1e6a523f4d4c2a9d8e7a6b5c4d3e2f",
        "",
      ].join("\n"),
    );
  });

  it("shows when a resolved signal was resolved and how often it reopened", () => {
    const { w, out } = sinks();
    renderSignal(
      signal({ status: "resolved", resolved_at: "2026-11-09T10:00:00Z", reopen_count: 2 }),
      w,
      "UTC",
    );
    expect(out.data).toContain("Status:       resolved 2026-11-09 10:00:00 UTC, reopened 2 times");
  });

  it("counts a single reopen in the singular", () => {
    const { w, out } = sinks();
    renderSignal(signal({ reopen_count: 1 }), w, "UTC");
    expect(out.data).toContain("Status:       open, reopened 1 time\n");
  });

  it("shows a dash for a deleted detector's name, keeps its id, and says when no analysis ran", () => {
    const { w, out } = sinks();
    renderSignal(signal({ detector_name: null, rca_state: null }), w, "UTC");
    expect(out.data).toContain("Detector:     —\nDetector ID:  det_91c2\n");
    expect(out.data).toContain("Analysis:     (none)\n");
  });

  it("an empty recent_hits says why no trace is listed, and suggests no trace", () => {
    const { w, out, err } = sinks();
    renderSignal(signal({ recent_hits: [] }), w, "UTC");
    expect(out.data).not.toContain("TRACE ID");
    expect(err.data).toBe(
      "no recent traces are shown: traces older than your plan's retention are left out\n",
    );
  });

  it("a response without recent_hits says nothing about retention", () => {
    const { recent_hits: _omitted, ...older } = signal();
    const { w, out, err } = sinks();
    renderSignal(older, w, "UTC");
    expect(out.data).toContain("Analysis:     completed\n");
    expect(out.data).not.toContain("recent traces");
    expect(err.data).toBe("");
  });

  it("a merged signal points at the signal its findings moved to", () => {
    const { w, out, err } = sinks();
    renderSignal(signal({ merged_into_id: "sig_0d2e", recent_hits: [] }), w, "UTC");
    expect(out.data).toContain("Merged into:  sig_0d2e\n");
    expect(err.data).toContain("\n  traceroot signals get sig_0d2e\n");
  });

  it("a merged signal with no recent traces gives the merged pointer as the only reason", () => {
    const { w, out, err } = sinks();
    renderSignal(signal({ merged_into_id: "sig_0d2e", recent_hits: [] }), w, "UTC");
    expect(out.data).not.toContain("TRACE ID");
    expect(err.data).toBe(
      "this signal was merged; read the one its findings moved to:\n" +
        "  traceroot signals get sig_0d2e\n",
    );
  });

  it("escapes control characters in server text instead of sending them to the terminal", () => {
    const hostile = "\u001b[2J\u001b]0;pwned\u0007x";
    const { w, out, err } = sinks();
    renderSignal(
      signal({
        title: hostile,
        detector_name: hostile,
        rca_state: hostile,
        merged_into_id: hostile,
        recent_hits: [
          { trace_id: hostile, finding_id: hostile, trace_start_time: "2026-11-10T09:29:58Z" },
        ],
      }),
      w,
      "UTC",
    );
    for (const text of [out.data, err.data]) {
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u0007");
      expect(text).toContain("\\u001b[2J");
    }
  });
});

describe("signals get command", () => {
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

  it("reads the signal by its id", async () => {
    const h = harness(signal());
    await h.run("signals", "get", "sig_7f3a");
    expect(h.fake.calls[0]?.url).toBe("https://api.test/api/v1/public/signals/sig_7f3a");
    expect(h.out.data).toContain("sig_7f3a");
  });

  it("takes no --project-id: the project comes from the global --project", async () => {
    const h = harness(signal());
    await expect(h.run("signals", "get", "sig_7f3a", "--project-id", "p")).rejects.toThrow(
      /unknown option '--project-id'/,
    );
    expect(h.fake.calls).toHaveLength(0);
  });

  it("--json passes the response through, with no hint on stderr", async () => {
    const payload = signal();
    const h = harness(payload);
    await h.run("signals", "get", "sig_7f3a", "--json");
    expect(JSON.parse(h.out.data)).toEqual(payload);
    expect(h.err.data).toBe("");
  });
});
