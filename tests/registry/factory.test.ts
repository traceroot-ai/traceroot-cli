import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli.js";
import { CliError, ExitCode } from "../../src/output.js";
import { createFakeFetch, errorResponse, jsonResponse } from "../helpers/fakeFetch.js";
import { StringSink } from "../helpers/stringSink.js";

function harness(response: Response) {
  const fake = createFakeFetch(() => response);
  const out = new StringSink();
  const err = new StringSink();
  const program = buildProgram({
    registry: { fetchImpl: fake.fetchImpl, writers: { out, err } },
  });
  const run = (...argv: string[]) =>
    program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], { from: "user" });
  return { fake, out, err, run, program };
}

function findCommand(program: Command, group: string, name: string): Command {
  const parent = program.commands.find((c) => c.name() === group);
  const cmd = parent?.commands.find((c) => c.name() === name);
  if (cmd === undefined) throw new Error(`${group} ${name} not registered`);
  return cmd;
}

describe("generated sessions commands (zero-code path)", () => {
  it("registers sessions list/get and traces filter-values with schema-derived flags", () => {
    const program = buildProgram();
    const list = findCommand(program, "sessions", "list");
    expect(list.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--limit", "--search-query", "--start-after", "--end-before"]),
    );
    const get = findCommand(program, "sessions", "get");
    expect(get.registeredArguments.map((a) => a.name())).toEqual(["session-id"]);
    findCommand(program, "traces", "filter-values");
  });

  it("sessions list --json emits the raw response and passes schema args as query params", async () => {
    const payload = { data: [{ session_id: "s-1" }], meta: { page: 1, limit: 50, total: 1 } };
    const h = harness(jsonResponse(payload));
    await h.run("sessions", "list", "--json", "--limit", "5", "--search-query", "abc");
    expect(h.fake.calls[0].url).toBe(
      "https://api.test/api/v1/public/sessions?limit=5&search_query=abc",
    );
    expect(JSON.parse(h.out.data)).toEqual(payload);
  });

  it("sessions get fills the path param from the positional", async () => {
    const h = harness(jsonResponse({ session_id: "s-1" }));
    await h.run("sessions", "get", "s-1", "--json");
    expect(h.fake.calls[0].url).toBe("https://api.test/api/v1/public/sessions/s-1");
  });

  it("rejects a blank path-param positional as usage, before any network call", async () => {
    // The registry dispatcher's fillPath throws a plain Error for a blank path
    // param; without a pre-dispatch check, translate() in execute.ts buckets
    // that as a retryable network failure and leaks the path template.
    const h = harness(jsonResponse({ session_id: "s-1" }));
    const err = await h.run("sessions", "get", "").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe("missing required argument 'session-id'");
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect(h.fake.calls.length).toBe(0);
  });

  it("rejects a whitespace-only path-param positional as usage, before any network call", async () => {
    const h = harness(jsonResponse({ session_id: "s-1" }));
    const err = await h.run("sessions", "get", "   ").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect(h.fake.calls.length).toBe(0);
  });

  it("rejects a non-integer --limit before any network call", async () => {
    const h = harness(jsonResponse({ data: [] }));
    const err = await h.run("sessions", "list", "--limit", "abc").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe("--limit must be an integer");
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect(h.fake.calls.length).toBe(0);
  });

  it("rejects a duplicated flag", async () => {
    const h = harness(jsonResponse({ data: [] }));
    const err = await h.run("sessions", "list", "--limit", "1", "--limit", "2").catch((e) => e);
    expect((err as CliError).message).toBe("--limit may only be given once");
  });

  it("rejects stray positional operands", async () => {
    const h = harness(jsonResponse({ data: [] }));
    const err = await h.run("sessions", "list", "extra").catch((e) => e);
    expect((err as CliError).message).toBe("unexpected argument(s): extra");
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
  });

  it("assertKnownArgs rejects args the dispatcher would silently drop", async () => {
    const { REGISTRY } = await import("@traceroot-ai/tools");
    const { assertKnownArgs } = await import("../../src/registry/factory.js");
    const entry = REGISTRY.find((e) => e.name === "list_sessions");
    if (entry === undefined) throw new Error("fixture missing");
    expect(() => assertKnownArgs(entry, { limit: 5 })).not.toThrow();
    expect(() => assertKnownArgs(entry, { bogus: "x" })).toThrow(
      /resolveArgs for 'list_sessions' produced arg 'bogus'/,
    );
    // Inherited Object.prototype keys must not slip through the `in`-style check.
    expect(() => assertKnownArgs(entry, { toString: "x" })).toThrow(/produced arg 'toString'/);
  });

  it("rejects an unparseable date-time flag as a usage error before any network call", async () => {
    const h = harness(jsonResponse({ data: [] }));
    const err = await h.run("sessions", "list", "--start-after", "not-a-date").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe(
      "--start-after must be an ISO 8601 timestamp, e.g. 2026-06-01T13:00:00Z",
    );
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect(h.fake.calls.length).toBe(0);
  });

  it("throws at registration when an enhancer's argument count diverges from the path parameters", async () => {
    const { ENHANCERS } = await import("../../src/registry/enhancers/index.js");
    // `get_session`'s path template has one parameter (session_id); an enhancer
    // that declares zero arguments must be rejected at buildProgram() time,
    // not silently drop the value at runtime.
    ENHANCERS.get_session = { arguments: () => {} };
    try {
      expect(() => buildProgram()).toThrow(
        /enhancer for 'get_session' declares 0 argument\(s\) but the tool's path template has 1 parameter\(s\)/,
      );
    } finally {
      ENHANCERS.get_session = undefined;
    }
  });

  it("enforces the schema's numeric bounds as usage errors before any network call", async () => {
    // list_sessions declares limit with minimum 1 / maximum 200.
    const low = harness(jsonResponse({ data: [] }));
    const lowErr = await low.run("sessions", "list", "--limit", "0").catch((e) => e);
    expect(lowErr).toBeInstanceOf(CliError);
    expect((lowErr as CliError).message).toBe("--limit must be at least 1");
    expect((lowErr as CliError).exitCode).toBe(ExitCode.usage);
    expect(low.fake.calls.length).toBe(0);

    const high = harness(jsonResponse({ data: [] }));
    const highErr = await high.run("sessions", "list", "--limit", "500").catch((e) => e);
    expect((highErr as CliError).message).toBe("--limit must be at most 200");
    expect((highErr as CliError).exitCode).toBe(ExitCode.usage);
    expect(high.fake.calls.length).toBe(0);
  });

  it("dispatchToolOptional throws synchronously on an invalid companion instead of resolving null", async () => {
    const { ENHANCERS } = await import("../../src/registry/enhancers/index.js");
    // A render that (buggily) chains .catch onto an invalid companion dispatch:
    // the factory's validation must throw before any promise exists, so the
    // bug surfaces instead of degrading to silent missing output.
    ENHANCERS.get_session = {
      render: async (_payload, ctx) => {
        await ctx.dispatchToolOptional("get_finding_by_trace", {}).catch(() => null);
      },
    };
    try {
      const h = harness(jsonResponse({ session_id: "s-1" }));
      const err = await h.run("sessions", "get", "s-1").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        /'get_finding_by_trace' is not a companion of 'get_session'/,
      );
    } finally {
      ENHANCERS.get_session = undefined;
    }
  });

  it("dispatchToolOptional rejects a blank companion path param instead of resolving null", async () => {
    const { ENHANCERS } = await import("../../src/registry/enhancers/index.js");
    const original = ENHANCERS.get_finding;
    // A valid companion pair (get_finding → get_finding_by_trace) but a blank
    // path param: assertPathParamsPresent must throw synchronously, escaping
    // the render's own .catch, instead of the dispatcher's raw error being
    // swallowed into a silent null.
    ENHANCERS.get_finding = {
      render: async (_payload, ctx) => {
        await ctx.dispatchToolOptional("get_finding_by_trace", { trace_id: "" }).catch(() => null);
      },
    };
    try {
      const h = harness(jsonResponse({ finding_id: "fnd-1" }));
      const err = await h.run("findings", "get", "fnd-1").catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toBe("missing required argument 'trace-id'");
      expect((err as CliError).exitCode).toBe(ExitCode.usage);
    } finally {
      ENHANCERS.get_finding = original;
    }
  });

  it("rejectExtras throws the exact stray-operand message and is a no-op on empty extras", async () => {
    const { rejectExtras } = await import("../../src/registry/factory.js");
    expect(() => rejectExtras({ opts: {}, positionals: {}, extras: [] })).not.toThrow();
    let err: unknown;
    try {
      rejectExtras({ opts: {}, positionals: {}, extras: ["extra"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe("unexpected argument(s): extra");
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
  });

  it("requireCompanion resolves a valid companion pair and throws for an invalid owner", async () => {
    const { requireCompanion } = await import("../../src/registry/factory.js");
    const companion = requireCompanion("get_finding", "get_finding_by_trace");
    expect(companion.name).toBe("get_finding_by_trace");
    expect(() => requireCompanion("get_session", "get_finding_by_trace")).toThrow(
      /'get_finding_by_trace' is not a companion of 'get_session'/,
    );
  });

  it("sessions list without --json renders the standard table and count footer", async () => {
    const payload = { data: [{ session_id: "s-1" }], meta: { page: 1, limit: 50, total: 1 } };
    const h = harness(jsonResponse(payload));
    await h.run("sessions", "list");
    expect(h.out.data).toContain("SESSION ID");
    expect(h.err.data).toBe("1 item(s) | limit 50\n");
  });
});

describe("traces list (enhancer path)", () => {
  it("a failed list_traces dispatch never reaches render: nothing is written", async () => {
    // registerOne awaits executeTool before calling enhancer.render (see
    // src/registry/factory.ts) — a rejected dispatch must never let renderList
    // print a table or footer.
    const h = harness(errorResponse(500, "boom"));

    const err = await h.run("traces", "list").catch((e) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.internal);
    expect(h.out.data).toBe("");
    expect(h.err.data).toBe("");
    expect(h.fake.calls.length).toBe(1);
  });
});

describe("traces get (enhancer path)", () => {
  it("a failed get_trace dispatch never reaches render: nothing is written and the finding lookup never runs", async () => {
    // registerOne awaits executeTool before calling enhancer.render (see
    // src/registry/factory.ts) — a rejected dispatch must never let runGet's
    // rendering (or its best-effort finding lookup) run.
    const h = harness(errorResponse(404, "trace not found"));

    const err = await h.run("traces", "get", "missing-trace").catch((e) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.notFound);
    expect((err as CliError).message).toBe("trace not found");
    expect(h.out.data).toBe("");
    // Only the failed get_trace dispatch happened — the best-effort finding
    // lookup (a companion dispatch inside render) never ran.
    expect(h.fake.calls.length).toBe(1);
  });
});

describe("findings get (enhancer path)", () => {
  it("dispatches get_finding for a finding id", async () => {
    const h = harness(jsonResponse({ finding_id: "fnd-1" }));
    await h.run("findings", "get", "fnd-1", "--json");
    expect(h.fake.calls[0].url).toBe("https://api.test/api/v1/public/detectors/findings/fnd-1");
  });

  it("retargets to get_finding_by_trace for --trace", async () => {
    const h = harness(jsonResponse({ finding_id: "fnd-1", trace_id: "tr-9" }));
    await h.run("findings", "get", "--trace", "tr-9", "--json");
    expect(h.fake.calls[0].url).toBe(
      "https://api.test/api/v1/public/detectors/traces/tr-9/finding",
    );
  });

  it("a failed dispatch never reaches render: nothing is written", async () => {
    const h = harness(errorResponse(404, "finding not found"));
    const err = await h.run("findings", "get", "fnd-missing").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.notFound);
    expect(h.out.data).toBe("");
    expect(h.fake.calls.length).toBe(1);
  });

  it("a blank finding id AND blank --trace keep findings-get's own validation message, not the generic path-param check", async () => {
    // findings-get's resolveArgs normalizes blanks to "not provided" and throws
    // its own usage error before the factory's generic path-param check ever
    // sees an arg — verify that precedence still holds.
    const h = harness(jsonResponse({ finding_id: "fnd-1" }));
    const err = await h.run("findings", "get", "", "--trace", "").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe("provide a finding id, or --trace <trace-id>");
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect(h.fake.calls.length).toBe(0);
  });
});

describe("traces export (enhancer path)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tr-factory-export-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("a failed export_trace dispatch never reaches render: no bundle directory is created", async () => {
    // registerOne awaits executeTool before calling enhancer.render (see
    // src/registry/factory.ts) — a rejected dispatch must never let runExport's
    // mkdirSync run. --output points at a path inside a fresh temp dir so the
    // existsSync check below is deterministic without relying on cwd.
    const h = harness(errorResponse(404, "trace not found"));
    const outputDir = join(tmpRoot, "bundle");

    const err = await h
      .run("traces", "export", "missing-trace", "--output", outputDir)
      .catch((e) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.notFound);
    expect((err as CliError).message).toBe("trace not found");
    expect(existsSync(outputDir)).toBe(false);
    // Only the failed export_trace dispatch happened — the best-effort finding
    // lookup (a companion dispatch inside render) never ran.
    expect(h.fake.calls.length).toBe(1);
  });
});
