import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli.js";
import { CliError, ExitCode } from "../../src/output.js";
import { assertEnums, assertRequiredArgs, readBodyFile } from "../../src/registry/factory.js";
import type { Placement } from "../../src/registry/naming.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
import { StringSink } from "../helpers/stringSink.js";

const createAlert = REGISTRY.find((e) => e.name === "create_alert");
if (createAlert === undefined) throw new Error("registry fixture missing");

describe("assertRequiredArgs", () => {
  it("rejects a missing required field as a usage error", () => {
    let thrown: unknown;
    try {
      assertRequiredArgs(createAlert, { project_id: "p-1", name: "n" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("view");
  });

  it("accepts a complete set of required fields", () => {
    const args: Record<string, unknown> = {
      project_id: "p-1",
      name: "n",
      view: "SPANS",
      measure: "duration_ms",
      aggregation: "p95",
      window: "5m",
      threshold_operator: ">",
      threshold: 1500,
      renotify: { mode: "OFF" },
    };
    expect(() => assertRequiredArgs(createAlert, args)).not.toThrow();
  });

  it("treats an explicit null the same as a missing field", () => {
    // A --from-file document can carry `null` for a field it never sets
    // (e.g. a template with placeholder nulls); a null must not slip past
    // this validator only to be rejected by the server instead.
    const args: Record<string, unknown> = {
      project_id: "p-1",
      name: null,
      view: "SPANS",
      measure: "duration_ms",
      aggregation: "p95",
      window: "5m",
      threshold_operator: ">",
      threshold: 1500,
      renotify: { mode: "OFF" },
    };
    let thrown: unknown;
    try {
      assertRequiredArgs(createAlert, args);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("name");
  });

  const argsWithoutProjectId: Record<string, unknown> = {
    name: "n",
    view: "SPANS",
    measure: "duration_ms",
    aggregation: "p95",
    window: "5m",
    threshold_operator: ">",
    threshold: 1500,
    renotify: { mode: "OFF" },
  };

  it("still requires --project-id when no default project is configured", () => {
    let thrown: unknown;
    try {
      assertRequiredArgs(createAlert, argsWithoutProjectId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("project-id");
  });

  it("does not require --project-id when the transport carries a default project", () => {
    // withProjectScope (execute.ts) is about to inject transport.projectId
    // before dispatch; demanding the flag here would defeat that injection
    // for every project-tenancy write.
    expect(() =>
      assertRequiredArgs(createAlert, argsWithoutProjectId, { projectId: "p-1" }),
    ).not.toThrow();
  });

  it("hints an api-key user toward --project-id (finding 2): --project never resolves for them", () => {
    // transportFromContext only ever sets transport.projectId for a session
    // credential; an api-key user who reaches for --project is missing the
    // field entirely and needs to be pointed at --project-id instead.
    let thrown: unknown;
    try {
      assertRequiredArgs(createAlert, argsWithoutProjectId, { auth: { kind: "api-key" } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("--project-id");
    expect((thrown as CliError).message).toContain(
      "an API key does not carry --project; pass --project-id or set project_id in --from-file",
    );
  });

  it("omits the api-key hint for a session credential with no default project configured", () => {
    let thrown: unknown;
    try {
      assertRequiredArgs(createAlert, argsWithoutProjectId, { auth: { kind: "token-provider" } });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CliError).message).not.toContain("API key");
  });

  it("omits the api-key hint for a field other than project_id", () => {
    // "name" is missing, not project_id — the hint would be irrelevant noise.
    let thrown: unknown;
    try {
      assertRequiredArgs(
        createAlert,
        { ...argsWithoutProjectId, project_id: "p-1", name: undefined },
        {
          auth: { kind: "api-key" },
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CliError).message).not.toContain("API key");
  });
});

describe("assertEnums", () => {
  it("rejects a value outside the schema enum", () => {
    let thrown: unknown;
    try {
      assertEnums(createAlert, { aggregation: "p95x" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("p95");
  });

  it("accepts a valid enum value", () => {
    expect(() => assertEnums(createAlert, { aggregation: "p95" })).not.toThrow();
  });

  // create_alert's `view` is published as `const: "SPANS"`, not an enum. Before
  // this was honoured, `view: "spans"` reached the server and came back as a
  // rejection — the one field on the write path a typo could get past locally.
  it("treats a schema const as a one-value enum", () => {
    let thrown: unknown;
    try {
      assertEnums(createAlert, { view: "spans" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toBe("--view must be one of: SPANS");
  });

  it("accepts the const value", () => {
    expect(() => assertEnums(createAlert, { view: "SPANS" })).not.toThrow();
  });
});

describe("readBodyFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "tr-body-"));

  it("reads a JSON object from a path", () => {
    const p = join(dir, "rule.json");
    writeFileSync(p, JSON.stringify({ name: "n", threshold: 1500 }));
    expect(readBodyFile(p)).toEqual({ name: "n", threshold: 1500 });
  });

  it("rejects invalid JSON as a usage error", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    let thrown: unknown;
    try {
      readBodyFile(p);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
  });

  it("rejects a non-object JSON document", () => {
    const p = join(dir, "arr.json");
    writeFileSync(p, "[1,2]");
    expect(() => readBodyFile(p)).toThrow(CliError);
  });

  it("rejects an empty file as a usage error", () => {
    const p = join(dir, "empty.json");
    writeFileSync(p, "");
    let thrown: unknown;
    try {
      readBodyFile(p);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
  });

  it("rejects an unreadable path without leaking errno noise", () => {
    let thrown: unknown;
    try {
      readBodyFile(join(dir, "missing.json"));
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CliError).exitCode).toBe(ExitCode.usage);
    expect((thrown as CliError).message).toContain("--from-file");
  });
});

// End-to-end coverage of the --from-file flag through the factory's
// deps.placements/deps.groups test seam: registration, the flag-overrides-file
// precedence rule, a stray body key surfacing as usage (not internal), and the
// merge applying even when an enhancer owns resolveArgs. create_workspace is
// placed `internal` in the real naming.ts (Tasks 3-5 own the conversion), so
// it's re-placed here as a command, test-only — the same pattern factory.test.ts
// uses to re-place the sessions tools.
describe("generic write path (factory registration)", () => {
  const WRITE_FIXTURE_PLACEMENTS: Record<string, Placement> = {
    create_workspace: { kind: "command", path: ["write-fixture", "create-workspace"] },
    list_sessions: { kind: "command", path: ["write-fixture", "list-sessions"] },
  };
  const WRITE_FIXTURE_GROUPS: Record<string, string> = {
    "write-fixture": "Test fixture for the generic write path",
  };
  const dir = mkdtempSync(join(tmpdir(), "tr-write-fixture-"));

  function harness(response: Response) {
    const fake = createFakeFetch(() => response);
    const out = new StringSink();
    const err = new StringSink();
    const program = buildProgram({
      registry: {
        fetchImpl: fake.fetchImpl,
        writers: { out, err },
        placements: WRITE_FIXTURE_PLACEMENTS,
        groups: WRITE_FIXTURE_GROUPS,
      },
    });
    const run = (...argv: string[]) =>
      program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], {
        from: "user",
      });
    return { fake, out, err, run, program };
  }

  it("registers --from-file for a non-GET tool but not a GET tool", () => {
    const h = harness(jsonResponse({}));
    const group = h.program.commands.find((c) => c.name() === "write-fixture");
    const create = group?.commands.find((c) => c.name() === "create-workspace");
    const list = group?.commands.find((c) => c.name() === "list-sessions");
    expect(create?.options.map((o) => o.long)).toContain("--from-file");
    expect(list?.options.map((o) => o.long)).not.toContain("--from-file");
  });

  it("a flag overrides the same field from --from-file", async () => {
    const p = join(dir, "flag-wins.json");
    writeFileSync(p, JSON.stringify({ name: "file-name" }));
    const h = harness(jsonResponse({ id: "ws-1" }));
    await h.run("write-fixture", "create-workspace", "--from-file", p, "--name", "flag-name");
    const body = JSON.parse(String(h.fake.calls[0]?.init.body));
    expect(body.name).toBe("flag-name");
  });

  it("uses the --from-file value when no flag overrides it", async () => {
    const p = join(dir, "file-wins.json");
    writeFileSync(p, JSON.stringify({ name: "file-name" }));
    const h = harness(jsonResponse({ id: "ws-1" }));
    await h.run("write-fixture", "create-workspace", "--from-file", p);
    const body = JSON.parse(String(h.fake.calls[0]?.init.body));
    expect(body.name).toBe("file-name");
  });

  it("a stray key in --from-file is a usage error, not an internal one, and never dispatches", async () => {
    const p = join(dir, "stray-key.json");
    writeFileSync(p, JSON.stringify({ name: "n", bogus: "x" }));
    const h = harness(jsonResponse({ id: "ws-1" }));
    const err = await h.run("write-fixture", "create-workspace", "--from-file", p).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect((err as CliError).message).toContain("bogus");
    expect(h.fake.calls.length).toBe(0);
  });

  it("still merges --from-file when an enhancer owns resolveArgs", async () => {
    const { ENHANCERS } = await import("../../src/registry/enhancers/index.js");
    // An enhancer's resolveArgs has no reason to know about --from-file; the
    // merge must apply in the shared action path regardless of which
    // resolver produced resolved.args, or the flag silently no-ops the
    // moment a write tool gets an enhancer (e.g. Task 3's alert commands).
    ENHANCERS.create_workspace = { resolveArgs: () => ({ args: {} }) };
    try {
      const p = join(dir, "enhancer-merge.json");
      writeFileSync(p, JSON.stringify({ name: "from-file-via-enhancer" }));
      const h = harness(jsonResponse({ id: "ws-1" }));
      await h.run("write-fixture", "create-workspace", "--from-file", p);
      const body = JSON.parse(String(h.fake.calls[0]?.init.body));
      expect(body.name).toBe("from-file-via-enhancer");
    } finally {
      ENHANCERS.create_workspace = undefined;
    }
  });
});

describe("boolean flags (detectors update/create)", () => {
  function harness() {
    const fake = createFakeFetch(() => jsonResponse({ id: "det-1" }));
    const program = buildProgram({
      registry: {
        fetchImpl: fake.fetchImpl,
        writers: { out: new StringSink(), err: new StringSink() },
      },
    });
    const run = (...argv: string[]) =>
      program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], {
        from: "user",
      });
    const body = () => JSON.parse(String(fake.calls[0]?.init.body)) as Record<string, unknown>;
    return { fake, run, body };
  }
  const update = ["detectors", "update", "det-1", "--project-id", "p-1"];

  it.each([
    [["--enabled", "false"], false],
    [["--enabled=false"], false],
    [["--enabled", "FALSE"], false],
    [["--no-enabled"], false],
    [["--enabled", "true"], true],
    [["--enabled"], true],
  ])("%j sends enabled=%s", async (flags, expected) => {
    const h = harness();
    await h.run(...update, ...flags);
    expect(h.body().enabled).toBe(expected);
  });

  it("a bare --enabled before another flag still means true", async () => {
    const h = harness();
    await h.run("detectors", "update", "det-1", "--enabled", "--project-id", "p-1");
    expect(h.body()).toMatchObject({ enabled: true, project_id: "p-1" });
  });

  it("omitting the flag leaves the field out of the body", async () => {
    const h = harness();
    await h.run(...update, "--name", "n");
    expect(h.body()).not.toHaveProperty("enabled");
    expect(h.body()).not.toHaveProperty("enable_rca");
  });

  it("--enable-rca false and --no-enable-rca send enable_rca=false", async () => {
    for (const flags of [["--enable-rca", "false"], ["--no-enable-rca"]]) {
      const h = harness();
      await h.run(...update, ...flags);
      expect(h.body().enable_rca).toBe(false);
    }
  });

  it("a non-boolean value is a usage error and never dispatches", async () => {
    const h = harness();
    const err = await h.run(...update, "--enabled", "nope").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect((err as CliError).message).toContain("--enabled must be true or false, got 'nope'");
    expect(h.fake.calls.length).toBe(0);
  });

  it("a positional swallowed by a leading --enabled fails loudly instead of misrouting", async () => {
    const h = harness();
    const err = await h
      .run("detectors", "update", "--enabled", "det-1", "--project-id", "p-1")
      .catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect((err as CliError).message).toContain("--enabled must be true or false, got 'det-1'");
    expect((err as CliError).message).toContain(
      "put positional arguments first or write --enabled=true",
    );
    expect(h.fake.calls.length).toBe(0);
  });

  it("a flag false overrides --from-file true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tr-bool-"));
    const p = join(dir, "on.json");
    writeFileSync(p, JSON.stringify({ enabled: true }));
    const h = harness();
    await h.run(...update, "--from-file", p, "--enabled", "false");
    expect(h.body().enabled).toBe(false);
  });

  it("create can start a detector paused with RCA off", async () => {
    const h = harness();
    await h.run(
      "detectors",
      "create",
      "--project-id",
      "p-1",
      "--name",
      "t",
      "--template",
      "custom",
      "--prompt",
      "x",
      "--enabled",
      "false",
      "--enable-rca",
      "false",
    );
    expect(h.body()).toMatchObject({ enabled: false, enable_rca: false });
  });
});
