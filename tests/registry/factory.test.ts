import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli.js";
import { CliError, ExitCode } from "../../src/output.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
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
  });
});
