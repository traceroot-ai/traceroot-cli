import { describe, expect, it } from "vitest";
import type { SignalList } from "../../../src/api/client.js";
import { buildProgram } from "../../../src/cli.js";
import { renderSignalsList, scopeLabel } from "../../../src/registry/enhancers/signals-list.js";
import { createFakeFetch, jsonResponse } from "../../helpers/fakeFetch.js";
import { withoutForcedColor } from "../../helpers/plainColor.js";
import { StringSink } from "../../helpers/stringSink.js";

withoutForcedColor();

function sinks() {
  const out = new StringSink();
  const err = new StringSink();
  return { w: { out, err }, out, err };
}

type Signal = SignalList["data"][number];

function signal(over: Partial<Signal> = {}): Signal {
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
    ...over,
  };
}

function list(data: Signal[], meta: Partial<SignalList["meta"]> = {}): SignalList {
  return { data, meta: { limit: 50, page: 0, total: data.length, ...meta } };
}

describe("signals list rendering", () => {
  it("shows id, status, hits, last seen, detector and title, then how many", () => {
    const { w, out, err } = sinks();
    renderSignalsList(list([signal()]), {}, w, "UTC");
    const [header, row] = out.data.split("\n");
    expect(header?.split(/\s{2,}/)).toEqual([
      "SIGNAL ID",
      "STATUS",
      "HITS",
      "LAST SEEN",
      "DETECTOR",
      "TITLE",
    ]);
    expect(row).toContain("sig_7f3a");
    expect(row).toContain("open");
    expect(row).toContain("42");
    expect(row).toContain("2026-11-10 09:30:00 UTC");
    expect(row).toContain("empty-tool-result");
    expect(row).toContain("Tool call returns an empty result");
    expect(err.data).toBe("1 signal(s) | limit 50 | all signals\n");
  });

  it("names the detector by id when the detector has no name", () => {
    const { w, out } = sinks();
    renderSignalsList(list([signal({ detector_name: null })]), {}, w, "UTC");
    expect(out.data).toContain("det_91c2");
  });

  it("says when the page is not every signal", () => {
    const { w, err } = sinks();
    renderSignalsList(list([signal()], { total: 120 }), {}, w, "UTC");
    expect(err.data).toContain("1 of 120 signal(s)");
  });

  it("an empty page still says what it was drawn from", () => {
    const { w, out, err } = sinks();
    renderSignalsList(list([]), { status: "open" }, w, "UTC");
    expect(out.data).toContain("SIGNAL ID");
    expect(err.data).toBe("0 signal(s) | limit 50 | open signals\n");
  });

  it("escapes control characters in server text instead of sending them to the terminal", () => {
    const hostile = "\u001b[2J\u001b]0;pwned\u0007x";
    const { w, out } = sinks();
    renderSignalsList(list([signal({ title: hostile, detector_name: hostile })]), {}, w, "UTC");
    expect(out.data).not.toContain("\u001b");
    expect(out.data).not.toContain("\u0007");
    expect(out.data).toContain("\\u001b[2J");
  });
});

describe("scopeLabel", () => {
  it("names the filters and the page", () => {
    expect(scopeLabel({})).toBe("all signals");
    expect(scopeLabel({ status: "resolved" })).toBe("resolved signals");
    expect(scopeLabel({ status: "open", detectorId: "det_1", page: 2 })).toBe(
      "open signals of detector det_1, page 2",
    );
  });
});

describe("signals list command", () => {
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
    return { fake, out, err, run, program };
  }

  function help(): string {
    const { program } = harness({});
    const cmd = program.commands
      .find((c) => c.name() === "signals")
      ?.commands.find((c) => c.name() === "list");
    // Commander wraps help at the terminal width; one line reads the same anywhere.
    return (cmd?.helpInformation() ?? "").replace(/\s+/g, " ");
  }

  it("sends no filter by default", async () => {
    const h = harness(list([signal()]));
    await h.run("signals", "list");
    expect(h.fake.calls[0]?.url).toBe("https://api.test/api/v1/public/signals");
  });

  it("sends --status, --detector-id, --limit and --page", async () => {
    const h = harness(list([]));
    await h.run(
      "signals",
      "list",
      "--status",
      "open",
      "--detector-id",
      "det_91c2",
      "--limit",
      "10",
      "--page",
      "2",
    );
    const url = new URL(h.fake.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/public/signals");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "open",
      detector_id: "det_91c2",
      limit: "10",
      page: "2",
    });
  });

  it("sends --page 0, the first page", async () => {
    const h = harness(list([]));
    await h.run("signals", "list", "--page", "0");
    expect(new URL(h.fake.calls[0]?.url ?? "").searchParams.get("page")).toBe("0");
  });

  it("rejects --limit outside 1-200 before any request", async () => {
    for (const value of ["0", "201", "ten"]) {
      const h = harness(list([]));
      await expect(h.run("signals", "list", "--limit", value)).rejects.toThrow(
        /--limit must be (a positive integer|at most 200)/,
      );
      expect(h.fake.calls).toHaveLength(0);
    }
  });

  it("rejects a --page that is not a non-negative integer before any request", async () => {
    for (const value of ["-1", "1.5", "two"]) {
      const h = harness(list([]));
      await expect(h.run("signals", "list", `--page=${value}`)).rejects.toThrow(
        "--page must be a non-negative integer",
      );
      expect(h.fake.calls).toHaveLength(0);
    }
  });

  it("rejects a status the contract does not define before any request", async () => {
    const h = harness(list([]));
    await expect(h.run("signals", "list", "--status", "closed")).rejects.toThrow(
      "--status must be one of: open, resolved, dismissed",
    );
    expect(h.fake.calls).toHaveLength(0);
  });

  it("takes a detector by id only: there is no --detector for names", async () => {
    const h = harness(list([]));
    await expect(h.run("signals", "list", "--detector", "empty-tool-result")).rejects.toThrow(
      /unknown option '--detector'/,
    );
    expect(h.fake.calls).toHaveLength(0);
  });

  it("--json is the response plus count, as the other list commands emit", async () => {
    const payload = list([signal()], { total: 120 });
    const h = harness(payload);
    await h.run("signals", "list", "--json");
    expect(JSON.parse(h.out.data)).toEqual({ ...payload, count: 1 });
    expect(h.err.data).toBe("");
  });

  it("its help says the order, the bounds and where a detector id comes from", () => {
    const text = help();
    expect(text).toContain("newest created first");
    expect(text).toContain("1-200 (default 50)");
    expect(text).toContain("zero-based page");
    expect(text).toContain("open, resolved, dismissed");
    expect(text).toContain("'detectors list'");
    expect(text).not.toContain("--project-id");
  });
});
