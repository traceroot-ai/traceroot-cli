import { describe, expect, it } from "vitest";
import type { DashboardList } from "../../../src/api/client.js";
import { buildProgram } from "../../../src/cli.js";
import { renderDashboardList } from "../../../src/registry/enhancers/dashboards-list.js";
import { renderDefault } from "../../../src/registry/render.js";
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

type Item = DashboardList["data"][number];

/** The default dashboard every project is created with, as the API lists it. */
function defaultDashboard(over: Partial<Item> = {}): Item {
  return {
    id: "default_af4512c1-3c44-4743-91e4-d6117754c0e0",
    name: "Default",
    description: "Auto-created overview of traces, cost, tokens, and latency.",
    is_default: true,
    creator: "Ada Park",
    create_time: CREATED,
    update_time: CREATED,
    widget_count: 8,
    ...over,
  };
}

function otherDashboard(over: Partial<Item> = {}): Item {
  return {
    id: "cmhx1a2b3c4d5e6f7g8h9i0jk",
    name: "Checkout agent latency",
    description: "p95 latency and cost of the checkout agent, by model.",
    is_default: false,
    creator: null,
    create_time: "2026-11-20T15:05:00Z",
    update_time: "2026-11-21T09:30:00Z",
    widget_count: 0,
    ...over,
  };
}

function list(data: Item[]): DashboardList {
  return { data };
}

describe("dashboards list rendering", () => {
  it("shows the default dashboard as one row, in local time with its zone", () => {
    const { w, out, err } = sinks();
    renderDashboardList(list([defaultDashboard()]), w, "America/New_York");
    expect(out.data).toBe(
      [
        "DASHBOARD ID                                  NAME     DEFAULT  WIDGETS  UPDATED",
        "default_af4512c1-3c44-4743-91e4-d6117754c0e0  Default  yes      8        2026-11-16 21:44:22 EST",
        "",
      ].join("\n"),
    );
    expect(err.data).toBe("1 dashboard\n");
  });

  it("shows only the five columns, and counts two dashboards in the plural", () => {
    const { w, out, err } = sinks();
    renderDashboardList(list([defaultDashboard(), otherDashboard()]), w, "UTC");
    expect(out.data).toBe(
      [
        "DASHBOARD ID                                  NAME                    DEFAULT  WIDGETS  UPDATED",
        "default_af4512c1-3c44-4743-91e4-d6117754c0e0  Default                 yes      8        2026-11-17 02:44:22 UTC",
        "cmhx1a2b3c4d5e6f7g8h9i0jk                     Checkout agent latency  no       0        2026-11-21 09:30:00 UTC",
        "",
      ].join("\n"),
    );
    // The description and creator stay in `dashboards get` and --json.
    expect(out.data).not.toContain("Auto-created");
    expect(out.data).not.toContain("Ada Park");
    expect(err.data).toBe("2 dashboards\n");
  });

  it("prints a dash for each value the server left out", () => {
    // No default flag at all, an empty name, and a null count and update time.
    const sparse: Parameters<typeof renderDashboardList>[0] = {
      data: [{ id: "cmhx1a2b3c4d5e6f7g8h9i0jk", name: "", widget_count: null, update_time: null }],
    };
    const { w, out } = sinks();
    renderDashboardList(sparse, w, "UTC");
    expect(out.data).toBe(
      [
        "DASHBOARD ID               NAME  DEFAULT  WIDGETS  UPDATED",
        "cmhx1a2b3c4d5e6f7g8h9i0jk  —     —        —        —",
        "",
      ].join("\n"),
    );
  });

  it("a project with no dashboards prints no table and says so on stderr", () => {
    const { w, out, err } = sinks();
    renderDashboardList(list([]), w, "UTC");
    expect(out.data).toBe("");
    expect(err.data).toBe("no dashboards\n");
  });

  it("escapes control characters in server text instead of sending them to the terminal", () => {
    const hostile = "\u001b[2J\u001b]0;pwned\u0007x";
    const { w, out, err } = sinks();
    renderDashboardList(list([otherDashboard({ id: hostile, name: hostile })]), w, "UTC");
    for (const text of [out.data, err.data]) {
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u0007");
    }
    expect(out.data).toContain("\\u001b[2J");
  });
});

describe("dashboards list command", () => {
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

  it("lists the dashboards as the curated table", async () => {
    const h = harness(list([defaultDashboard()]));
    await h.run("dashboards", "list");
    expect(h.fake.calls[0]?.url).toBe("https://api.test/api/v1/public/dashboards");
    expect(h.fake.calls[0]?.init.method).toBe("GET");
    expect(h.out.data).toMatch(/^DASHBOARD ID {2,}NAME {2,}DEFAULT {2}WIDGETS {2}UPDATED\n/);
    expect(h.out.data).toContain("\ndefault_af4512c1-3c44-4743-91e4-d6117754c0e0  Default  yes  ");
    expect(h.err.data).toBe("1 dashboard\n");
  });

  it("still takes --project-id and sends it", async () => {
    const h = harness(list([defaultDashboard()]));
    await h.run("dashboards", "list", "--project-id", "p-9");
    expect(h.fake.calls[0]?.url).toBe("https://api.test/api/v1/public/dashboards?project_id=p-9");
  });

  it("--json passes the response through byte for byte, as the generic renderer did", async () => {
    const payload = list([defaultDashboard(), otherDashboard()]);
    const h = harness(payload);
    await h.run("dashboards", "list", "--json");
    const generic = sinks();
    renderDefault(payload, { json: true, writers: generic.w, args: {} });
    expect(h.out.data).toBe(`${JSON.stringify(payload)}\n`);
    expect(h.out.data).toBe(generic.out.data);
    expect(h.err.data).toBe("");
  });

  it("--help describes the columns it prints", () => {
    const { program } = harness({});
    const cmd = program.commands
      .find((c) => c.name() === "dashboards")
      ?.commands.find((c) => c.name() === "list");
    // Commander wraps help at the terminal width; one line reads the same anywhere.
    const help = (cmd?.helpInformation() ?? "").replace(/\s+/g, " ");
    expect(help).toContain(
      "List the project's dashboards, default first: each one's dashboard id, its name, " +
        "whether it is the default, its widget count, and when it was last updated.",
    );
    expect(help).toContain("never guess a dashboard id");
    expect(help).not.toContain("creator, widget count, timestamps");
    expect(help).toContain("--project-id <value>");
  });
});
